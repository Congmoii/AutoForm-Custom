import { KEYS, allocate, formId, viewUrl } from "./core.mjs";
import {
  STORE_KEY, SESSION_KEY, createStore, deleteForm, getProfile, getSchedule,
  isOperationLocked, listSchedules, migrateStore, setProfile, setSchedule,
  reconcileQuestionConfig, transitionSession, resolveStatusScreenType, getBadgeInfo, SESSION_STATUS,
  initStepSession, transitionStep, SESSION_LIFECYCLE, SESSION_PHASE
} from "./store.mjs";
import { createScanState, hasUnresolvedSubmit, transitionScan } from "./scan-flow.mjs";
import {
  generateAnswerPlan, serializeAnswerPlan, deserializeAnswerPlan, FORM_PAGE_TYPES,
  STEP_TYPES, verifyFormLedger, canonicalizeQuestionId, LEDGER_QUESTION_STATE
} from "./fill-engine.mjs";
import { trace, maskToken } from "./trace.mjs";
import {
  MANDATORY_ENVELOPE_FIELDS,
  createStepEnvelope,
  cloneEnvelopeWithRevision,
  validateEnvelope,
  areEnvelopesIdentical,
  computePayloadHash,
  extractStepPayload,
  reconstructAckData,
  createStepAckPayload,
  hashSubmitToken,
  createCommitRecord,
  canonicalizeCommitKey,
  matchCommitRecord
} from "./step-protocol.mjs";

export const coordinatorNonce = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `nonce-${Date.now()}`;

export const FEATURE_FLAGS = Object.freeze({
  backgroundStepSchedulerV2: true,
  dropdownAdapterV2: true,
  syntheticPointerSequence: false
});

// A packed extension cannot use chrome.alarms for sub-30-second pacing. Keep the
// persisted alarm as a crash fallback and use a worker timer while it is alive.
const shortStepAlarmTimers = new Map();
const STEP_DELIVERY_STATUSES = new Set(["starting", "running", "resuming", "recovering", "navigating", "submitting"]);
function armShortStepAlarm(name, dueAt) {
  const remaining = Math.max(0, Number(dueAt) - Date.now());
  if (!Number.isFinite(remaining) || remaining >= 30000) return;
  const previous = shortStepAlarmTimers.get(name);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    shortStepAlarmTimers.delete(name);
    void handleBackgroundAlarm({ name }).catch((error) => {
      console.warn("[OUTBOX] Short step timer failed:", error?.message || error);
    });
  }, remaining);
  shortStepAlarmTimers.set(name, timer);
}

export async function handleRestAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string") return false;
  const match = alarm.name.match(/^aks:rest-wake:([^:]+):(\d+)$/);
  if (!match) {
    return false;
  }
  const [, sessId, epochStr] = match;
  const state = await load();
  const session = state.session;
  if (!session || session.id !== sessId) return false;

  // Positive guard: session must be active, running, resting, matching epoch, and deadline passed
  const isActive = session.active === true || (session.active !== false && session.status === "running");
  const isPositivelyEligible =
    isActive &&
    session.status === "running" &&
    session.phase === "resting" &&
    Number(epochStr) === Number(session.runEpoch) &&
    Date.now() >= (session.notBefore || 0);

  if (!isPositivelyEligible) return false;

  // Idempotency: if already transitioning or active response already preparing without notBefore, skip duplicate wake
  if (session.phase === SESSION_PHASE.PREPARING && !session.notBefore) {
    return false;
  }

  delete session.notBefore;
  session.phase = SESSION_PHASE.PREPARING;
  session.status = "running";
  session.active = true;
  await set({ [SESSION_KEY]: session });
  await wake(session);
  return true;
}

export async function handleStepRetryAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string") return false;
  const match = alarm.name.match(/^aks:step-retry:([^:]+):(\d+):([^:]+)$/);
  if (!match) return false;
  const claimedSession = await exclusive(async () => {
    const [, sessId, epochStr, stepId] = match;
    const state = await load();
    const session = state.session;
    if (!session || session.id !== sessId) return false;
    if (Number(epochStr) !== Number(session.runEpoch || 1)) return false;
    if (!STEP_DELIVERY_STATUSES.has(session.status) || !session.active) return false;
    if (!session.outbox || session.outbox.stepId !== stepId) return false;
    if (session.outbox.state !== "pending") return false;

    // Never hold the coordinator lock while waiting for the content script.
    // The content script must acquire that same lock to send its step ACK.
    session.outbox.state = "leased";
    await set({ [SESSION_KEY]: session });
    return session;
  });
  if (!claimedSession) return false;
  try {
    const stepId = claimedSession.outbox.stepId;
    console.log(`[OUTBOX] Retrying delivery for step ${stepId}, attempt ${claimedSession.outbox.attempt}`);
    await deliverOutboxStep(claimedSession, claimedSession.tabId);
    return true;
  } catch (error) {
    console.warn("[OUTBOX] Retry delivery failed:", error?.message || error);
    return false;
  }
}

export async function handleStepReadyAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string") return false;
  const match = alarm.name.match(/^aks:step-ready:([^:]+):(\d+):([^:]+)$/);
  if (!match) return false;
  const claimedSession = await exclusive(async () => {
    const [, sessId, epochStr, stepId] = match;
    const state = await load();
    const session = state.session;
    if (!session || session.id !== sessId) return false;
    if (Number(epochStr) !== Number(session.runEpoch || 1)) return false;
    if (!STEP_DELIVERY_STATUSES.has(session.status) || !session.active) return false;
    if (!session.outbox || session.outbox.stepId !== stepId) return false;
    if (session.outbox.state !== "pending") return false;

    if (Date.now() < (session.outbox.nextAttemptAt || 0)) {
      armShortStepAlarm(alarm.name, session.outbox.nextAttemptAt);
      return false;
    }

    session.outbox.state = "leased";
    await set({ [SESSION_KEY]: session });
    return session;
  });
  if (!claimedSession) return false;
  try {
    console.log(`[BACKGROUND] Step ready alarm fired for ${claimedSession.outbox.stepId}, delivering outbox step`);
    await deliverOutboxStep(claimedSession, claimedSession.tabId);
    return true;
  } catch (error) {
    console.warn("[OUTBOX] Ready delivery failed:", error?.message || error);
    return false;
  }
}

export async function handleStepAckTimeoutAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string") return false;
  const match = alarm.name.match(/^aks:step-ack-timeout:([^:]+):(\d+):([^:]+)$/);
  if (!match) return false;
  const [, sessId, epochStr, stepId] = match;

  return exclusive(async () => {
    const state = await load();
    const session = state.session;
    if (!session || session.id !== sessId) return false;
    if (Number(epochStr) !== Number(session.runEpoch || 1)) return false;
    if (session.status === "paused" || session.status === "cancelled" || !session.active) return false;
    if (!session.outbox || session.outbox.stepId !== stepId) return false;
    if (session.outbox.state === "acked") return false;
    if (Date.now() < (session.outbox.ackDeadline || 0)) {
      console.log(`[OUTBOX] now < ackDeadline for step ${stepId}. Skipping early alarm.`);
      return false;
    }

    console.warn(`[OUTBOX] ACK deadline reached for step ${stepId}, checking recovery policy`);
    const maxAttempts = session.outbox.maxAttempts || 3;
    if ((session.outbox.attempt || 1) >= maxAttempts) {
      console.error(`[OUTBOX] Step ${stepId} exceeded max delivery attempts (${maxAttempts}). Transitioning to needs_intervention.`);
      session.status = "needs_intervention";
      session.active = false;
      session.error = `ACK_TIMEOUT_MAX_ATTEMPTS_EXCEEDED: Step ${stepId} timed out after ${session.outbox.attempt || 1} attempts`;
      if (session.outbox) {
        session.outbox.state = "failed";
      }
      await set({ [SESSION_KEY]: session });
      return true;
    }

    // Refresh lease and re-attempt delivery
    const leaseDuration = 60000;
    const freshLease = Date.now() + leaseDuration;
    session.leaseExpiresAt = freshLease;
    session.outbox.attempt = (session.outbox.attempt || 1) + 1;
    const oldEnv = session.outbox.envelope;
    const payload = session.outbox.stepDispatch?.payload || extractStepPayload(session.outbox.stepDispatch);
    const freshEnvelope = createStepEnvelope({
      sessionId: session.id,
      responseId: oldEnv?.responseId || session.activeResponse?.responseId || "resp-1",
      responseIndex: oldEnv?.responseIndex ?? session.activeResponse?.responseIndex ?? 0,
      runEpoch: session.runEpoch || 1,
      revision: (session.revision || 1) + 1,
      stepId,
      stepType: session.outbox.stepType,
      leaseExpiresAt: freshLease,
      payload
    });
    session.revision = freshEnvelope.revision;
    session.activeEnvelope = freshEnvelope;
    session.outbox.envelope = freshEnvelope;
    session.outbox.stepDispatch = Object.freeze({
      action: "step-dispatch",
      envelope: freshEnvelope,
      payload
    });
    session.outbox.state = "pending";
    session.outbox.nextAttemptAt = Date.now();
    await set({ [SESSION_KEY]: session });
    await deliverOutboxStep(session, session.tabId);
    return true;
  });
}

export async function handleBackgroundAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string") return false;
  if (alarm.name.startsWith("aks:rest-wake:")) {
    return handleRestAlarm(alarm);
  }
  if (alarm.name.startsWith("aks:step-retry:")) {
    return handleStepRetryAlarm(alarm);
  }
  if (alarm.name.startsWith("aks:step-ready:")) {
    return handleStepReadyAlarm(alarm);
  }
  if (alarm.name.startsWith("aks:step-ack-timeout:")) {
    return handleStepAckTimeoutAlarm(alarm);
  }
  return false;
}

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(handleBackgroundAlarm);
}

let cachedFingerprints = null;
export async function getFingerprintData() {
  if (cachedFingerprints) return cachedFingerprints;
  try {
    const mod = await import("./build-fingerprint.json", { with: { type: "json" } });
    cachedFingerprints = mod.default?.hashes || mod.default;
    return cachedFingerprints;
  } catch (err) {
    console.warn("[FINGERPRINT] Unable to load build-fingerprint.json:", err?.message || err);
  }
  return { status: "UNAVAILABLE" };
}

export function updateExtensionBadge(session) {
  if (typeof chrome === "undefined" || !chrome.action?.setBadgeText) return;
  const badge = getBadgeInfo(session);
  chrome.action.setBadgeText({ text: badge.text || "" });
  if (badge.color && chrome.action?.setBadgeBackgroundColor) {
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  }
}

if (typeof self !== "undefined") {
  self.dumpTrace = async () => {
    const res = await chrome.storage.local.get("aksRuntimeTrace");
    console.table(res.aksRuntimeTrace || []);
    return res.aksRuntimeTrace || [];
  };
  self.clearTrace = async () => {
    await chrome.storage.local.remove("aksRuntimeTrace");
    console.log("[AKS:TRACE] aksRuntimeTrace cleared.");
  };
}

const ALARM = { schedule: "aks-schedule", watchdog: "aks-watchdog" };
const HEARTBEAT_THRESHOLD_MS = 90000;

export const BUSY_SESSION_STATUSES = new Set([
  "starting", "running", "recovering", "paused", "submitting", "confirming", "navigating", "unresolved"
]);

export const BUSY_SCAN_STATUSES = new Set([
  "parsing", "manual", "filling", "submitting", "confirming", "scanning", "awaiting_manual"
]);

export function calcMaxHeartbeatAge(session) {
  if (session?.restMode === "random" && session?.restMax) {
    return Math.max(HEARTBEAT_THRESHOLD_MS, Number(session.restMax) * 1000 + 45000);
  }
  return HEARTBEAT_THRESHOLD_MS;
}

export function isSessionBusy(session) {
  if (!session || typeof session !== "object") return false;
  if (session.attemptToken || session.pendingAttempt?.token) return true;
  if (["completed", "cancelled", "error", "failed", "stale"].includes(session.status)) return false;
  if (session.active === false && !BUSY_SESSION_STATUSES.has(session.status)) return false;
  const age = Date.now() - (session.heartbeatAt || session.createdAt || Date.now());
  const maxAge = calcMaxHeartbeatAge(session);
  if (age > maxAge && session.status !== "unresolved") return false;
  return BUSY_SESSION_STATUSES.has(session.status);
}

export function isScanBusy(scan) {
  if (!scan || typeof scan !== "object") return false;
  if (["complete", "completed", "error", "cancelled", "failed"].includes(scan.status)) return false;
  if (scan.active === false && !BUSY_SCAN_STATUSES.has(scan.status)) return false;
  const age = Date.now() - (scan.updatedAt || scan.startedAt || 0);
  if (age > HEARTBEAT_THRESHOLD_MS) return false;
  return BUSY_SCAN_STATUSES.has(scan.status) || scan.active === true;
}

export function getActiveLock(state) {
  if (state?.scan && isScanBusy(state.scan)) {
    return {
      type: "scan",
      ownerType: "scanner",
      ownerId: state.scan.id,
      formId: state.scan.formId,
      status: state.scan.status,
      createdAt: state.scan.startedAt || state.scan.createdAt,
      heartbeatAt: state.scan.updatedAt
    };
  }
  if (state?.session && isSessionBusy(state.session)) {
    return {
      type: "session",
      ownerType: "runner",
      ownerId: state.session.id,
      formId: state.session.formId,
      status: state.session.status,
      createdAt: state.session.createdAt,
      heartbeatAt: state.session.heartbeatAt
    };
  }
  return null;
}

export const sessionLocked = (session) => isSessionBusy(session);
export const scanLocked = (scan) => isScanBusy(scan);

export const recentStartRequests = new Map();
const pruneStartRequests = () => {
  const cutoff = Date.now() - 60000;
  for (const [key, val] of recentStartRequests.entries()) {
    if ((val.timestamp || 0) < cutoff) recentStartRequests.delete(key);
  }
};

export async function reconcileRuntimeState(state = null) {
  if (!state) state = await load();
  const now = Date.now();
  let changed = false;
  const updates = {};

  // 1. Quét (Scan) reconciliation
  if (state.scan) {
    const scan = state.scan;
    const isScanTerminal = ["complete", "completed", "error", "cancelled", "failed"].includes(scan.status);
    if (isScanTerminal) {
      if (scan.active === true) {
        scan.active = false;
        scan.updatedAt = now;
        changed = true;
        updates[KEYS.scan] = scan;
      }
    } else if (scan.status === "scanning" || scan.active === true) {
      const scanAge = now - (scan.updatedAt || scan.startedAt || 0);
      if (scanAge > HEARTBEAT_THRESHOLD_MS) {
        console.warn(`[RECONCILE] Scan ${scan.id} stale (age=${scanAge}ms). Đánh dấu error/inactive.`);
        scan.status = "error";
        scan.active = false;
        scan.error = "Lượt quét bị quá hạn (stale).";
        scan.updatedAt = now;
        changed = true;
        updates[KEYS.scan] = scan;
      }
    }
  }

  // 2. Phiên điền (Session) reconciliation
  if (state.session) {
    const session = state.session;
    if (session.attemptToken) {
      // ĐANG CÓ LƯỢT GỬI CHỜ XÁC NHẬN: TUYỆT ĐỐI BẢO LƯU attemptToken!
      const heartbeatAge = now - (session.heartbeatAt || session.createdAt || now);
      let tabDied = false;
      if (session.tabId && typeof chrome !== "undefined" && chrome.tabs?.get) {
        try {
          const tab = await chrome.tabs.get(session.tabId);
          if (!tab) tabDied = true;
        } catch {
          tabDied = true;
        }
      }
      if (session.active && (heartbeatAge > HEARTBEAT_THRESHOLD_MS || tabDied)) {
        console.warn(`[RECONCILE] Session ${session.id} có pending attemptToken nhưng tab died hoặc stale. Đánh dấu unresolved.`);
        session.active = false;
        session.status = "unresolved";
        session.error = "Lượt gửi đang chờ đối chiếu xác nhận từ Google.";
        session.heartbeatAt = now;
        changed = true;
        updates[SESSION_KEY] = session;
      } else if (!session.active && session.status !== "unresolved" && session.status !== "submitting" && session.status !== "confirming") {
        session.status = "unresolved";
        session.error = session.error || "Lượt gửi đang chờ đối chiếu xác nhận từ Google.";
        session.heartbeatAt = now;
        changed = true;
        updates[SESSION_KEY] = session;
      }
    } else {
      const isTerminal = ["completed", "cancelled", "error", "failed"].includes(session.status);
      if (isTerminal) {
        if (session.active || session.activeResponse) {
          delete session.activeResponse;
          session.active = false;
          session.heartbeatAt = now;
          changed = true;
          updates[SESSION_KEY] = session;
        }
      } else if (BUSY_SESSION_STATUSES.has(session.status) && session.status !== "paused") {
        const heartbeatAge = now - (session.heartbeatAt || session.createdAt || now);
        let tabDied = false;
        if (session.tabId && typeof chrome !== "undefined" && chrome.tabs?.get) {
          try {
            const tab = await chrome.tabs.get(session.tabId);
            if (!tab) tabDied = true;
          } catch {
            tabDied = true;
          }
        }
        const threshold = calcMaxHeartbeatAge(session);
        if (heartbeatAge > threshold || (tabDied && session.status !== "starting")) {
          console.warn(`[RECONCILE] Session ${session.id} stale (heartbeatAge=${heartbeatAge}ms, tabDied=${tabDied}). Đánh dấu error/inactive.`);
          session.status = "error";
          session.error = "Phiên điền bị quá hạn phản hồi hoặc tab đã đóng (stale).";
          session.active = false;
          delete session.activeResponse;
          session.heartbeatAt = now;
          changed = true;
          updates[SESSION_KEY] = session;
        }
      }
    }
  }

  if (changed) {
    await set(updates);
  }
  updateExtensionBadge(state.session);
  return state;
}

let transaction = Promise.resolve();
export const exclusive = (task) => {
  const wrapped = () => task();
  const result = transaction.then(wrapped, wrapped);
  transaction = result.catch(() => null);
  return result;
};
export const withTransaction = exclusive;
const set = (value) => chrome.storage.local.set(value);

async function load(currentFormId = "") {
  const raw = await chrome.storage.local.get(null);
  let store = raw[STORE_KEY];
  if (!store?.migration?.legacyImported) {
    store = migrateStore(raw, { currentFormId });
    await set({ [STORE_KEY]: store });
  } else store = createStore(store);
  return { store, session: raw[SESSION_KEY] || null, scan: raw[KEYS.scan] || null };
}

const blankProfile = (id, url = "") => ({ formId: id, formUrl: viewUrl(url), questions: [], config: {}, screening: {}, csv: [], csvName: "", ui: {} });
const originalAnswers = (screening = {}) => Object.entries(screening).flatMap(([id, rule]) => id === "*" || rule?.mode !== "fixed" ? [] : Array.isArray(rule.value) ? rule.value : [rule.value]).filter((value) => String(value ?? "").trim());
const originalQuestions = (items = []) => items.map((item, index) => ({
  id: String(item.id || `original:${Number.isInteger(item.index) ? item.index : index}`),
  title: String(item.title || `Câu hỏi ${index + 1}`).replace(/\s*\*\s*$/, "").trim(),
  type: item.type === "short_answer" ? "text" : item.type,
  required: Boolean(item.isRequired ?? item.required),
  options: (item.options || []).map((option) => ({ text: String(option.text || ""), other: Boolean(option.isOther ?? option.other) })).filter((option) => option.text)
}));

async function getState(id = "") {
  const state = await load(id);
  const profile = getProfile(state.store, id);
  if (profile && profile.questions?.length) {
    const nextConfig = reconcileQuestionConfig(profile.config || {}, profile.questions, profile.questions);
    if (JSON.stringify(nextConfig) !== JSON.stringify(profile.config)) {
      profile.config = nextConfig;
      state.store = setProfile(state.store, profile);
      await set({ [STORE_KEY]: state.store });
    }
  }
  updateExtensionBadge(state.session);
  const schedule = getSchedule(state.store, id);
  let scheduleActive = false;
  let nextRun = null;
  if (id && schedule) {
    let formAlarms = [];
    if (chrome.alarms?.getAll) {
      try {
        const allAlarms = await chrome.alarms.getAll();
        formAlarms = (allAlarms || []).filter((a) => a.name.startsWith(`aks-sched:${id}:`));
      } catch {}
    }
    const pending = (schedule.items || []).filter((item) => item.status === "pending").sort((a, b) => a.at - b.at);
    if (schedule.active && schedule.status === "active" && pending.length > 0) {
      scheduleActive = true;
      if (formAlarms.length > 0) {
        const sorted = [...formAlarms].sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
        nextRun = sorted[0].scheduledTime || pending[0]?.at || null;
      } else {
        nextRun = pending[0]?.at || null;
      }
    }
  }
  return { [KEYS.store]: state.store, [KEYS.session]: state.session, [KEYS.scan]: state.scan, profile, schedule, scheduleActive, nextRun };
}

async function ensureProfile(message) {
  const id = String(message.formId || ""), state = await load(id);
  let profile = getProfile(state.store, id);
  if (!profile) {
    profile = blankProfile(id, message.formUrl);
    state.store = setProfile(state.store, profile);
    await set({ [STORE_KEY]: state.store });
  } else if (profile.questions?.length) {
    const nextConfig = reconcileQuestionConfig(profile.config || {}, profile.questions, profile.questions);
    if (JSON.stringify(nextConfig) !== JSON.stringify(profile.config)) {
      profile.config = nextConfig;
      state.store = setProfile(state.store, profile);
      await set({ [STORE_KEY]: state.store });
    }
  }
  return profile;
}

async function saveProfile(message) {
  const id = String(message.formId || ""), state = await load(id);
  const profile = { ...(getProfile(state.store, id) || blankProfile(id, message.formUrl)), ...(message.patch || {}), formId: id };
  state.store = setProfile(state.store, profile);
  await set({ [STORE_KEY]: state.store });
  return profile;
}

async function saveConfig(message) {
  const id = String(message.formId || ""), state = await load(id);
  const profile = { ...(getProfile(state.store, id) || blankProfile(id)), config: message.config || {}, formId: id };
  state.store = setProfile(state.store, profile);
  await set({ [STORE_KEY]: state.store });
  return profile;
}

async function saveScreening(message) {
  const id = String(message.formId || ""), state = await load(id);
  const profile = { ...(getProfile(state.store, id) || blankProfile(id)), screening: message.screening || {}, formId: id };
  state.store = setProfile(state.store, profile);
  await set({ [STORE_KEY]: state.store });
  return profile;
}

async function saveCsv(message) {
  const id = String(message.formId || ""), state = await load(id);
  const profile = { ...(getProfile(state.store, id) || blankProfile(id)), csv: message.rows || [], csvName: message.name || "", formId: id };
  state.store = setProfile(state.store, profile);
  await set({ [STORE_KEY]: state.store });
  return profile;
}

async function removeForm(message) {
  const id = String(message.formId || ""), state = await load(id);
  await reconcileRuntimeState(state);
  const activeLock = getActiveLock(state);
  if (activeLock && activeLock.formId === id) throw new Error("Form này đang được quét hoặc điền.");
  if (chrome.alarms?.getAll && chrome.alarms?.clear) {
    try {
      const allAlarms = await chrome.alarms.getAll();
      for (const alarm of (allAlarms || [])) {
        if (alarm.name.startsWith(`aks-sched:${id}:`)) {
          await chrome.alarms.clear(alarm.name);
        }
      }
    } catch {}
  }
  state.store = deleteForm(state.store, id);
  await set({ [STORE_KEY]: state.store });
  return true;
}

async function tabFor(session) {
  if (session?.tabId) {
    try {
      const tab = await chrome.tabs.get(session.tabId);
      if (tab?.id) return tab;
    } catch {
      // Tab may be closed
    }
  }
  const formsTabs = await chrome.tabs.query({ url: "https://docs.google.com/forms/*" }).catch(() => []);
  if (formsTabs?.length) {
    const target = formsTabs.find((t) => session?.formId && t.url?.includes(session.formId)) || formsTabs[0];
    if (target?.id) return target;
  }
  // NEVER steal focus or hijack user's active tab! Create a background tab instead.
  return chrome.tabs.create({ url: session?.formUrl || "https://docs.google.com/forms", active: false });
}

function send(tabId, message, retry = true) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (retry && chrome.runtime.lastError) setTimeout(() => send(tabId, message, false), 1200);
  });
}

export async function sendTabMessageAsync(tabId, message, timeoutMs = 5000) {
  if (!tabId || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
    if (!tabId || !chrome.tabs?.sendMessage) throw new Error("TABS_SEND_MESSAGE_UNAVAILABLE");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onDone = (res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };
    const onFail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err?.message || err)));
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        onFail(new Error("TAB_MESSAGE_TIMEOUT"));
      }, timeoutMs);
    }

    try {
      const p = chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = chrome.runtime?.lastError;
        if (err) return onFail(err);
        onDone(response);
      });
      if (p && typeof p.then === "function") {
        p.then(onDone, onFail);
      }
    } catch (e) {
      onFail(e);
    }
  });
}


export async function deliverOutboxStep(session, targetTabId) {

  if (!session?.outbox?.stepDispatch) return null;
  if (session.outbox.nextAttemptAt && Date.now() < session.outbox.nextAttemptAt) {
    console.log(`[OUTBOX] nextAttemptAt (${session.outbox.nextAttemptAt}) not reached yet (now: ${Date.now()}). Blocking delivery.`);
    return null;
  }
  const tabId = targetTabId || session.tabId;
  if (!tabId) {
    session.outbox.lastDeliveryError = "NO_TAB_ID";
    session.outbox.state = "pending";
    await set({ [SESSION_KEY]: session });
    return null;
  }

  // Preserve existing active lease if still valid in the future
  const currentLease = session.outbox.envelope?.leaseExpiresAt || session.leaseExpiresAt;
  const leaseDuration = 60000;
  const freshLease = (currentLease && currentLease > Date.now())
    ? currentLease
    : Math.max(Date.now(), session.outbox.nextAttemptAt || 0) + leaseDuration;

  session.leaseExpiresAt = freshLease;
  const refreshedEnvelope = session.outbox.envelope
    ? Object.freeze({ ...session.outbox.envelope, leaseExpiresAt: freshLease })
    : null;
  if (refreshedEnvelope) session.outbox.envelope = refreshedEnvelope;
  session.outbox.stepDispatch = {
    ...session.outbox.stepDispatch,
    leaseExpiresAt: freshLease,
    envelope: refreshedEnvelope || (session.outbox.stepDispatch.envelope
      ? Object.freeze({ ...session.outbox.stepDispatch.envelope, leaseExpiresAt: freshLease })
      : undefined)
  };
  if (session.activeStepId === session.outbox.stepId) {
    if (session.outbox.stepDispatch.envelope) session.activeEnvelope = session.outbox.stepDispatch.envelope;
    session.cachedNextStep = session.outbox.stepDispatch;
  }

  const targetStepId = session?.outbox?.stepId;
  const targetCompleted = session.completed;

  try {
    session.outbox.state = "leased";
    await set({ [SESSION_KEY]: session });
    await sendTabMessageAsync(tabId, session.outbox.stepDispatch);

    // Stale-write race protection: re-load current session from storage
    const state = await load();
    const currentSessionState = state.session;
    if (
      !currentSessionState ||
      currentSessionState.id !== session.id ||
      Number(currentSessionState.runEpoch) !== Number(session.runEpoch) ||
      currentSessionState.outbox?.stepId !== targetStepId ||
      currentSessionState.outbox?.state === "acked" ||
      currentSessionState.completed !== targetCompleted ||
      (currentSessionState.activeStepId && currentSessionState.activeStepId !== targetStepId) ||
      currentSessionState.lastAckedStepId === targetStepId ||
      currentSessionState.lastAck?.envelope?.stepId === targetStepId
    ) {
      console.log(`[OUTBOX] Session was already updated/acked during delivery. Aborting stale write-back.`);
      return currentSessionState?.outbox?.stepDispatch || null;
    }

    currentSessionState.outbox.lastDeliveryError = null;
    currentSessionState.outbox.state = "delivered_waiting_ack";
    currentSessionState.outbox.deliveredAt = Date.now();
    currentSessionState.outbox.ackDeadline = Date.now() + 30000;
    await set({ [SESSION_KEY]: currentSessionState });

    if (typeof chrome !== "undefined" && chrome.alarms?.create) {
      const ackTimeoutAlarm = `aks:step-ack-timeout:${currentSessionState.id}:${currentSessionState.runEpoch || 1}:${currentSessionState.outbox.stepId}`;
      chrome.alarms.create(ackTimeoutAlarm, { when: currentSessionState.outbox.ackDeadline });
    }
    return currentSessionState.outbox.stepDispatch;
  } catch (err) {
    const errorMsg = err?.message || String(err);
    console.warn(`[OUTBOX] Delivery failed for step ${targetStepId}:`, errorMsg);
    const state = await load();
    const currentSessionState = state.session;
    if (
      !currentSessionState ||
      currentSessionState.id !== session.id ||
      Number(currentSessionState.runEpoch) !== Number(session.runEpoch) ||
      currentSessionState.outbox?.stepId !== targetStepId ||
      currentSessionState.outbox?.state === "acked" ||
      currentSessionState.completed !== targetCompleted ||
      currentSessionState.lastAckedStepId === targetStepId
    ) {
      return null;
    }

    currentSessionState.outbox.state = "pending";
    currentSessionState.outbox.lastDeliveryError = errorMsg;
    currentSessionState.outbox.attempt = (currentSessionState.outbox.attempt || 1) + 1;

    const backoffMs = Math.min(15000, 1000 * Math.pow(2, Math.min(currentSessionState.outbox.attempt - 1, 4)));
    currentSessionState.outbox.nextAttemptAt = Date.now() + backoffMs;
    await set({ [SESSION_KEY]: currentSessionState });

    if (typeof chrome !== "undefined" && chrome.alarms?.create) {
      const retryAlarm = `aks:step-retry:${currentSessionState.id}:${currentSessionState.runEpoch || 1}:${currentSessionState.outbox.stepId}`;
      chrome.alarms.create(retryAlarm, { when: currentSessionState.outbox.nextAttemptAt });
      armShortStepAlarm(retryAlarm, currentSessionState.outbox.nextAttemptAt);
    }
    return null;
  }
}

export async function dispatchStepWithOutbox(session, stepId, stepType, envelope, stepDispatch, targetTabId) {
  session.activeStepId = stepId;
  session.activeStepType = stepType;
  session.activeEnvelope = envelope;
  session.leaseExpiresAt = envelope.leaseExpiresAt;
  session.cachedNextStep = stepDispatch;

  session.outbox = {
    stepId,
    stepType,
    envelope,
    stepDispatch,
    state: "pending",
    attempt: 1,
    nextAttemptAt: Date.now(),
    lastDeliveryError: null
  };

  await set({ [SESSION_KEY]: session });
  return deliverOutboxStep(session, targetTabId);
}

export async function scheduleOrDispatchNextStep(session, nextStepId, nextStepType, nextEnvelope, nextStep, targetTabId) {
  const answerDelaySec = Number(session.answerDelay || 0);
  if (answerDelaySec > 0) {
    session.activeStepId = nextStepId;
    session.activeStepType = nextStepType;
    session.activeEnvelope = nextEnvelope;
    session.leaseExpiresAt = nextEnvelope.leaseExpiresAt;
    session.cachedNextStep = nextStep;

    const scheduledAt = Date.now() + Math.round(answerDelaySec * 1000);
    session.outbox = {
      stepId: nextStepId,
      stepType: nextStepType,
      envelope: nextEnvelope,
      stepDispatch: nextStep,
      state: "pending",
      attempt: 1,
      nextAttemptAt: scheduledAt,
      lastDeliveryError: null
    };
    await set({ [SESSION_KEY]: session });

    if (typeof chrome !== "undefined" && chrome.alarms?.create) {
      const readyAlarm = `aks:step-ready:${session.id}:${session.runEpoch || 1}:${nextStepId}`;
      chrome.alarms.create(readyAlarm, { when: scheduledAt });
      armShortStepAlarm(readyAlarm, scheduledAt);
    }
    return { ok: true, scheduledAt, nextStepId };
  } else {
    await dispatchStepWithOutbox(session, nextStepId, nextStepType, nextEnvelope, nextStep, targetTabId);
    return { ok: true, nextStep };
  }
}

function safeSendMessage(tabId, message) {
  sendTabMessageAsync(tabId, message).catch(() => {});
}

async function wake(session) {
  const tab = await tabFor(session);
  let navigating = false;
  const tabCanonical = tab.url ? viewUrl(tab.url) : "";
  const sessionCanonical = session.formUrl ? viewUrl(session.formUrl) : "";
  if (!tabCanonical || !sessionCanonical || tabCanonical !== sessionCanonical) {
    await chrome.tabs.update(tab.id, { url: session.formUrl, active: false, autoDiscardable: false });
    navigating = true;
  } else {
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => null);
  }
  session.tabId = tab.id;
  await set({ [SESSION_KEY]: session });
  if (!navigating && tab.status === "complete") send(tab.id, { action: "aks:start", sessionId: session.id });
  updateExtensionBadge(session);
  return session;
}

async function beginScan(message) {
  const id = String(message.formId || ""), state = await load(id);
  await reconcileRuntimeState(state);
  const activeLock = getActiveLock(state);
  if (activeLock) {
    console.warn("[BUSY_GUARD]", {
      "aksScan.status": state.scan?.status,
      "aksScan.active": state.scan?.active,
      "session.status": state.session?.status,
      "session.id": state.session?.id,
      "activeResponse": Boolean(state.session?.activeResponse),
      "heartbeatAge": Date.now() - (state.session?.heartbeatAt || 0),
      "operationLock": Boolean(activeLock),
      "tabId": state.session?.tabId,
      "action": "beginScan"
    });
    throw new Error("Đã có một tác vụ quét hoặc điền đang hoạt động.");
  }
  let profile = getProfile(state.store, id);
  if (!profile) { profile = blankProfile(id, message.formUrl); state.store = setProfile(state.store, profile); }
  const scan = createScanState({ id: crypto.randomUUID(), formId: id, formUrl: viewUrl(message.formUrl), lastGoodQuestions: profile.questions || [], screening: message.screening || {} });
  scan.tabId = message.tabId || null; scan.status = "scanning"; scan.phase = message.scanEngine === "legacy" ? "original" : "hybrid"; scan.originalAnswers = originalAnswers(message.screening);
  await set({ [STORE_KEY]: state.store, [KEYS.scan]: scan });
  let tab = await tabFor(scan), navigating = false;
  if (/\/formResponse/i.test(tab.url || "")) {
    tab = await chrome.tabs.update(tab.id, { url: viewUrl(scan.formUrl), active: false });
    navigating = true;
  }
  scan.tabId = tab.id; await set({ [KEYS.scan]: scan });
  if (!navigating) {
    if (message.scanEngine === "legacy") {
      send(tab.id, { action: "scanForm", screeningAnswers: scan.originalAnswers });
    } else {
      send(tab.id, { action: "aks:start-scan", scanId: scan.id, screeningAnswers: scan.originalAnswers });
    }
  }
  return scan;
}

async function finishOriginalScan() {
  const state = await load(), scan = state.scan;
  if (!scan?.active || scan.status !== "scanning") return scan;
  const key = `scannedQuestions_${scan.formId}`, raw = await chrome.storage.local.get(key), questions = originalQuestions(raw[key] || []);
  if (!questions.length) {
    const failed = transitionScan(scan, { type: "FAIL", error: "Bộ quét gốc không tìm thấy câu hỏi nào; kết quả tốt trước đó vẫn được giữ nguyên." });
    await set({ [KEYS.scan]: failed }); return failed;
  }
  const completedAt = Date.now();
  const next = transitionScan(scan, { type: "SCAN_COMPLETED", questions, at: completedAt });
  const previousProfile = getProfile(state.store, scan.formId);
  const reconciledConfig = reconcileQuestionConfig(previousProfile?.config || {}, questions, previousProfile?.questions || []);
  const profile = { ...(previousProfile || blankProfile(scan.formId, scan.formUrl)), questions, config: reconciledConfig, formUrl: scan.formUrl, lastScanAt: completedAt };
  state.store = setProfile(state.store, profile);
  await set({ [STORE_KEY]: state.store, [KEYS.scan]: next });
  if (next.tabId) send(next.tabId, { action: "aks:scan-complete", questions }, false);
  return next;
}

async function scanEvent(message) {
  const state = await load(), current = state.scan;
  if (!current || current.id !== message.scanId) throw new Error("Lượt quét không còn tồn tại.");
  const scan = transitionScan(current, message.event || {});
  const values = { [KEYS.scan]: scan };
  if (message.event?.type === "GOOGLE_CONFIRMED" || message.event?.type === "SCAN_COMPLETED") {
    const questions = originalQuestions(scan.questions);
    const previousProfile = getProfile(state.store, scan.formId);
    const reconciledConfig = reconcileQuestionConfig(previousProfile?.config || {}, questions, previousProfile?.questions || []);
    const profile = { ...(previousProfile || blankProfile(scan.formId, scan.formUrl)), questions, config: reconciledConfig, formUrl: scan.formUrl, lastScanAt: scan.completedAt || Date.now() };
    state.store = setProfile(state.store, profile); values[STORE_KEY] = state.store;
  }
  await set(values); return scan;
}

async function prepareScan(message) {
  const state = await load(), scan = state.scan;
  if (!scan || scan.id !== message.scanId) throw new Error("Lượt quét không còn tồn tại.");
  return scanEvent({ scanId: scan.id, event: { type: "PREPARE_SUBMIT", token: `${scan.id}:${Date.now()}` } });
}

async function cancelScan(message) {
  const state = await load(), scan = state.scan;
  if (!scan || (message.scanId && scan.id !== message.scanId)) return scan;
  if (hasUnresolvedSubmit(scan)) throw new Error("Đã bấm Gửi; cần xác minh với Google trước khi kết thúc lượt quét.");
  if (scan.status === "scanning") {
    const next = { ...scan, status: "cancelled", active: false, error: "", updatedAt: Date.now() };
    const legacy = await chrome.storage.local.get("autoScanState"), autoScanState = { ...(legacy.autoScanState || {}), isScanning: false };
    await set({ [KEYS.scan]: next, autoScanState }); if (scan.tabId) send(scan.tabId, { action: "stopScanForm" }, false); return next;
  }
  const next = transitionScan(scan, { type: "CANCEL" }); await set({ [KEYS.scan]: next });
  if (scan.tabId) send(scan.tabId, { action: "aks:stop-scan" }, false);
  return next;
}

async function createSession(payload) {
  const requestId = String(payload.requestId || crypto.randomUUID());
  console.log(`[START:BG] received requestId=${requestId}`);
  pruneStartRequests();

  if (recentStartRequests.has(requestId)) {
    const cached = recentStartRequests.get(requestId);
    console.log(`[START:BG] duplicate requestId=${requestId} - returning cached response`);
    if (cached.error) {
      throw new Error(cached.error);
    }
    return cached.result;
  }

  const state = await load(payload.formId);
  await reconcileRuntimeState(state);

  const activeLock = getActiveLock(state);
  if (activeLock) {
    console.warn("[BUSY_GUARD]", {
      "aksScan.status": state.scan?.status,
      "aksScan.active": state.scan?.active,
      "session.status": state.session?.status,
      "session.id": state.session?.id,
      "activeResponse": Boolean(state.session?.activeResponse),
      "heartbeatAge": Date.now() - (state.session?.heartbeatAt || 0),
      "operationLock": Boolean(activeLock),
      "tabId": state.session?.tabId,
      "requestId": requestId
    });
    const err = "Đã có một tác vụ quét hoặc điền đang hoạt động.";
    recentStartRequests.set(requestId, { error: err, timestamp: Date.now() });
    console.warn(`[START:BG] rejected requestId=${requestId} - BUSY`);
    throw new Error(err);
  }

  const profile = getProfile(state.store, payload.formId);
  if (!profile) {
    const err = "Chưa có dữ liệu của Form đang mở.";
    recentStartRequests.set(requestId, { error: err, timestamp: Date.now() });
    throw new Error(err);
  }
  const target = Math.max(1, Math.floor(Number(payload.target) || 0));
  if (payload.source === "csv" && target > (profile.csv?.length || 0)) {
    const err = "Số lượt vượt số dòng CSV.";
    recentStartRequests.set(requestId, { error: err, timestamp: Date.now() });
    throw new Error(err);
  }

  try {
    const newSession = await wake({
      id: crypto.randomUUID(), formId: profile.formId, formUrl: profile.formUrl, tabId: payload.tabId || null,
      source: payload.source === "csv" ? "csv" : "ratio", target, completed: 0, csvCursor: 0,
      answerDelay: Math.max(0, Number(payload.answerDelay) || 0), restMode: payload.restMode === "random" ? "random" : "none",
      restMin: Math.max(0, Number(payload.restMin) || 0), restMax: Math.max(0, Number(payload.restMax) || 0),
      config: payload.config || {}, status: "starting", createdAt: Date.now(), heartbeatAt: Date.now(), recoveries: 0,
      active: true, runEpoch: 1, revision: 1
    });
    recentStartRequests.set(requestId, { result: newSession, timestamp: Date.now() });
    console.log(`[START:BG] accepted requestId=${requestId}`);
    return newSession;
  } catch (err) {
    recentStartRequests.set(requestId, { error: err?.message || String(err), timestamp: Date.now() });
    throw err;
  }
}

export async function finalizePause(session) {
  if (!session) return null;
  session.status = "paused";
  session.active = false;
  const oldEpoch = session.runEpoch || 1;
  session.runEpoch = oldEpoch + 1;
  delete session.activeStepId;
  delete session.activeStepType;
  delete session.activeEnvelope;
  delete session.activeTargetQuestion;
  delete session.leaseExpiresAt;
  delete session.cachedNextStep;
  delete session.outbox;
  delete session.notBefore;
  delete session.pauseAfterCommit;
  session.heartbeatAt = Date.now();
  if (typeof chrome !== "undefined" && chrome.alarms?.clear) {
    try {
      chrome.alarms.clear(`aks:rest-wake:${session.id}:${oldEpoch}`);
      chrome.alarms.clear(`aks:step-retry:${session.id}:${oldEpoch}`);
      chrome.alarms.clear(`aks:step-ready:${session.id}:${oldEpoch}`);
      const allAlarms = await chrome.alarms.getAll().catch(() => []);
      for (const al of allAlarms || []) {
        if (al.name.startsWith(`aks:rest-wake:${session.id}:`) ||
            al.name.startsWith(`aks:step-retry:${session.id}:`) ||
            al.name.startsWith(`aks:step-ready:${session.id}:`)) {
          chrome.alarms.clear(al.name);
        }
      }
    } catch {}
  }
  await set({ [SESSION_KEY]: session });
  updateExtensionBadge(session);
  return session;
}

async function control(status) {
  const state = await load(), session = state.session;
  if (!session) return null;
  if (status === "running") {
    if (!["paused", "interrupted", "error", "starting", "pause_requested"].includes(session.status)) return session;
    if (session.attemptToken) throw new Error("Lượt đã gửi đang chờ Google xác nhận; hãy mở tab Form để đối chiếu, không được gửi lại.");
    session.status = "resuming";
    session.active = true;
    session.runEpoch = (Number(session.runEpoch) || 1) + 1;
    session.error = "";
    session.recoveries = 0;
    session.heartbeatAt = Date.now();
    await set({ [SESSION_KEY]: session });
    updateExtensionBadge(session);
    return wake(session);
  }
  if (status === "paused") {
    if (session.status === "paused") return session;
    if (session.activeResponse && session.tabId) {
      session.status = "pause_requested";
      session.heartbeatAt = Date.now();
      await set({ [SESSION_KEY]: session });
      send(session.tabId, { action: "aks:pause", sessionId: session.id, runEpoch: session.runEpoch }, false);
      updateExtensionBadge(session);
      return session;
    }
    return finalizePause(session);
  }
  if (status === "cancelled") {
    if (session.attemptToken) throw new Error("Lượt đã gửi đang chờ xác nhận; không thể hủy để tránh gửi trùng.");
    session.status = "cancelled";
    session.lifecycle = SESSION_LIFECYCLE.CANCELLED;
    session.active = false;
    const oldEpoch = session.runEpoch || 1;
    session.runEpoch = oldEpoch + 1;
    delete session.activeResponse;
    delete session.attemptToken;
    delete session.navigationToken;
    delete session.submitToken;
    delete session.confirmedToken;
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.leaseExpiresAt;
    delete session.cachedNextStep;
    delete session.outbox;
    delete session.notBefore;
    session.recoveries = 0;
    session.heartbeatAt = Date.now();
    if (typeof chrome !== "undefined" && chrome.alarms?.clear) {
      try {
        const allAlarms = await chrome.alarms.getAll().catch(() => []);
        for (const al of allAlarms || []) {
          if (al.name.startsWith(`aks:rest-wake:${session.id}:`) ||
              al.name.startsWith(`aks:step-retry:${session.id}:`) ||
              al.name.startsWith(`aks:step-ready:${session.id}:`)) {
            chrome.alarms.clear(al.name);
          }
        }
      } catch {}
    }
    if (session.scheduleItemId) {
      const schedule = getSchedule(state.store, session.formId), item = schedule?.items?.find((entry) => entry.id === session.scheduleItemId);
      if (item) item.status = "cancelled";
      if (schedule) { state.store = setSchedule(state.store, schedule); await set({ [STORE_KEY]: state.store }); }
    }
    await set({ [SESSION_KEY]: session });
    if (session.tabId) {
      send(session.tabId, { action: "aks:stop", sessionId: session.id }, false);
      session.tabId = null;
      await set({ [SESSION_KEY]: session });
    }
    updateExtensionBadge(session);
    return session;
  }
  session.status = status;
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  updateExtensionBadge(session);
  return session;
}

async function saveSchedule(payload) {
  const state = await load(payload.formId), profile = getProfile(state.store, payload.formId), previous = getSchedule(state.store, payload.formId);
  if (!profile) throw new Error("Lịch không thuộc Form hiện tại.");
  await reconcileRuntimeState(state);
  const activeLock = getActiveLock(state);
  if (activeLock && activeLock.formId === payload.formId) throw new Error("Form này đang được quét hoặc điền; chưa thể sửa lịch.");
  const source = payload.source === "csv" ? "csv" : "ratio";
  const raw = (payload.items || []).map((entry) => {
    const old = previous?.items?.find((item) => item.id === entry.id), count = Math.max(1, Math.floor(Number(entry.count) || 0));
    const completed = Math.min(count, old?.completed || 0);
    return { id: entry.id || crypto.randomUUID(), at: Number(entry.at), count, answerDelay: Math.max(0, Number(entry.answerDelay) || 0), restMode: entry.restMode === "random" ? "random" : "none", restMin: Math.max(0, Number(entry.restMin) || 0), restMax: Math.max(0, Number(entry.restMax) || 0), status: completed >= count ? "completed" : "pending", completed };
  }).filter((item) => Number.isFinite(item.at)).sort((a, b) => a.at - b.at);
  if (!raw.length) throw new Error("Lịch chưa có mốc hợp lệ.");
  const allocation = source === "csv" ? allocate(raw, profile.csv?.length || 0) : { items: raw, used: 0 };

  // Xóa toàn bộ alarm cũ của form này để ngăn trùng lặp alarm
  if (chrome.alarms?.getAll && chrome.alarms?.clear) {
    try {
      const allAlarms = await chrome.alarms.getAll();
      for (const alarm of (allAlarms || [])) {
        if (alarm.name.startsWith(`aks-sched:${profile.formId}:`)) {
          await chrome.alarms.clear(alarm.name);
        }
      }
    } catch {}
  }

  const pending = allocation.items.filter((item) => item.status === "pending");
  let alarmsCount = 0;
  if (pending.length > 0 && chrome.alarms?.create) {
    for (const item of pending) {
      try {
        chrome.alarms.create(`aks-sched:${profile.formId}:${item.id}`, {
          when: Math.max(Date.now() + 1000, item.at)
        });
        alarmsCount++;
      } catch {}
    }
  }

  const nextRun = pending[0]?.at || null;
  const schedule = {
    formId: profile.formId,
    formUrl: profile.formUrl,
    source,
    config: payload.config || {},
    items: allocation.items,
    used: allocation.used,
    updatedAt: Date.now(),
    error: "",
    active: pending.length > 0,
    status: pending.length > 0 ? "active" : "completed"
  };
  state.store = setSchedule(state.store, schedule);
  await set({ [STORE_KEY]: state.store });
  setTimeout(() => exclusive(runSchedule), 0);
  return {
    ...schedule,
    scheduleActive: pending.length > 0,
    nextRun,
    alarmsCount
  };
}

async function cancelSchedule(message) {
  const id = String(message.formId || "");
  const state = await load(id);
  const schedule = getSchedule(state.store, id);
  if (!schedule) throw new Error("Không tìm thấy lịch chạy cho biểu mẫu này.");

  // Xóa toàn bộ alarm của form này
  if (chrome.alarms?.getAll && chrome.alarms?.clear) {
    try {
      const allAlarms = await chrome.alarms.getAll();
      for (const alarm of (allAlarms || [])) {
        if (alarm.name.startsWith(`aks-sched:${id}:`)) {
          await chrome.alarms.clear(alarm.name);
        }
      }
    } catch {}
  }

  // Giữ nguyên cấu hình người dùng (items, config, source), chỉ đổi trạng thái inactive/cancelled
  schedule.active = false;
  schedule.status = "cancelled";
  schedule.updatedAt = Date.now();
  state.store = setSchedule(state.store, schedule);
  await set({ [STORE_KEY]: state.store });

  return {
    ...schedule,
    scheduleActive: false,
    nextRun: null
  };
}

async function validateSchedule(message = {}) {
  const state = await load(message.formId), schedule = getSchedule(state.store, message.formId), profile = getProfile(state.store, message.formId);
  if (!schedule || schedule.source !== "csv") return schedule;
  try {
    const done = schedule.items.filter((item) => item.status === "completed"), pending = schedule.items.filter((item) => item.status !== "completed");
    const start = done.reduce((sum, item) => sum + item.count, 0), allocation = allocate(pending, Math.max(0, (profile?.csv?.length || 0) - start));
    allocation.items.forEach((item) => { item.csvStart += start; }); schedule.items = [...done, ...allocation.items].sort((a, b) => a.at - b.at); schedule.used = start + allocation.used; schedule.error = "";
  } catch (error) { schedule.error = error.message; }
  state.store = setSchedule(state.store, schedule); await set({ [STORE_KEY]: state.store }); return schedule;
}

async function runSchedule() {
  const state = await load();
  await reconcileRuntimeState(state);
  if (sessionLocked(state.session) || isOperationLocked(state.scan)) return;
  const candidates = listSchedules(state.store)
    .filter((schedule) => schedule.active !== false && schedule.status !== "cancelled" && !schedule.error)
    .flatMap((schedule) => (schedule.items || []).filter((item) => item.status === "pending" && item.at <= Date.now()).map((item) => ({ schedule, item })))
    .sort((a, b) => a.item.at - b.item.at);
  const due = candidates[0]; if (!due) return;
  const { schedule, item } = due, profile = getProfile(state.store, schedule.formId); if (!profile) return;
  if (schedule.source === "csv" && item.csvStart + item.count > (profile.csv?.length || 0)) { schedule.error = "CSV hiện tại không đủ dòng cho lịch."; state.store = setSchedule(state.store, schedule); await set({ [STORE_KEY]: state.store }); return; }
  item.status = "running"; state.store = setSchedule(state.store, schedule);
  if (chrome.alarms?.clear) {
    chrome.alarms.clear(`aks-sched:${schedule.formId}:${item.id}`).catch(() => null);
  }
  const session = {
    id: crypto.randomUUID(),
    formId: schedule.formId,
    formUrl: schedule.formUrl,
    tabId: null,
    source: schedule.source,
    target: item.count,
    completed: item.completed || 0,
    csvCursor: item.csvStart + (item.completed || 0),
    answerDelay: Math.max(0, Number(item.answerDelay) || 0),
    restMode: item.restMode,
    restMin: item.restMin,
    restMax: item.restMax,
    config: schedule.config || {},
    scheduleItemId: item.id,
    status: "starting",
    lifecycle: SESSION_LIFECYCLE.ACTIVE,
    phase: SESSION_PHASE.PREPARING,
    active: true,
    runEpoch: 1,
    revision: 1,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
    recoveries: 0
  };
  await set({ [STORE_KEY]: state.store, [SESSION_KEY]: session }); await wake(session);
}

async function prepareSubmit(message) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId) throw new Error("SESSION_NOT_FOUND: Phiên không tồn tại.");
  // Primary check: lifecycle (set by transitionSession Central Reducer)
  const lifecycle = session.lifecycle || SESSION_LIFECYCLE.ACTIVE;
  const isTerminalByLifecycle = [SESSION_LIFECYCLE.COMPLETED, SESSION_LIFECYCLE.CANCELLED, SESSION_LIFECYCLE.FAILED].includes(lifecycle);
  // Fallback check: legacy status strings
  const isTerminalByStatus = ["completed", "cancelled", "error", "failed"].includes(session.status);
  if (isTerminalByLifecycle || isTerminalByStatus) throw new Error("SESSION_TERMINAL: Phiên không còn hoạt động.");
  if (session.attemptToken) throw new Error("Đã có một lượt gửi đang chờ Google xác nhận.");

  // Form Section Ledger Verification
  const profile = getProfile(state.store, session.formId);
  const canonicalQuestions = profile?.questions || [];
  const answerPlanMap = session.activeResponse?.answerPlan ? deserializeAnswerPlan(session.activeResponse.answerPlan) : new Map();
  const activeVerified = session.activeResponse?.verifiedQuestionIds || session.verifiedQuestionIds || [];
  const verifiedSet = new Set(activeVerified);
  if (message.verifiedQuestionIds && Array.isArray(message.verifiedQuestionIds)) {
    message.verifiedQuestionIds.forEach((id) => verifiedSet.add(id));
  }

  if (canonicalQuestions.length > 0 && (verifiedSet.size > 0 || canonicalQuestions.some((q) => q.required))) {
    const navigationOccurred = Boolean(
      session.activeResponse?.navigationOccurred ||
      (Array.isArray(session.activeResponse?.navigationHistory) && session.activeResponse.navigationHistory.length > 0)
    );
    const isBranchedToSubmit = Boolean(message.isBranchedToSubmit || message.isBranchToSubmit || session.activeResponse?.isBranchedToSubmit);
    const ledgerRes = verifyFormLedger(answerPlanMap, verifiedSet, canonicalQuestions, {
      ledger: session.activeResponse?.ledger || {},
      activeResponse: session.activeResponse,
      navigationOccurred,
      isFinalSubmitPage: true,
      isBranchedToSubmit,
      isGoogleRejectionPresent: Boolean(message.isGoogleRejectionPresent)
    });
    if (!ledgerRes.valid) {
      console.warn(`[BACKGROUND] prepareSubmit bị chặn bởi Form Ledger:`, ledgerRes.error);
      throw new Error(`FORM_LEDGER_INVALID: ${ledgerRes.error}`);
    }
    if (ledgerRes.reconciledQuestions?.length > 0) {
      console.log(`[BACKGROUND] LEDGER_RECONCILED_FROM_NAVIGATION: Các câu hỏi được ghi nhận nhờ chuyển section thành công:`, ledgerRes.reconciledQuestions);
      await trace("background", "LEDGER_RECONCILED_FROM_NAVIGATION", {
        sessionId: session.id,
        reconciledQuestions: ledgerRes.reconciledQuestions
      });
    }
  }

  const token = `${session.id}:${session.completed}:${Date.now()}`;
  // Transition to SUBMITTING phase via Central Reducer
  const next = transitionSession(session, { type: "SUBMIT_PREPARED", attemptToken: token });
  if (session.activeStepId) {
    next.revision = session.revision;
  }
  next.attemptToken = token;
  if (next.activeResponse) {
    next.activeResponse.phase = "submitting";
    next.activeResponse.submitToken = token;
    next.activeResponse.submittedAt = Date.now();
  }
  next.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: next });
  return token;
}

async function commit(message) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId) throw new Error("Phiên không tồn tại.");
  session.committedKeys = session.committedKeys || [];
  session.committedRecords = session.committedRecords || [];
  const tokenHash = hashSubmitToken(message.token);
  const respId = session.activeResponse?.responseId || session.responseId || "r0";
  const epoch = Number(session.runEpoch || 1);
  const opId = session.activeStepId || "step_submit";
  const stepId = session.activeStepId || "step_submit";
  const commitRecord = createCommitRecord({
    sessionId: session.id,
    responseId: respId,
    runEpoch: epoch,
    operationId: opId,
    stepId: stepId,
    submitTokenHash: tokenHash
  });
  const commitKey = canonicalizeCommitKey(commitRecord);

  const isAlreadyCommitted = (
    session.committedKeys.includes(commitKey) ||
    session.committedRecords.some((r) =>
      r.sessionId === session.id &&
      r.responseId === respId &&
      Number(r.runEpoch) === epoch &&
      r.submitTokenHash === tokenHash
    ) ||
    (session.confirmedToken && session.confirmedToken === message.token)
  );
  if (isAlreadyCommitted) {
    console.log(`[BACKGROUND] Token ${message.token} đã được commit trước đó (Idempotent).`);
    return session;
  }
  if (session.attemptToken !== message.token) throw new Error("Mã xác nhận lượt gửi không hợp lệ.");
  session.committedKeys.push(commitKey);
  session.committedRecords.push(commitRecord);
  const prior = session.status;
  session.completed++;
  if (session.source === "csv") session.csvCursor++;
  session.confirmedToken = session.attemptToken;
  session.lastConfirmedAt = Date.now();
  delete session.attemptToken;
  delete session.activeResponse;
  delete session.verifiedQuestionIds;
  delete session.activeStepId;
  delete session.activeStepType;
  delete session.leaseExpiresAt;
  delete session.cachedNextStep;
  delete session.lastAckedStepId;
  session.heartbeatAt = Date.now();
  session.recoveries = 0;
  const schedule = session.scheduleItemId ? getSchedule(state.store, session.formId) : null;
  if (schedule) {
    const item = schedule.items.find((entry) => entry.id === session.scheduleItemId);
    if (item) {
      item.completed = session.completed;
      if (session.completed >= session.target) item.status = "completed";
    }
    const allDone = schedule.items.every((it) => it.status === "completed" || it.status === "cancelled");
    if (allDone) {
      schedule.active = false;
      schedule.status = "completed";
    }
    state.store = setSchedule(state.store, schedule);
  }
  session.status = session.completed >= session.target ? "completed" : prior === "paused" ? "paused" : prior === "cancelled" ? "cancelled" : "running";
  if (session.status === "completed" || session.status === "cancelled") {
    session.active = false;
    delete session.activeResponse;
    delete session.attemptToken;
    delete session.navigationToken;
    delete session.submitToken;
  } else {
    session.active = true;
    if (session.restMode === "random") {
      const min = Math.max(0, Number(session.restMin) || 0);
      const max = Math.max(min, Number(session.restMax) || min);
      const restSec = min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min;
      if (restSec > 0) {
        session.notBefore = Date.now() + Math.round(restSec * 1000);
        session.phase = "resting";
        if (typeof chrome !== "undefined" && chrome.alarms?.create) {
          try {
            const restAlarmName = `aks:rest-wake:${session.id}:${session.runEpoch || 1}`;
            chrome.alarms.create(restAlarmName, { when: session.notBefore });
          } catch (e) {
            console.warn("[BACKGROUND] Failed to create rest alarm:", e);
          }
        }
      }
    }
  }
  await set({ [STORE_KEY]: state.store, [SESSION_KEY]: session });
  updateExtensionBadge(session);
  if (session.status === "completed") setTimeout(() => exclusive(runSchedule), 0); return session;
}

async function rejectSubmit(message) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId || session.attemptToken !== message.token) throw new Error("Mã lượt gửi bị từ chối không hợp lệ.");
  delete session.attemptToken;
  delete session.activeResponse;
  delete session.navigationToken;
  delete session.submitToken;
  session.active = false;
  session.status = "error";
  session.error = String(message.error || "Google từ chối phản hồi.");
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  updateExtensionBadge(session);
  return session;
}

async function heartbeat(message) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId) return null;
  session.heartbeatAt = Date.now(); await set({ [SESSION_KEY]: session }); return session;
}

async function failSession(message) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId) return null;
  session.active = false;
  delete session.navigationToken;
  delete session.submitToken;
  if (session.attemptToken) {
    session.status = "unresolved";
    session.error = String(message.error || "Lượt gửi đang chờ đối chiếu xác nhận từ Google.");
  } else {
    delete session.activeResponse;
    session.status = "error";
    session.lifecycle = SESSION_LIFECYCLE.FAILED;
    session.error = String(message.error || "Phiên đã dừng.");
  }
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  updateExtensionBadge(session);
  return session;
}

async function watchdog() {
  const state = await load(), session = state.session;
  if (session?.leaseExpiresAt && Date.now() < session.leaseExpiresAt) {
    return;
  }
  const maxHeartbeatAge = (session?.restMode === "random" && session?.restMax)
    ? Math.max(90000, Number(session.restMax) * 1000 + 45000)
    : 90000;
  if (!session || !isSessionBusy(session) || ["paused", "completed", "cancelled"].includes(session.status) || Date.now() - (session.heartbeatAt || 0) < maxHeartbeatAge) return;
  if ((session.recoveries || 0) >= 3) {
    session.active = false;
    delete session.navigationToken;
    delete session.submitToken;
    if (session.attemptToken) {
      session.status = "unresolved";
      session.error = "Đang chờ xác minh lượt đã gửi; mở lại tab Form để đối chiếu.";
    } else {
      delete session.activeResponse;
      session.status = "error";
      session.error = "Tab Form không phản hồi sau 3 lần khôi phục.";
    }
    await set({ [SESSION_KEY]: session });
    return;
  }
  session.status = session.attemptToken ? "unresolved" : "recovering";
  session.recoveries = (session.recoveries || 0) + 1;
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  const tab = session.tabId ? await chrome.tabs.get(session.tabId).catch(() => null) : null;
  if (tab) await chrome.tabs.reload(tab.id).catch(() => wake(session));
  else await wake(session);
}

function initialize() {
  if (typeof chrome !== "undefined" && chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
  }
  chrome.alarms.create(ALARM.schedule, { periodInMinutes: 1 }); chrome.alarms.create(ALARM.watchdog, { periodInMinutes: 0.5 });
  return exclusive(async () => {
    const state = await load();
    await reconcileRuntimeState(state);
    if (state.session && (state.session.active || state.session.phase === "resting" || state.session.status === "running")) {
      if (state.session.notBefore) {
        if (Date.now() >= state.session.notBefore) {
          delete state.session.notBefore;
          state.session.phase = SESSION_PHASE.PREPARING;
          await set({ [SESSION_KEY]: state.session });
          await wake(state.session);
        } else if (chrome.alarms?.create) {
          const restAlarmName = `aks:rest-wake:${state.session.id}:${state.session.runEpoch || 1}`;
          const existingAlarms = await chrome.alarms.getAll().catch(() => []);
          const hasAlarm = existingAlarms.some(a => a.name === restAlarmName);
          if (!hasAlarm) {
            chrome.alarms.create(restAlarmName, { when: state.session.notBefore });
          }
        }
      } else if ((["starting", "running", "recovering"].includes(state.session.status) || state.session.attemptToken) && state.session.status !== "paused" && isSessionBusy(state.session)) {
        await wake(state.session);
      }
      if (state.session && state.session.active && state.session.status === "running") {
        if (state.session.outbox && state.session.outbox.state !== "acked") {
          console.log(`[STARTUP] Restoring un-acked outbox step: ${state.session.outbox.stepId} (state: ${state.session.outbox.state})`);
          // Refresh lease if expired
          const leaseDuration = 60000;
          if (!state.session.leaseExpiresAt || Date.now() >= state.session.leaseExpiresAt) {
            state.session.leaseExpiresAt = Date.now() + leaseDuration;
            if (state.session.outbox.envelope) state.session.outbox.envelope.leaseExpiresAt = state.session.leaseExpiresAt;
            if (state.session.outbox.stepDispatch) state.session.outbox.stepDispatch.leaseExpiresAt = state.session.leaseExpiresAt;
          }
          await set({ [SESSION_KEY]: state.session });
          if (!state.session.outbox.nextAttemptAt || Date.now() >= state.session.outbox.nextAttemptAt) {
            const outboxSession = state.session;
            const targetTab = state.session.tabId;
            queueMicrotask(() => {
              deliverOutboxStep(outboxSession, targetTab).catch((err) => {
                console.warn("[STARTUP] Failed to deliver restored outbox step:", err?.message || err);
              });
            });
          } else if (chrome.alarms?.create) {
            const readyAlarm = `aks:step-ready:${state.session.id}:${state.session.runEpoch || 1}:${state.session.outbox.stepId}`;
            chrome.alarms.create(readyAlarm, { when: state.session.outbox.nextAttemptAt });
            armShortStepAlarm(readyAlarm, state.session.outbox.nextAttemptAt);
          }
        }
      }
    }
    if (chrome.alarms?.getAll && chrome.alarms?.create) {
      try {
        const existingAlarms = await chrome.alarms.getAll();
        const existingNames = new Set((existingAlarms || []).map((a) => a.name));
        for (const sched of listSchedules(state.store)) {
          if (sched.active && sched.status === "active") {
            for (const item of (sched.items || [])) {
              if (item.status === "pending") {
                const name = `aks-sched:${sched.formId}:${item.id}`;
                if (!existingNames.has(name)) {
                  chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, item.at) });
                }
              }
            }
          }
        }
      } catch {}
    }
    await runSchedule();
  });
}

chrome.runtime.onInstalled.addListener(initialize); chrome.runtime.onStartup.addListener(initialize);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM.schedule || alarm.name?.startsWith("aks-sched:")) exclusive(runSchedule);
  if (alarm.name === ALARM.watchdog) exclusive(watchdog);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autoScanState?.newValue && !changes.autoScanState.newValue.isScanning) exclusive(finishOriginalScan);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  exclusive(async () => {
    const state = await load(), id = formId(tab.url);
    if (state.scan?.active && state.scan.formId === id) {
      state.scan.tabId = tabId;
      await set({ [KEYS.scan]: state.scan });
      if (state.scan.status !== "scanning") {
        send(tabId, { action: "aks:start-scan", scanId: state.scan.id });
      }
      return;
    }
    const session = state.session, valid = Boolean(id && id === session?.formId);
    if (session && isOperationLocked(session) && session.formId === id && valid && session.status !== "paused") {
      session.tabId = tabId;
      if (session.attemptToken || session.status === "unresolved") {
        // Chưa giải quyết kết quả gửi: tab hoàn tất tải không được tự đổi phiên thành running.
        session.heartbeatAt = Date.now();
        await set({ [SESSION_KEY]: session });
        await trace("background", "TAB_UPDATED_PENDING_CONFIRMATION", {
          tabId,
          formId: id,
          sessionId: session.id,
          attemptToken: maskToken(session.attemptToken)
        });
      } else {
        session.status = "running";
        session.heartbeatAt = Date.now();
        await set({ [SESSION_KEY]: session });
        send(tabId, { action: "aks:start", sessionId: session.id });
      }
    }
  });
});
chrome.tabs.onRemoved.addListener((tabId) => exclusive(async () => {
  const state = await load();
  if (state.scan?.tabId === tabId && state.scan.active) { state.scan.tabId = null; await set({ [KEYS.scan]: state.scan }); }
  if (state.session?.tabId === tabId && isOperationLocked(state.session) && state.session.status !== "paused") { state.session.tabId = null; state.session.status = state.session.attemptToken ? "error" : "recovering"; state.session.heartbeatAt = Date.now(); await set({ [SESSION_KEY]: state.session }); setTimeout(() => exclusive(() => wake(state.session)), 500); }
}));

async function acquireMainWorldModel(message = {}, sender = null) {
  const tabId = sender?.tab?.id || message.tabId;
  if (!tabId || !chrome.scripting?.executeScript) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          return window.FB_PUBLIC_LOAD_DATA_ || null;
        } catch {
          return null;
        }
      }
    });
    return results?.[0]?.result || null;
  } catch (error) {
    console.warn("[BACKGROUND] acquireMainWorldModel failed:", error?.message);
    return null;
  }
}

async function handlePageReady(message = {}, _sender = null) {
  const tabId = _sender?.tab?.id || message.tabId;
  const targetFormId = String(message.formId || (_sender?.tab?.url ? formId(_sender.tab.url) : ""));
  const state = await load(targetFormId);
  let session = state.session;

  console.log(`[BACKGROUND] aks:page-ready from tab ${tabId} for form ${targetFormId}, classification: ${message.classification}`);

  await trace("background", "PAGE_READY_RECEIVED", {
    senderTabId: tabId,
    formId: targetFormId,
    classification: message.classification
  });

  await trace("background", "CONFIRM_SESSION_SNAPSHOT", {
    incomingFormId: targetFormId,
    sessionFormId: session?.formId || "",
    sessionId: session?.id || "",
    status: session?.status || "",
    completed: session?.completed || 0,
    target: session?.target || 0,
    hasActiveResponse: Boolean(session?.activeResponse),
    responseId: session?.activeResponse?.responseId || "",
    activeResponsePhase: session?.activeResponse?.phase || "",
    attemptToken: maskToken(session?.attemptToken),
    submitToken: maskToken(session?.activeResponse?.submitToken),
    confirmedToken: maskToken(session?.confirmedToken)
  });

  const sessionFormId = session?.formId || (session?.formUrl ? formId(session.formUrl) : "");
  if (!session || (sessionFormId && targetFormId && sessionFormId !== targetFormId) || !isOperationLocked(session)) {
    await trace("background", "SESSION_GUARD_IDLE", {
      hasSession: Boolean(session),
      sessionFormId: session?.formId || "",
      targetFormId,
      isLocked: isOperationLocked(session)
    });
    return { action: "idle" };
  }

  if (session.status === "paused") {
    return { action: "paused", sessionId: session.id };
  }

  if (session.status === "cancelled" || session.status === "completed") {
    return { action: "idle" };
  }

  if ((session.active || session.phase === "resting" || session.status === "running") && session.notBefore && Date.now() < session.notBefore) {
    console.log(`[BACKGROUND] Session ${session.id} is resting until ${session.notBefore} (remaining: ${session.notBefore - Date.now()}ms). Blocking page-ready.`);
    return {
      action: "resting",
      sessionId: session.id,
      notBefore: session.notBefore,
      remainingMs: session.notBefore - Date.now()
    };
  }

  session.tabId = tabId;
  session.heartbeatAt = Date.now();
  if (tabId && typeof chrome !== "undefined" && chrome.tabs?.update) {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => null);
  }

  // 1. CONFIRMATION_PAGE
  if (message.classification === FORM_PAGE_TYPES.CONFIRMATION_PAGE) {
    if (session.outbox && session.outbox.stepType === STEP_TYPES.NAVIGATE_NEXT_RESPONSE) {
      const targetTabId = _sender?.tab?.id || session.tabId;
      deliverOutboxStep(session, targetTabId).catch(() => {});
      return session.outbox.stepDispatch;
    }
    let committed = session;
    if (session.attemptToken) {
      console.log(`[BACKGROUND] CONFIRMATION_PAGE xác nhận lượt gửi attemptToken=${session.attemptToken}. Commit...`);
      await trace("background", "COMMIT_ATTEMPT", {
        sessionId: session.id,
        token: maskToken(session.attemptToken),
        completed: session.completed
      });
      try {
        committed = await commit({ sessionId: session.id, token: session.attemptToken });
        await trace("background", "COMMIT_SUCCESS", {
          completedBefore: committed.completed - 1,
          completedAfter: committed.completed,
          target: committed.target
        });
      } catch (commitErr) {
        await trace("background", "COMMIT_FAILURE", {
          reason: commitErr?.message || String(commitErr)
        });
        throw commitErr;
      }
    } else if (session.confirmedToken) {
      await trace("background", "CONFIRM_IDEMPOTENT", {
        sessionId: session.id,
        confirmedToken: maskToken(session.confirmedToken),
        completed: session.completed
      });
    } else {
      await trace("background", "CONFIRM_TOKEN_MISMATCH", {
        sessionId: session.id,
        status: session.status,
        completed: session.completed
      });
    }
    const finished = committed.completed >= committed.target;
    if (!finished && committed.status === "running" && (!committed.activeResponse || committed.activeResponse.responseIndex !== committed.completed)) {
      if (FEATURE_FLAGS.backgroundStepSchedulerV2) {
        await trace("background", "SCHEDULER_V2_TRANSITION", {
          sessionId: committed.id,
          completed: committed.completed,
          target: committed.target
        });
      }
      const profile = getProfile(state.store, targetFormId);
      if (profile) {
        const canonicalQuestions = profile.questions || [];
        const nextIndex = committed.completed;
        const plan = generateAnswerPlan({
          profile,
          session: committed,
          canonicalQuestions,
          iterationIndex: nextIndex,
          totalIterations: committed.target || 1
        });
        committed.verifiedQuestionIds = [];
        committed.activeResponse = {
          responseId: crypto.randomUUID(),
          responseIndex: nextIndex,
          answerPlan: serializeAnswerPlan(plan),
          phase: "preparing",
          navigationToken: crypto.randomUUID(),
          navigationOccurred: false,
          navigationHistory: [],
          ledger: {},
          verifiedQuestionIds: [],
          updatedAt: Date.now()
        };
        await set({ [SESSION_KEY]: committed });
        await trace("background", "NEXT_RESPONSE_CREATED", {
          responseIndex: nextIndex,
          responseId: committed.activeResponse.responseId
        });
      }
    }
    return { action: "confirmed", committed, finished, formUrl: session.formUrl };
  }

  // 2. QUESTION_PAGE hoặc FINAL_SUBMIT_PAGE hoặc NAVIGATION_ONLY_PAGE
  if (
    message.classification === FORM_PAGE_TYPES.QUESTION_PAGE ||
    message.classification === FORM_PAGE_TYPES.FINAL_SUBMIT_PAGE ||
    message.classification === FORM_PAGE_TYPES.NAVIGATION_ONLY_PAGE
  ) {
    if (session.attemptToken) {
      const attemptAge = Date.now() - (session.activeResponse?.submittedAt || session.heartbeatAt || 0);
      if (message.classification === FORM_PAGE_TYPES.FINAL_SUBMIT_PAGE || attemptAge < 3500) {
        console.log(`[BACKGROUND] Lượt nộp đang chờ xác nhận (attemptToken=${session.attemptToken}, age=${attemptAge}ms). Bỏ qua duplicate page-ready.`);
        return { action: "submitting", sessionId: session.id, attemptToken: session.attemptToken };
      }

      console.warn(`[BACKGROUND] Có attemptToken nhưng trang lại là ${message.classification}. Báo lỗi từ chối.`);
      await trace("background", "SUBMIT_REJECTED_ON_NON_CONFIRMATION", {
        classification: message.classification,
        attemptToken: maskToken(session.attemptToken)
      });
      await rejectSubmit({ sessionId: session.id, token: session.attemptToken, error: "Google từ chối nộp: câu trả lời chưa hợp lệ." });
      return { action: "error", error: session.error };
    }

    const profile = getProfile(state.store, targetFormId);
    if (!profile) throw new Error("Không tìm thấy hồ sơ của Form.");

    const currentCompleted = session.completed || 0;

    // Kiểm tra xem activeResponse đã có và có thuộc cùng lượt chạy hiện tại không
    if (!session.activeResponse || session.activeResponse.responseIndex !== currentCompleted) {
      console.log(`[BACKGROUND] Khởi tạo activeResponse mới cho lượt ${currentCompleted + 1}/${session.target}`);
      const canonicalQuestions = profile.questions || [];
      const plan = generateAnswerPlan({
        profile,
        session,
        canonicalQuestions,
        iterationIndex: currentCompleted,
        totalIterations: session.target || 1
      });

      session.verifiedQuestionIds = [];
      delete session.activeStepId;
      delete session.activeStepType;
      delete session.leaseExpiresAt;
      delete session.cachedNextStep;
      delete session.lastAckedStepId;
      if (session.outbox && session.outbox.stepType === STEP_TYPES.NAVIGATE_NEXT_RESPONSE) {
        session.outbox.state = "acked";
      }
      session.activeResponse = {
        responseId: crypto.randomUUID(),
        responseIndex: currentCompleted,
        answerPlan: serializeAnswerPlan(plan),
        phase: "filling",
        navigationToken: crypto.randomUUID(),
        navigationOccurred: false,
        navigationHistory: [],
        ledger: {},
        verifiedQuestionIds: [],
        updatedAt: Date.now()
      };
    } else {
      console.log(`[BACKGROUND] Tái sử dụng AnswerPlan của lượt ${currentCompleted + 1} cho Section mới.`);
      session.activeResponse.phase = "filling";
      session.activeResponse.navigationToken = crypto.randomUUID();
      session.activeResponse.updatedAt = Date.now();
      if (session.outbox && session.outbox.stepType === STEP_TYPES.NAVIGATE_NEXT_RESPONSE) {
        session.outbox.state = "acked";
        delete session.activeStepId;
        delete session.activeStepType;
        delete session.cachedNextStep;
        delete session.activeEnvelope;
      }
    }

    const previousSignature = session.activeResponse?.lastPageSignature ||
      session.activeResponse?.navigationHistory?.slice(-1)[0]?.fromSignature || "";
    const isNewSection = Boolean(
      (previousSignature && message.pageSignature && previousSignature !== message.pageSignature) ||
      (session.activeResponse?.pendingNavigation && session.activeResponse.pendingNavigation.fromSignature !== message.pageSignature)
    );

    // Fast path: Idempotent dispatch if step lease is already active on this exact section
    if (
      !isNewSection &&
      session.active &&
      session.activeStepId &&
      session.leaseExpiresAt &&
      Date.now() < session.leaseExpiresAt
    ) {
      console.log(`[BACKGROUND] Active step ${session.activeStepId} already granted on signature ${message.pageSignature}, returning existing step`);
      if (session.cachedNextStep && (session.cachedNextStep.stepId === session.activeStepId || session.cachedNextStep.envelope?.stepId === session.activeStepId)) {
        const step = session.cachedNextStep;
        const targetTabId = _sender?.tab?.id || session.tabId;
        deliverOutboxStep(session, targetTabId).catch(() => {});
        return step;
      }
    }

    if (session.activeResponse) {
      if (isNewSection) {
        session.activeResponse.navigationOccurred = true;
        if (session.activeResponse.pendingNavigation) {
          if (!Array.isArray(session.activeResponse.navigationHistory)) {
            session.activeResponse.navigationHistory = [];
          }
          session.activeResponse.navigationHistory.push({
            at: Date.now(),
            fromSignature: session.activeResponse.pendingNavigation.fromSignature || previousSignature || "",
            toSignature: message.pageSignature || "",
            navigationToken: session.activeResponse.pendingNavigation.navigationToken || session.activeResponse.navigationToken
          });
          delete session.activeResponse.pendingNavigation;
        }
      }
      session.activeResponse.lastPageSignature = message.pageSignature || "";
    }

    // Transition lifecycle/phase qua Central Reducer
    const isFinalPage = message.classification === FORM_PAGE_TYPES.FINAL_SUBMIT_PAGE;
    const updatedSession = transitionSession(session, {
      type: "PAGE_READY",
      pageSignature: message.pageSignature,
      isFinalPage
    });
    // Backwards-compat: ensure status is "running" for legacy popup rendering
    updatedSession.status = "running";
    updatedSession.leaseExpiresAt = Date.now() + 60000;

    if (isNewSection) {
      console.log(`[BACKGROUND] Page signature changed from ${previousSignature} to ${message.pageSignature}, clearing old section active step`);
      delete updatedSession.activeStepId;
      delete updatedSession.activeStepType;
      delete updatedSession.cachedNextStep;
      delete updatedSession.activeEnvelope;
      delete updatedSession.activeTargetQuestion;
    }

    if (updatedSession.activeResponse && (message.buttons || message.hasNextButton !== undefined || message.hasSubmitButton !== undefined)) {
      updatedSession.activeResponse.buttons = {
        hasNext: Boolean(message.hasNextButton || message.buttons?.hasNext),
        hasSubmit: Boolean(message.hasSubmitButton || message.buttons?.hasSubmit)
      };
    }

    // Determine step type based on page classification
    let stepType = STEP_TYPES.INSPECT_PAGE;
    let stepPayload = {
      classification: message.classification,
      pageSignature: message.pageSignature
    };

    if (message.discoveredQuestions && Array.isArray(message.discoveredQuestions) && message.discoveredQuestions.length > 0 && updatedSession.activeResponse) {
      updatedSession.activeResponse.discoveredQuestions = message.discoveredQuestions;
      const unfilledIds = new Set();
      for (const dq of message.discoveredQuestions) {
        if (dq.isFilled === false) {
          const dqId = String(dq.id || dq.entryId || dq.itemId || "");
          if (dqId) {
            unfilledIds.add(dqId);
            unfilledIds.add(canonicalizeQuestionId(dqId));
          }
          if (dq.title) unfilledIds.add(dq.title);
        }
      }
      if (unfilledIds.size > 0) {
        updatedSession.activeResponse.verifiedQuestionIds = (updatedSession.activeResponse.verifiedQuestionIds || []).filter(
          (id) => !unfilledIds.has(id) && !unfilledIds.has(canonicalizeQuestionId(id))
        );
        updatedSession.verifiedQuestionIds = updatedSession.activeResponse.verifiedQuestionIds;
        if (updatedSession.activeResponse.ledger) {
          for (const uId of unfilledIds) {
            const canon = canonicalizeQuestionId(uId);
            if (updatedSession.activeResponse.ledger[canon] && updatedSession.activeResponse.ledger[canon].state !== LEDGER_QUESTION_STATE.SECTION_ACCEPTED_BY_GOOGLE) {
              delete updatedSession.activeResponse.ledger[canon];
            }
          }
        }
        if (!updatedSession.activeStepId || !updatedSession.leaseExpiresAt || Date.now() >= updatedSession.leaseExpiresAt) {
          delete updatedSession.activeStepId;
          delete updatedSession.activeStepType;
          delete updatedSession.cachedNextStep;
          delete updatedSession.activeEnvelope;
        }
      }
      const plan = deserializeAnswerPlan(updatedSession.activeResponse.answerPlan);
      const verifiedSet = new Set(updatedSession.activeResponse.verifiedQuestionIds || []);
      for (const dq of message.discoveredQuestions) {
        const dqId = String(dq.id || dq.entryId || dq.itemId || "");
        const canonId = canonicalizeQuestionId(dqId);
        if (!verifiedSet.has(dqId) && !verifiedSet.has(canonId) && !verifiedSet.has(dq.title)) {
          const planItem = plan.get(dqId) || plan.get(canonId) || plan.get(dq.title) || null;
          stepType = STEP_TYPES.FILL_ONE_QUESTION;
          stepPayload = {
            targetQuestion: dq,
            planItem,
            answerDelay: Number(updatedSession.answerDelay || 0)
          };
          updatedSession.activeTargetQuestion = dq;
          break;
        }
      }
    } else if (message.classification === FORM_PAGE_TYPES.NAVIGATION_ONLY_PAGE) {
      stepType = STEP_TYPES.CLICK_NEXT;
    } else if (message.classification === FORM_PAGE_TYPES.CONFIRMATION_PAGE) {
      stepType = STEP_TYPES.RECONCILE_CONFIRMATION;
    }

    session = updatedSession;

    // Idempotent dispatch if step lease is already active on this exact section
    if (
      !isNewSection &&
      session.active &&
      session.activeStepId &&
      session.leaseExpiresAt &&
      Date.now() < session.leaseExpiresAt
    ) {
      console.log(`[BACKGROUND] Active step ${session.activeStepId} already granted on signature ${message.pageSignature}, returning existing step`);
      if (session.cachedNextStep && (session.cachedNextStep.stepId === session.activeStepId || session.cachedNextStep.envelope?.stepId === session.activeStepId)) {
        let updatedEnvelope = session.cachedNextStep.envelope;
        if (updatedEnvelope) {
          updatedEnvelope = cloneEnvelopeWithRevision(updatedEnvelope, session.revision);
        }
        if (session.activeEnvelope) {
          session.activeEnvelope = cloneEnvelopeWithRevision(session.activeEnvelope, session.revision);
        } else if (updatedEnvelope) {
          session.activeEnvelope = updatedEnvelope;
        }
        session.cachedNextStep = Object.freeze({
          ...session.cachedNextStep,
          ...(updatedEnvelope ? { envelope: updatedEnvelope } : {})
        });
        if (session.outbox?.stepDispatch?.envelope) {
          session.outbox = {
            ...session.outbox,
            stepDispatch: Object.freeze({
              ...session.outbox.stepDispatch,
              envelope: updatedEnvelope || session.activeEnvelope
            })
          };
        }
        const step = session.cachedNextStep;
        const targetTabId = _sender?.tab?.id || session.tabId;
        deliverOutboxStep(session, targetTabId).catch(() => {});
        return step;
      }
      const fallbackStepType = (session.activeStepType === STEP_TYPES.FILL_ONE_QUESTION)
        ? STEP_TYPES.INSPECT_PAGE
        : (session.activeStepType || STEP_TYPES.INSPECT_PAGE);

      const fallbackPayload = {
        classification: message.classification,
        pageSignature: message.pageSignature
      };
      const fallbackEnvelope = session.activeEnvelope
        ? cloneEnvelopeWithRevision(session.activeEnvelope, session.revision)
        : createStepEnvelope({
            sessionId: session.id,
            responseId: session.activeResponse.responseId,
            responseIndex: session.activeResponse.responseIndex,
            runEpoch: session.runEpoch || 1,
            revision: session.revision || 1,
            stepId: session.activeStepId,
            stepType: fallbackStepType,
            leaseExpiresAt: session.leaseExpiresAt,
            payload: fallbackPayload
          });

      session.activeEnvelope = fallbackEnvelope;

      const fallbackDispatch = Object.freeze({
        action: "step-dispatch",
        stepId: session.activeStepId,
        stepType: fallbackStepType,
        envelope: fallbackEnvelope,
        payload: fallbackPayload
      });
      session.outbox = {
        ...session.outbox,
        stepDispatch: fallbackDispatch
      };
      const targetTabId = _sender?.tab?.id || session.tabId;
      await dispatchStepWithOutbox(session, session.activeStepId, fallbackStepType, fallbackEnvelope, fallbackDispatch, targetTabId);
      return fallbackDispatch;
    }

    const stepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const leaseExpiresAt = Date.now() + 60000;
    const envelope = createStepEnvelope({
      sessionId: updatedSession.id,
      responseId: updatedSession.activeResponse.responseId,
      responseIndex: updatedSession.activeResponse.responseIndex,
      runEpoch: updatedSession.runEpoch || 1,
      revision: updatedSession.revision || 1,
      stepId,
      stepType,
      leaseExpiresAt,
      payload: stepPayload
    });

    updatedSession.activeStepId = stepId;
    updatedSession.activeStepType = stepType;
    updatedSession.leaseExpiresAt = leaseExpiresAt;
    updatedSession.activeEnvelope = envelope;

    const stepDispatch = Object.freeze({
      action: "step-dispatch",
      stepId,
      stepType,
      envelope,
      payload: stepPayload
    });
    updatedSession.cachedNextStep = stepDispatch;

    // Proactive background outbox dispatch (II.2, Round 3)
    const targetTabId = _sender?.tab?.id || updatedSession.tabId;
    await dispatchStepWithOutbox(updatedSession, stepId, stepType, envelope, stepDispatch, targetTabId);

    await trace("background", "STEP_DISPATCHED", {
      sessionId: updatedSession.id,
      stepType,
      classification: message.classification,
      responseIndex: updatedSession.activeResponse.responseIndex,
      revision: updatedSession.revision,
      leaseExpiresAt: updatedSession.leaseExpiresAt
    });

    const finalDispatch = updatedSession.outbox?.stepDispatch || updatedSession.cachedNextStep || stepDispatch;
    return { ...finalDispatch, session: updatedSession };
  }

  return { action: "idle" };
}

async function checkpointNavigation(message = {}) {
  const state = await load();
  const session = state.session;
  if (!session || session.id !== message.sessionId) return null;

  if (session.activeResponse) {
    session.activeResponse.phase = "navigating";
    session.activeResponse.navigationToken = message.navigationToken || crypto.randomUUID();
    session.activeResponse.clickedAt = Date.now();
    session.activeResponse.pendingNavigation = {
      navigationToken: session.activeResponse.navigationToken,
      fromSignature: message.fromSignature || "",
      toSignature: message.toSignature || "",
      verifiedQuestionIdsForThisPage: message.verifiedQuestionIds || [],
      preparedAt: Date.now()
    };

    if (message.verifiedQuestionIds && Array.isArray(message.verifiedQuestionIds)) {
      if (!session.activeResponse.ledger) session.activeResponse.ledger = {};
      const isConfirmedNav = Boolean(message.fromSignature && message.toSignature && message.fromSignature !== message.toSignature);
      for (const qId of message.verifiedQuestionIds) {
        const canonId = canonicalizeQuestionId(qId);
        session.activeResponse.ledger[canonId] = {
          responseId: session.activeResponse.responseId,
          responseIndex: session.activeResponse.responseIndex,
          pageSignature: message.fromSignature || "",
          state: isConfirmedNav ? LEDGER_QUESTION_STATE.SECTION_ACCEPTED_BY_GOOGLE : LEDGER_QUESTION_STATE.LOCALLY_OBSERVED,
          observedAt: Date.now()
        };
      }
      const setIds = new Set([...(session.activeResponse.verifiedQuestionIds || []), ...message.verifiedQuestionIds]);
      session.activeResponse.verifiedQuestionIds = Array.from(setIds);
      session.verifiedQuestionIds = session.activeResponse.verifiedQuestionIds;
    }

    if (message.fromSignature && message.toSignature && message.fromSignature !== message.toSignature) {
      if (!Array.isArray(session.activeResponse.navigationHistory)) {
        session.activeResponse.navigationHistory = [];
      }
      session.activeResponse.navigationHistory.push({
        at: Date.now(),
        fromSignature: message.fromSignature,
        toSignature: message.toSignature,
        navigationToken: session.activeResponse.navigationToken
      });
    }
  }

  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  console.log(`[BACKGROUND] Checkpoint navigation chuẩn bị thành công token=${session.activeResponse?.navigationToken}`);
  return { ok: true, navigationToken: session.activeResponse?.navigationToken };
}

async function forceCancelPending(message = {}) {
  const state = await load(), session = state.session;
  if (!session || (message.sessionId && session.id !== message.sessionId)) return null;
  session.active = false;
  delete session.attemptToken;
  delete session.pendingAttempt;
  delete session.activeResponse;
  delete session.navigationToken;
  delete session.submitToken;
  session.status = "cancelled";
  session.error = "";
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  if (session.tabId) send(session.tabId, { action: "aks:stop", sessionId: session.id }, false);
  return session;
}

async function handlePauseAck(message = {}) {
  const state = await load(), session = state.session;
  if (!session || (message.sessionId && session.id !== message.sessionId)) return null;
  if (message.checkpoint) {
    session.checkpoint = message.checkpoint;
  }
  return await finalizePause(session);
}

async function handleSaveCheckpoint(message = {}) {
  const state = await load(), session = state.session;
  if (!session || session.id !== message.sessionId) return null;
  session.checkpoint = message.checkpoint || null;
  if (message.verifiedQuestionIds && Array.isArray(message.verifiedQuestionIds) && session.activeResponse) {
    const setIds = new Set([...(session.activeResponse.verifiedQuestionIds || []), ...message.verifiedQuestionIds]);
    session.activeResponse.verifiedQuestionIds = Array.from(setIds);
    session.verifiedQuestionIds = session.activeResponse.verifiedQuestionIds;
  }
  session.heartbeatAt = Date.now();
  await set({ [SESSION_KEY]: session });
  return session;
}

async function handleGetFingerprint() {
  const state = await load();
  const session = state.session;
  const hashes = await getFingerprintData();
  const manifest = typeof chrome !== "undefined" && chrome.runtime?.getManifest ? chrome.runtime.getManifest() : null;
  return {
    extensionId: typeof chrome !== "undefined" ? chrome.runtime?.id || "" : "",
    manifestVersion: manifest?.version || "4.0.15",
    buildId: "20260917.round11",
    runtimeNonce: coordinatorNonce,
    tabId: session?.tabId || null,
    lastHandshakeAt: session?.heartbeatAt || null,
    activeStep: session?.stepType || null,
    stepId: session?.stepId || null,
    runEpoch: session?.runEpoch || 1,
    leaseExpiresAt: session?.leaseExpiresAt || null,
    verifiedQuestionIds: session?.verifiedQuestionIds || [],
    hashes
  };
}

export async function handleReconcileOperation(message = {}, _sender = null) {
  const state = await load();
  const session = state.session;
  if (!session) return { ok: false, error: "NO_ACTIVE_SESSION" };

  const opId = message.operationId;
  const journal = message.journal || {};
  const phase = journal.sideEffectPhase || message.sideEffectPhase;

  // Check if this operation or submitToken was already committed
  const token = journal.submitToken || message.token;
  const tokenHash = token ? hashSubmitToken(token) : "";
  const rId = journal.envelope?.responseId || message.responseId || session.activeResponse?.responseId || "r0";
  const epoch = Number(journal.envelope?.runEpoch || message.runEpoch || session.runEpoch || 1);
  const targetOpId = opId || journal.stepId || message.stepId;

  session.committedKeys = session.committedKeys || [];
  session.committedRecords = session.committedRecords || [];

  const isCommitted = Boolean(
    (token && session.confirmedToken === token) ||
    (tokenHash && session.committedRecords.some((r) =>
      r.sessionId === session.id &&
      r.responseId === rId &&
      Number(r.runEpoch) === epoch &&
      r.submitTokenHash === tokenHash
    )) ||
    (targetOpId && session.committedRecords.some((r) =>
      r.sessionId === session.id &&
      r.responseId === rId &&
      Number(r.runEpoch) === epoch &&
      (r.operationId === targetOpId || r.stepId === targetOpId)
    ))
  );

  if (isCommitted) {
    return { ok: true, decision: "already_committed", committed: session };
  }

  // If side effect was never dispatched, it is safe to retry
  if (phase === "READY_TO_CLICK" || phase === "CLICK_INTENT_PERSISTED" || !phase) {
    return { ok: true, decision: "retry_click" };
  }

  if (phase === "DISPATCH_AMBIGUOUS" || phase === "DISPATCH_ATTEMPT_STARTED" || message.error === "UNRESOLVED_DISPATCH_CRASH") {
    session.status = "error";
    session.error = "UNRESOLVED_DISPATCH_CRASH";
    session.heartbeatAt = Date.now();
    await set({ [SESSION_KEY]: session });
    return {
      ok: true,
      decision: "needs_intervention",
      error: "UNRESOLVED_DISPATCH_CRASH"
    };
  }

  // If side effect was dispatched without proof of commit, prevent duplicate side effect
  return {
    ok: true,
    decision: "needs_intervention",
    error: "UNRESOLVED_SIDE_EFFECT: Side effect was dispatched without proof of commit. Awaiting intervention."
  };
}

async function handleStepAck(message = {}, _sender = null) {
  const state = await load();
  let session = state.session;
  if (!session) return null;

  if (session.status === "paused") {
    console.warn(`[STEP:ACK] Rejected ACK received while session is paused: stepId=${message?.stepId || message?.envelope?.stepId}`);
    throw new Error("SESSION_PAUSED_ACK_REJECTED");
  }

  if (_sender?.tab?.id) {
    session.tabId = _sender.tab.id;
  }

  // 1. Extract envelope
  const envelope = message.envelope || {
    sessionId: message.sessionId,
    responseId: message.responseId,
    responseIndex: message.responseIndex,
    runEpoch: message.runEpoch,
    revision: message.revision,
    stepId: message.stepId,
    stepType: message.stepType,
    leaseExpiresAt: message.leaseExpiresAt,
    payloadHash: message.payloadHash
  };

  // 2. Validate envelope: REJECT if missing ANY mandatory field!
  validateEnvelope(envelope);

  if (session.id !== envelope.sessionId) {
    throw new Error("SESSION_ID_MISMATCH");
  }

  // 3. Duplicate stepId or submit idempotency check (must be BEFORE activeStepId check)
  if (envelope.stepType === STEP_TYPES.CLICK_SUBMIT) {
    const token = message.submitToken || message.token || session.attemptToken || session.submitToken;
    const tokenHash = token ? hashSubmitToken(token) : "";
    const opId = envelope.operationId || envelope.stepId;
    const respId = envelope.responseId || session.activeResponse?.responseId || "r0";
    const epoch = Number(envelope.runEpoch || session.runEpoch || 1);
    const commitRecord = createCommitRecord({
      sessionId: session.id,
      responseId: respId,
      runEpoch: epoch,
      operationId: opId,
      stepId: envelope.stepId,
      submitTokenHash: tokenHash
    });
    const commitKey = canonicalizeCommitKey(commitRecord);

    session.committedKeys = session.committedKeys || [];
    session.committedRecords = session.committedRecords || [];

    const isCommitted = Boolean(
      session.committedKeys.includes(commitKey) ||
      (tokenHash && session.committedRecords.some((r) =>
        r.sessionId === session.id &&
        r.responseId === respId &&
        Number(r.runEpoch) === epoch &&
        r.submitTokenHash === tokenHash
      )) ||
      (session.committedRecords.some((r) =>
        r.sessionId === session.id &&
        r.responseId === respId &&
        Number(r.runEpoch) === epoch &&
        r.stepId === envelope.stepId &&
        r.operationId === opId
      )) ||
      (token && session.confirmedToken === token) ||
      (session.lastAckedStepId === envelope.stepId) ||
      (session.lastAck?.envelope?.stepId === envelope.stepId)
    );
    if (isCommitted) {
      console.log(`[BACKGROUND] Idempotent duplicate submit ACK for stepId=${envelope.stepId}`);
      return { ok: true, committed: session, outcome: "confirmed", idempotent: true };
    }
  }

  const isDuplicate = Boolean(
    (session.lastAckedStepId && session.lastAckedStepId === envelope.stepId) ||
    (session.lastAck?.envelope?.stepId === envelope.stepId)
  );

  if (isDuplicate) {
    const lastEnv = session.lastAck?.envelope;
    if (!lastEnv || !areEnvelopesIdentical(envelope, lastEnv)) {
      console.warn(`[STEP:ACK] Duplicate ACK envelope mismatch: stepId=${envelope.stepId}`);
      throw new Error("DUPLICATE_STEP_ACK_MISMATCH");
    }

    const dupAckData = reconstructAckData(message);
    const dupAckHash = computePayloadHash(dupAckData);
    const expectedHash = session.lastAck?.ackPayloadHash;
    if (expectedHash && dupAckHash && expectedHash !== dupAckHash) {
      console.warn(`[STEP:ACK] Duplicate ACK payload hash mismatch: stepId=${envelope.stepId}`);
      throw new Error("DUPLICATE_STEP_ACK_MISMATCH");
    }

    console.log(`[STEP:ACK] Idempotent duplicate ACK for stepId=${envelope.stepId}`);
    return { ok: true, nextStep: session.cachedNextStep || null, idempotent: true };
  }

  // 4. Non-duplicate active envelope validation
  if (!session.activeStepId) {
    throw new Error("NO_ACTIVE_STEP_TO_ACK");
  }
  if (envelope.stepId !== session.activeStepId) {
    console.warn(`[STEP:ACK] Stale stepId ACK: msg=${envelope.stepId} session=${session.activeStepId}`);
    throw new Error("STALE_STEP_ACK_REJECTED");
  }
  if (session.activeStepType && envelope.stepType !== session.activeStepType) {
    console.warn(`[STEP:ACK] Step type mismatch: msg=${envelope.stepType} session=${session.activeStepType}`);
    throw new Error("STEP_TYPE_MISMATCH_REJECTED");
  }
  if (session.activeResponse && envelope.responseId !== session.activeResponse.responseId) {
    console.warn(`[STEP:ACK] Stale responseId ACK: msg=${envelope.responseId} session=${session.activeResponse.responseId}`);
    throw new Error("STALE_RESPONSE_ACK_REJECTED");
  }
  if (session.activeResponse && Number(envelope.responseIndex) !== Number(session.activeResponse.responseIndex)) {
    throw new Error("STALE_RESPONSE_INDEX_REJECTED");
  }
  if (Number(envelope.runEpoch) !== Number(session.runEpoch || 1)) {
    console.warn(`[STEP:ACK] Stale epoch ACK: msg=${envelope.runEpoch} session=${session.runEpoch}`);
    throw new Error("STALE_EPOCH_ACK_REJECTED");
  }
  const isRevisionMatch = Number(envelope.revision) === Number(session.revision || 1) ||
    (session.activeEnvelope?.revision && Number(envelope.revision) === Number(session.activeEnvelope.revision));
  if (!isRevisionMatch) {
    console.warn(`[STEP:ACK] Revision mismatch: msg=${envelope.revision} session=${session.revision}`);
    throw new Error("REVISION_MISMATCH_REJECTED");
  }
  if (session.activeEnvelope && session.activeEnvelope.payloadHash && envelope.payloadHash !== session.activeEnvelope.payloadHash) {
    console.warn(`[STEP:ACK] Payload hash mismatch: msg=${envelope.payloadHash} session=${session.activeEnvelope.payloadHash}`);
    throw new Error("PAYLOAD_HASH_MISMATCH_REJECTED");
  }

  // 5. Lease expiration check (F5)
  if (session.leaseExpiresAt && Date.now() > session.leaseExpiresAt) {
    console.warn(`[STEP:ACK] Expired lease ACK: now=${Date.now()} expires=${session.leaseExpiresAt}`);
    throw new Error("LEASE_EXPIRED_ACK_REJECTED");
  }

  if (session.activeEnvelope && !areEnvelopesIdentical(envelope, session.activeEnvelope)) {
    console.warn(`[STEP:ACK] Active envelope mismatch: msg=${JSON.stringify(envelope)} session=${JSON.stringify(session.activeEnvelope)}`);
    throw new Error("ENVELOPE_MISMATCH_REJECTED");
  }

  // CAS: Canonical ACK data reconstruction & payload hash verification (non-duplicate only)
  if (!message.ackPayloadHash) {
    throw new Error("ACK_HASH_REQUIRED");
  }
  if (typeof message.ackPayloadHash !== "string" || !/^[0-9a-f]{64}$/i.test(message.ackPayloadHash)) {
    throw new Error("ACK_HASH_INVALID");
  }
  const canonicalAckData = reconstructAckData(message);
  const computedAckHash = computePayloadHash(canonicalAckData);
  if (message.ackPayloadHash !== computedAckHash) {
    console.warn(`[STEP:ACK] ackPayloadHash mismatch: msg=${message.ackPayloadHash} computed=${computedAckHash}`);
    throw new Error("ACK_PAYLOAD_HASH_MISMATCH_REJECTED");
  }

  // Clear step ack timeout alarm ONLY AFTER ACK is verified
  const ackTimeoutAlarm = `aks:step-ack-timeout:${session.id}:${session.runEpoch || 1}:${envelope.stepId}`;
  if (typeof chrome !== "undefined" && chrome.alarms?.clear) {
    chrome.alarms.clear(ackTimeoutAlarm).catch(() => {});
  }

  // Outcome: aborted/unloading -> do not halt session, allow reload recovery
  if (message.error === "PAGE_UNLOADING" || message.outcome === "aborted" || message.error === "STEP_ABORTED_BY_PAUSE") {
    console.log(`[STEP:ACK] Step ${envelope.stepId} aborted by page reload/pause, waiting for next page-ready.`);
    return { ok: true, recovering: true };
  }

  // Outcome: error (F8, IV.1) -> halt session
  if (message.ok === false || message.outcome === "error" || (message.error && message.error.includes("FILL_VERIFICATION_FAILED"))) {
    session.status = "error";
    session.error = String(message.error || "Lỗi thực thi bước.");
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.leaseExpiresAt;
    delete session.cachedNextStep;
    await set({ [SESSION_KEY]: session });
    return { ok: false, error: session.error, nextStep: null };
  }

  // Outcome: native_error (F9) -> transition to needs_intervention, stop further clicks
  if (message.outcome === "native_error") {
    session.status = "needs_intervention";
    session.error = String(message.errorText || message.error || "Google Forms hiển thị lỗi nhập liệu.");
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.leaseExpiresAt;
    delete session.cachedNextStep;
    await set({ [SESSION_KEY]: session });
    await trace("background", "STEP_ACK_NATIVE_ERROR", {
      sessionId: session.id,
      error: session.error
    });
    return { ok: true, nextStep: null, status: session.status, error: session.error };
  }

  // Outcome: confirmed submit -> atomic commit!
  if (envelope.stepType === STEP_TYPES.CLICK_SUBMIT && (message.outcome === "confirmed" || message.confirmationEvidence)) {
    const token = message.submitToken || message.token || session.attemptToken || session.submitToken;
    const tokenHash = token ? hashSubmitToken(token) : "";
    const opId = envelope.operationId || envelope.stepId;
    const respId = envelope.responseId || session.activeResponse?.responseId || "r0";
    const epoch = Number(envelope.runEpoch || session.runEpoch || 1);
    const commitRecord = createCommitRecord({
      sessionId: session.id,
      responseId: respId,
      runEpoch: epoch,
      operationId: opId,
      stepId: envelope.stepId,
      submitTokenHash: tokenHash
    });
    const commitKey = canonicalizeCommitKey(commitRecord);

    session.committedKeys = session.committedKeys || [];
    session.committedRecords = session.committedRecords || [];

    const isAlreadyCommitted = Boolean(
      session.committedKeys.includes(commitKey) ||
      (tokenHash && session.committedRecords.some((r) =>
        r.sessionId === session.id &&
        r.responseId === respId &&
        Number(r.runEpoch) === epoch &&
        r.submitTokenHash === tokenHash
      )) ||
      (session.confirmedToken && session.confirmedToken === token)
    );

    if (isAlreadyCommitted) {
      console.log(`[BACKGROUND] Submit commit key ${commitKey} already committed.`);
      return { ok: true, committed: session, outcome: "confirmed", idempotent: true };
    }

    session.committedKeys.push(commitKey);
    session.committedRecords.push(commitRecord);
    session.completed++;
    if (session.source === "csv") session.csvCursor++;
    session.confirmedToken = token;
    session.lastConfirmedAt = Date.now();

    if (session.scheduleItemId) {
      const schedule = getSchedule(state.store, session.formId);
      if (schedule) {
        const schedItem = schedule.items?.find((entry) => entry.id === session.scheduleItemId);
        if (schedItem) {
          schedItem.completed = session.completed;
          if (session.completed >= session.target) schedItem.status = "completed";
        }
        const allDone = schedule.items?.every((it) => it.status === "completed" || it.status === "cancelled");
        if (allDone) {
          schedule.active = false;
          schedule.status = "completed";
        }
        state.store = setSchedule(state.store, schedule);
        await set({ [STORE_KEY]: state.store });
      }
    }

    delete session.attemptToken;
    delete session.submitToken;
    delete session.verifiedQuestionIds;
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.cachedNextStep;
    delete session.leaseExpiresAt;
    session.lastAckedStepId = envelope.stepId;
    session.lastAck = {
      envelope: Object.freeze({ ...envelope }),
      ackPayloadHash: message.ackPayloadHash,
      outcome: "confirmed",
      submitToken: token
    };
    if (session.outbox && session.outbox.stepId === envelope.stepId) {
      session.outbox.state = "acked";
    }

    if (session.status === "pause_requested" || session.pauseAfterCommit) {
      session.status = "paused";
      session.active = false;
      delete session.pauseAfterCommit;
      delete session.activeResponse;
    } else {
      const isFinished = session.completed >= session.target;
      if (isFinished) {
        session.status = "completed";
        session.lifecycle = SESSION_LIFECYCLE.COMPLETED;
        session.active = false;
        delete session.activeResponse;
        if (session.scheduleItemId) {
          setTimeout(() => exclusive(runSchedule), 0);
        }
      } else {
        session.status = "running";
        session.active = true;
        if (session.restMode === "random") {
          const min = Math.max(0, Number(session.restMin) || 0);
          const max = Math.max(min, Number(session.restMax) || min);
          const restSec = min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min;
          if (restSec > 0) {
            session.notBefore = Date.now() + Math.round(restSec * 1000);
            session.phase = "resting";
            if (typeof chrome !== "undefined" && chrome.alarms?.create) {
              const restAlarmName = `aks:rest-wake:${session.id}:${session.runEpoch || 1}`;
              chrome.alarms.create(restAlarmName, { when: session.notBefore });
            }
          } else {
            session.phase = "preparing";
          }
        } else {
          session.phase = "preparing";
        }

        const profile = getProfile(state.store, session.formId);
        if (profile) {
          const nextIndex = session.completed;
          const plan = generateAnswerPlan({
            profile,
            session,
            canonicalQuestions: profile.questions || [],
            iterationIndex: nextIndex,
            totalIterations: session.target || 1
          });
          session.activeResponse = {
            responseId: crypto.randomUUID(),
            responseIndex: nextIndex,
            answerPlan: serializeAnswerPlan(plan),
            phase: session.phase === "resting" ? "resting" : "preparing",
            navigationToken: crypto.randomUUID(),
            navigationOccurred: false,
            navigationHistory: [],
            ledger: {},
            verifiedQuestionIds: [],
            updatedAt: Date.now()
          };
        }

        // Dedicated post-commit persistent navigation command
        const navStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const navLeaseExpiresAt = Date.now() + 60000;
        const navPayload = {
          navigationOperationId: `nav-${Date.now()}`,
          nextUrl: viewUrl(session.formUrl || profile?.formUrl || "")
        };
        const navEnvelope = createStepEnvelope({
          sessionId: session.id,
          responseId: session.activeResponse?.responseId || "r-next",
          responseIndex: session.completed,
          runEpoch: session.runEpoch || 1,
          revision: (session.revision || 1) + 1,
          stepId: navStepId,
          stepType: STEP_TYPES.NAVIGATE_NEXT_RESPONSE,
          leaseExpiresAt: navLeaseExpiresAt,
          payload: navPayload
        });
        session.revision = navEnvelope.revision;
        session.activeStepId = navStepId;
        session.activeStepType = STEP_TYPES.NAVIGATE_NEXT_RESPONSE;
        session.activeEnvelope = navEnvelope;
        session.leaseExpiresAt = navLeaseExpiresAt;
        const navDispatch = Object.freeze({
          action: "step-dispatch",
          stepId: navStepId,
          stepType: STEP_TYPES.NAVIGATE_NEXT_RESPONSE,
          envelope: navEnvelope,
          payload: navPayload
        });
        session.cachedNextStep = navDispatch;
        session.outbox = {
          stepId: navStepId,
          stepType: STEP_TYPES.NAVIGATE_NEXT_RESPONSE,
          envelope: navEnvelope,
          stepDispatch: navDispatch,
          state: "pending",
          attempt: 1,
          nextAttemptAt: Date.now(),
          lastDeliveryError: null
        };
      }
    }
    await set({ [SESSION_KEY]: session });
    updateExtensionBadge(session);
    return { ok: true, committed: session, outcome: "confirmed" };
  }

  // Outcome: pending submit (F10) -> transition to awaiting_confirmation, keep submitToken
  if (message.outcome === "pending") {
    session.phase = "awaiting_confirmation";
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.leaseExpiresAt;
    delete session.cachedNextStep;
    if (session.outbox && session.outbox.stepId === envelope.stepId) {
      session.outbox.state = "acked";
    }
    await set({ [SESSION_KEY]: session });
    await trace("background", "STEP_ACK_PENDING_SUBMIT", {
      sessionId: session.id,
      token: session.submitToken || session.attemptToken
    });
    return { ok: true, nextStep: null, phase: session.phase };
  }

  // Check FILL_ONE_QUESTION proof
  if (envelope.stepType === STEP_TYPES.FILL_ONE_QUESTION) {
    const newIds = [
      ...(Array.isArray(message.verifiedQuestionIds) ? message.verifiedQuestionIds : []),
      ...(Array.isArray(message.verifiedIds) ? message.verifiedIds : [])
    ];
    if (message.outcome !== "skipped") {
      const targetQ = message.targetQuestion || session.activeTargetQuestion;
      if (targetQ) {
        const targetId = canonicalizeQuestionId(targetQ.id || targetQ.entryId || targetQ.itemId);
        const verifiedCanonSet = new Set(newIds.map(canonicalizeQuestionId));
        if (!verifiedCanonSet.has(targetId)) {
          console.warn(`[STEP:ACK] Proof mismatch: targetId=${targetId} not in verifiedIds=${JSON.stringify(newIds)}`);
          throw new Error("PROOF_MISMATCH_REJECTED");
        }
      }
    }
  }

  // Valid ACK!
  session.lastAckedStepId = envelope.stepId;
  session.lastAck = {
    envelope: Object.freeze({ ...envelope }),
    ackPayloadHash: message.ackPayloadHash || computedAckHash
  };
  if (session.outbox && session.outbox.stepId === envelope.stepId) {
    session.outbox.state = "acked";
  }
  delete session.activeStepId;
  delete session.activeStepType;
  delete session.activeEnvelope;
  delete session.activeTargetQuestion;
  delete session.leaseExpiresAt;
  session.heartbeatAt = Date.now();

  if (message.pageSignature) {
    session.pageSignature = message.pageSignature;
  }

  if (session.activeResponse) {
    if (message.discoveredQuestions && Array.isArray(message.discoveredQuestions) && message.discoveredQuestions.length > 0) {
      session.activeResponse.discoveredQuestions = message.discoveredQuestions;
      const unfilledIds = new Set();
      for (const dq of message.discoveredQuestions) {
        if (dq.isFilled === false) {
          const dqId = String(dq.id || dq.entryId || dq.itemId || "");
          if (dqId) {
            unfilledIds.add(dqId);
            unfilledIds.add(canonicalizeQuestionId(dqId));
          }
          if (dq.title) unfilledIds.add(dq.title);
        }
      }
      if (unfilledIds.size > 0) {
        session.activeResponse.verifiedQuestionIds = (session.activeResponse.verifiedQuestionIds || []).filter(
          (id) => !unfilledIds.has(id) && !unfilledIds.has(canonicalizeQuestionId(id))
        );
        session.verifiedQuestionIds = session.activeResponse.verifiedQuestionIds;
        if (session.activeResponse.ledger) {
          for (const uId of unfilledIds) {
            const canon = canonicalizeQuestionId(uId);
            if (session.activeResponse.ledger[canon]) {
              delete session.activeResponse.ledger[canon];
            }
          }
        }
      }
    }
    if (message.buttons && typeof message.buttons === "object" && (message.buttons.hasNext !== undefined || message.buttons.hasSubmit !== undefined)) {
      session.activeResponse.buttons = message.buttons;
    }

    // Ledger only updated from strictly verified IDs (D.1, D.2, F7)
    const newIds = [
      ...(Array.isArray(message.newVerifiedIds) ? message.newVerifiedIds : []),
      ...(Array.isArray(message.verifiedIds) ? message.verifiedIds : []),
      ...(Array.isArray(message.verifiedQuestionIds) ? message.verifiedQuestionIds : [])
    ];
    if (newIds.length > 0) {
      const idSet = new Set([...(session.activeResponse.verifiedQuestionIds || []), ...newIds]);
      session.activeResponse.verifiedQuestionIds = Array.from(idSet);
      if (!session.activeResponse.ledger) session.activeResponse.ledger = {};
      for (const qId of newIds) {
        const canonId = canonicalizeQuestionId(qId);
        session.activeResponse.ledger[canonId] = {
          responseId: session.activeResponse.responseId,
          responseIndex: session.activeResponse.responseIndex,
          pageSignature: session.pageSignature || "",
          state: LEDGER_QUESTION_STATE.LOCALLY_OBSERVED,
          observedAt: Date.now()
        };
      }
    }
    session.verifiedQuestionIds = session.activeResponse.verifiedQuestionIds;
  }

  // Handle page validation recovery
  if (message.error === "SECTION_VALIDATION_FAILED" || message.error === "PAGE_VALIDATION_FAILED") {
    console.warn(`[BACKGROUND] ${message.error} nhận từ content. Điều phối điền lại câu hỏi thiếu.`);
    const missingQ = message.missingQuestion;
    if (missingQ && session.activeResponse) {
      const plan = deserializeAnswerPlan(session.activeResponse.answerPlan);
      const mId = String(missingQ.id || missingQ.entryId || missingQ.itemId || "");
      const canonId = canonicalizeQuestionId(mId);
      const planItem = plan.get(mId) || plan.get(canonId) || plan.get(missingQ.title) || null;
      
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = {
        targetQuestion: missingQ,
        planItem,
        answerDelay: Number(session.answerDelay || 0)
      };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.FILL_ONE_QUESTION,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.FILL_ONE_QUESTION;
      session.activeEnvelope = nextEnvelope;
      session.activeTargetQuestion = missingQ;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.FILL_ONE_QUESTION,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.FILL_ONE_QUESTION, nextEnvelope, nextStep, targetTabId);
    }
  }

  // Handle step outcomes
  if (message.outcome === "committed" && message.committed) {
    await trace("background", "STEP_ACK_COMMITTED", {
      sessionId: session.id,
      completed: message.committed.completed
    });
    delete session.cachedNextStep;
    await set({ [SESSION_KEY]: session });
    return { ok: true, verifiedCount: (session.verifiedQuestionIds || []).length };
  }

  if (message.needsPageReady || message.outcome === "navigated" || message.outcome === "section_changed") {
    if (session.activeResponse) {
      session.activeResponse.navigationOccurred = true;
      const pending = session.activeResponse.pendingNavigation || {};
      const confirmedIds = pending.verifiedQuestionIdsForThisPage || message.verifiedIds || [];
      if (!session.activeResponse.ledger) session.activeResponse.ledger = {};
      for (const qId of confirmedIds) {
        const canonId = canonicalizeQuestionId(qId);
        session.activeResponse.ledger[canonId] = {
          responseId: session.activeResponse.responseId,
          responseIndex: session.activeResponse.responseIndex,
          pageSignature: pending.fromSignature || message.fromSignature || "",
          state: LEDGER_QUESTION_STATE.SECTION_ACCEPTED_BY_GOOGLE,
          observedAt: Date.now()
        };
      }
      if (!Array.isArray(session.activeResponse.navigationHistory)) {
        session.activeResponse.navigationHistory = [];
      }
      session.activeResponse.navigationHistory.push({
        at: Date.now(),
        fromSignature: pending.fromSignature || message.fromSignature || "",
        toSignature: message.pageSignature || "",
        navigationToken: pending.navigationToken || session.activeResponse.navigationToken
      });
      delete session.activeResponse.pendingNavigation;
    }

    session = transitionSession(session, {
      type: "NAVIGATION_PREPARED",
      pageSignature: message.pageSignature,
      verifiedQuestionIds: session.verifiedQuestionIds
    });
    session.status = "navigating";
    await trace("background", "STEP_ACK_NAVIGATED", {
      sessionId: session.id,
      newSignature: message.pageSignature,
      classification: message.classification
    });
    delete session.cachedNextStep;
    await set({ [SESSION_KEY]: session });
    return { ok: true, verifiedCount: (session.verifiedQuestionIds || []).length };
  }

  // Outcome: ACK for NAVIGATE_NEXT_RESPONSE -> clean active step and wait for new form page-ready
  if (envelope.stepType === STEP_TYPES.NAVIGATE_NEXT_RESPONSE) {
    console.log(`[BACKGROUND] STEP_ACK_NAVIGATE_NEXT_RESPONSE: Step ${envelope.stepId} acked, waiting for next page-ready.`);
    session.status = "running";
    session.phase = "preparing";
    delete session.activeStepId;
    delete session.activeStepType;
    delete session.activeEnvelope;
    delete session.activeTargetQuestion;
    delete session.leaseExpiresAt;
    delete session.cachedNextStep;
    if (session.outbox && session.outbox.stepId === envelope.stepId) {
      session.outbox.state = "acked";
    }
    await trace("background", "STEP_ACK_NAVIGATE_NEXT_RESPONSE", {
      sessionId: session.id,
      stepId: envelope.stepId
    });
    await set({ [SESSION_KEY]: session });
    return { ok: true, status: session.status, phase: session.phase };
  }

  // Atomic Coordinator nextStep dispatch
  if (session.activeResponse) {
    const plan = deserializeAnswerPlan(session.activeResponse.answerPlan);
    const discovered = (session.activeResponse.discoveredQuestions && session.activeResponse.discoveredQuestions.length)
      ? session.activeResponse.discoveredQuestions
      : (message.discoveredQuestions || []);
    const verifiedSet = new Set(session.activeResponse.verifiedQuestionIds || []);
    const buttons = {
      hasNext: Boolean(message.hasNextButton || message.buttons?.hasNext || session.activeResponse.buttons?.hasNext),
      hasSubmit: Boolean(message.hasSubmitButton || message.buttons?.hasSubmit || session.activeResponse.buttons?.hasSubmit)
    };
    session.activeResponse.buttons = buttons;

    // Find next unfilled question on this page
    let nextQuestionToFill = null;
    for (const dq of discovered) {
      const dqId = String(dq.id || dq.entryId || dq.itemId || "");
      const canonId = canonicalizeQuestionId(dqId);
      if (!verifiedSet.has(dqId) && !verifiedSet.has(canonId) && !verifiedSet.has(dq.title)) {
        const planItem = plan.get(dqId) || plan.get(canonId) || plan.get(dq.title) || null;
        nextQuestionToFill = { question: dq, planItem };
        break;
      }
    }

    if (nextQuestionToFill) {
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = {
        targetQuestion: nextQuestionToFill.question,
        planItem: nextQuestionToFill.planItem,
        answerDelay: Number(session.answerDelay || 0)
      };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.FILL_ONE_QUESTION,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.FILL_ONE_QUESTION;
      session.activeEnvelope = nextEnvelope;
      session.activeTargetQuestion = nextQuestionToFill.question;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.FILL_ONE_QUESTION,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.FILL_ONE_QUESTION, nextEnvelope, nextStep, targetTabId);
    }

    // Handled atomic navigation transitions
    if (envelope.stepType === STEP_TYPES.PREPARE_NAVIGATION || message.stepType === STEP_TYPES.PREPARE_NAVIGATION) {
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = { action: "CLICK_NEXT" };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.CLICK_NEXT,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.CLICK_NEXT;
      session.activeEnvelope = nextEnvelope;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.CLICK_NEXT,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.CLICK_NEXT, nextEnvelope, nextStep, targetTabId);
    }

    if (envelope.stepType === STEP_TYPES.PREPARE_SUBMIT || message.stepType === STEP_TYPES.PREPARE_SUBMIT) {
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const token = message.submitToken || message.token || session.attemptToken || session.activeResponse?.submitToken || "";
      const stepPayload = { token };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.CLICK_SUBMIT,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.CLICK_SUBMIT;
      session.activeEnvelope = nextEnvelope;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.CLICK_SUBMIT,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.CLICK_SUBMIT, nextEnvelope, nextStep, targetTabId);
    }

    const profile = getProfile(state.store, session.formId);
    const canonicalQuestions = profile?.questions || [];
    const hasRequiredQuestions = canonicalQuestions.some((q) => q.required);
    const hasDiscoveredOrVerified = discovered.length > 0 || verifiedSet.size > 0;

    // If all questions filled on page, proceed to navigation or submit
    if ((buttons.hasSubmit || message.isFinalPage) && (hasDiscoveredOrVerified || !hasRequiredQuestions)) {
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = { isFinalPage: true };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.PREPARE_SUBMIT,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.PREPARE_SUBMIT;
      session.activeEnvelope = nextEnvelope;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.PREPARE_SUBMIT,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.PREPARE_SUBMIT, nextEnvelope, nextStep, targetTabId);
    } else if (buttons.hasNext) {
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = {
        hasNext: true,
        verifiedQuestionIds: Array.from(session.activeResponse?.verifiedQuestionIds || session.verifiedQuestionIds || [])
      };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.PREPARE_NAVIGATION,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.PREPARE_NAVIGATION;
      session.activeEnvelope = nextEnvelope;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.PREPARE_NAVIGATION,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.PREPARE_NAVIGATION, nextEnvelope, nextStep, targetTabId);
    } else {
      console.log(`[BACKGROUND] All questions on section verified but button state ambiguous (hasNext=${buttons.hasNext}, hasSubmit=${buttons.hasSubmit}). Inspecting DOM.`);
      const nextStepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const leaseExpiresAt = Date.now() + 60000;
      const stepPayload = {
        classification: message.classification,
        pageSignature: message.pageSignature
      };
      const nextEnvelope = createStepEnvelope({
        sessionId: session.id,
        responseId: session.activeResponse.responseId,
        responseIndex: session.activeResponse.responseIndex,
        runEpoch: session.runEpoch || 1,
        revision: session.revision || 1,
        stepId: nextStepId,
        stepType: STEP_TYPES.INSPECT_PAGE,
        leaseExpiresAt,
        payload: stepPayload
      });

      session.activeStepId = nextStepId;
      session.activeStepType = STEP_TYPES.INSPECT_PAGE;
      session.activeEnvelope = nextEnvelope;
      session.leaseExpiresAt = leaseExpiresAt;

      const nextStep = Object.freeze({
        action: "step-dispatch",
        stepId: nextStepId,
        stepType: STEP_TYPES.INSPECT_PAGE,
        envelope: nextEnvelope,
        payload: stepPayload
      });
      session.cachedNextStep = nextStep;
      await set({ [SESSION_KEY]: session });

      const targetTabId = _sender?.tab?.id || session.tabId;
      return await scheduleOrDispatchNextStep(session, nextStepId, STEP_TYPES.INSPECT_PAGE, nextEnvelope, nextStep, targetTabId);
    }
  }

  delete session.cachedNextStep;
  await set({ [SESSION_KEY]: session });
  return { ok: true, verifiedCount: (session.verifiedQuestionIds || []).length };
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  // Xác thực nguồn extension nội bộ
  if (_sender && _sender.id && typeof chrome !== "undefined" && chrome.runtime?.id && _sender.id !== chrome.runtime.id) {
    return false;
  }

  // Xác thực tab URL đối với các message từ trang Google Form
  const TAB_ACTIONS = new Set([
    "aks:page-ready", "aks:prepare", "aks:commit", "aks:reject-submit",
    "aks:checkpoint-navigation", "aks:heartbeat", "aks:fail", "aks:acquire-main-world-model",
    "aks:pause-ack", "aks:save-checkpoint", "aks:step-ack", "aks:rest-scheduled",
    "aks:reconcile-operation"
  ]);

  if (TAB_ACTIONS.has(message?.action) && _sender?.tab?.url) {
    if (!/^https:\/\/docs\.google\.com\/forms\//.test(_sender.tab.url)) {
      reply({ ok: false, error: "Nguồn gốc tab không được cấp phép." });
      return true;
    }
  }

  const actions = {
    "aks:get": () => getState(message.formId), "aks:ensure-profile": () => ensureProfile(message), "aks:save-profile": () => saveProfile(message), "aks:delete-form": () => removeForm(message),
    "aks:begin-scan": () => beginScan(message), "aks:scan-event": () => scanEvent(message), "aks:scan-prepare": () => prepareScan(message), "aks:cancel-scan": () => cancelScan(message),
    "aks:acquire-main-world-model": () => acquireMainWorldModel(message, _sender),
    "aks:page-ready": () => handlePageReady(message, _sender),
    "aks:checkpoint-navigation": () => checkpointNavigation(message),
    "aks:create": () => createSession(message.payload || {}), "aks:pause": () => control("paused"), "aks:resume": () => control("running"), "aks:cancel": () => control("cancelled"),
    "aks:pause-ack": () => handlePauseAck(message),
    "aks:save-checkpoint": () => handleSaveCheckpoint(message),
    "aks:force-cancel-pending": () => forceCancelPending(message),
    "aks:reconcile": () => reconcileRuntimeState().then(() => getState(message.formId)),
    "aks:schedule": () => saveSchedule(message.payload || {}), "aks:cancel-schedule": () => cancelSchedule(message), "aks:validate-schedule": () => validateSchedule(message),
    "aks:prepare": () => prepareSubmit(message), "aks:commit": () => commit(message), "aks:reject-submit": () => rejectSubmit(message), "aks:heartbeat": () => heartbeat(message), "aks:fail": () => failSession(message),
    "aks:get-fingerprint": () => handleGetFingerprint(),
    "aks:step-ack": () => handleStepAck(message, _sender),
    "aks:rest-scheduled": () => handleRestScheduled(message),
    "aks:reconcile-operation": () => handleReconcileOperation(message, _sender)
  };
  if (!actions[message?.action]) return false;
  exclusive(actions[message.action]).then((result) => {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      reply({ ok: true, ...result, result });
    } else {
      reply({ ok: true, result });
    }
  }).catch((error) => reply({ ok: false, error: error.message }));
  return true;
});

initialize();

export {
  createSession, beginScan, control, commit, rejectSubmit, failSession
};
