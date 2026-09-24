export const STORE_VERSION = 5;
export const STORE_KEY = "aksStoreV5";
export const SESSION_KEY = "aksSession";

export const SESSION_STATUS = Object.freeze({
  STARTING: "starting",
  RUNNING: "running",
  PAUSE_REQUESTED: "pause_requested",
  PAUSED: "paused",
  RESUMING: "resuming",
  RECOVERING: "recovering",
  NAVIGATING: "navigating",
  SUBMITTING: "submitting",
  CONFIRMING: "confirming",
  AWAITING_MANUAL: "awaiting_manual",
  UNRESOLVED: "unresolved",
  ERROR: "error",
  COMPLETED: "completed",
  CANCELLED: "cancelled"
});

export const SAFE_SESSION_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

const ACTIVE_STATUSES = new Set([
  "starting", "running", "pause_requested", "paused", "resuming", "recovering", "scanning",
  "awaiting_manual", "navigating", "submitting", "confirming", "unresolved"
]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idOf = (value) => {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("formId is required.");
  return id;
};
const record = (value) => object(value) ? { ...value } : {};

/** Profiles/schedules live here; the single running session stays at SESSION_KEY. */
export function createStore(seed = {}) {
  const source = object(seed) ? seed : {};
  return { ...source, version: STORE_VERSION, profiles: record(source.profiles), schedules: record(source.schedules) };
}

export const getProfile = (store, formId) => createStore(store).profiles[String(formId ?? "").trim()] || null;
export const getSchedule = (store, formId) => createStore(store).schedules[String(formId ?? "").trim()] || null;
export const listProfiles = (store) => Object.values(createStore(store).profiles);
export const listSchedules = (store) => Object.values(createStore(store).schedules);

export function setProfile(store, profile) {
  if (!object(profile)) throw new Error("profile is required.");
  const id = idOf(profile.formId), next = createStore(store);
  return { ...next, profiles: { ...next.profiles, [id]: { ...profile, formId: id } } };
}

export function createProfile(store, profile) {
  const id = idOf(profile?.formId);
  if (getProfile(store, id)) throw new Error(`Profile ${id} already exists.`);
  return setProfile(store, profile);
}

export function updateProfile(store, formId, patch) {
  const id = idOf(formId), current = getProfile(store, id);
  if (!current) throw new Error(`Profile ${id} does not exist.`);
  const value = typeof patch === "function" ? patch({ ...current }) : { ...current, ...(object(patch) ? patch : {}) };
  if (!object(value)) throw new Error("Profile update must return an object.");
  return setProfile(store, { ...value, formId: id });
}

export function deleteProfile(store, formId) {
  const id = idOf(formId), next = createStore(store), profiles = { ...next.profiles };
  delete profiles[id];
  return { ...next, profiles };
}

export function setSchedule(store, schedule) {
  if (!object(schedule)) throw new Error("schedule is required.");
  const id = idOf(schedule.formId), next = createStore(store);
  return { ...next, schedules: { ...next.schedules, [id]: { ...schedule, formId: id } } };
}

export function createSchedule(store, schedule) {
  const id = idOf(schedule?.formId);
  if (getSchedule(store, id)) throw new Error(`Schedule ${id} already exists.`);
  return setSchedule(store, schedule);
}

export function updateSchedule(store, formId, patch) {
  const id = idOf(formId), current = getSchedule(store, id);
  if (!current) throw new Error(`Schedule ${id} does not exist.`);
  const value = typeof patch === "function" ? patch({ ...current }) : { ...current, ...(object(patch) ? patch : {}) };
  if (!object(value)) throw new Error("Schedule update must return an object.");
  return setSchedule(store, { ...value, formId: id });
}

export function deleteSchedule(store, formId) {
  const id = idOf(formId), next = createStore(store), schedules = { ...next.schedules };
  delete schedules[id];
  return { ...next, schedules };
}

export function deleteForm(store, formId) {
  return deleteSchedule(deleteProfile(store, formId), formId);
}

export function isOperationLocked(operation) {
  if (!object(operation)) return false;
  if (operation.attemptToken || operation.pendingAttempt?.token || (operation.submit?.token && !operation.submit?.confirmedAt)) return true;
  if (["completed", "cancelled", "error", "failed"].includes(operation.status)) return false;
  if ([SESSION_LIFECYCLE.COMPLETED, SESSION_LIFECYCLE.CANCELLED, SESSION_LIFECYCLE.FAILED].includes(operation.lifecycle)) return false;
  if (operation.lifecycle === SESSION_LIFECYCLE.ACTIVE) return true;
  return operation.active === true || operation.isScanning === true || ACTIVE_STATUSES.has(operation.status);
}

const legacyWeights = (config) => Object.fromEntries((Array.isArray(config?.questionWeights) ? config.questionWeights : []).flatMap((entry) => {
  if (!object(entry)) return [];
  const key = String(entry.id || entry.questionId || entry.title || "").trim();
  if (!key) return [];
  const weights = Array.isArray(entry.weights) ? entry.weights.map(Number) : String(entry.weights ?? "").split(",").filter(Boolean).map(Number);
  const texts = Array.isArray(entry.texts) ? entry.texts : Array.isArray(entry.otherTexts) ? entry.otherTexts : [];
  return [[key, { ...entry, weights, texts }]];
}));

const legacyQuestions = (questions) => (Array.isArray(questions) ? questions : []).map((question) => ({
  ...question,
  required: Boolean(question?.required ?? question?.isRequired),
  options: (Array.isArray(question?.options) ? question.options : []).map((option) => object(option)
    ? { ...option, text: String(option.text ?? option.value ?? ""), other: Boolean(option.other ?? option.isOther) }
    : { text: String(option), other: false })
}));

const fromLegacy = (formId, questions, config) => ({
  formId,
  questions: legacyQuestions(questions),
  config: legacyWeights(config),
  screening: Array.isArray(config?.screeningAnswers) ? [...config.screeningAnswers] : [],
  screeningConfig: {
    enabled: Boolean(config?.enableScreening),
    answers: Array.isArray(config?.screeningAnswers) ? [...config.screeningAnswers] : [],
    answersByQuestion: record(config?.screeningAnswersDict),
    questions: Array.isArray(config?.loadedScreeningQuestions) ? [...config.loadedScreeningQuestions] : []
  },
  legacyConfig: object(config) ? { ...config } : {}
});

const mergeProfile = (older, newer) => {
  if (!older) return newer;
  if (!newer) return older;
  const merged = { ...older, ...newer, formId: newer.formId || older.formId };
  merged.config = { ...record(older.config), ...record(newer.config) };
  merged.ui = { ...record(older.ui), ...record(newer.ui) };
  if (!own(newer, "questions")) merged.questions = older.questions;
  if (!own(newer, "csv")) merged.csv = older.csv;
  if (!own(newer, "screening")) merged.screening = older.screening;
  return merged;
};

/** Convert a chrome.storage.local snapshot without deleting any source keys. */
export function migrateStore(snapshot = {}, options = {}) {
  const source = object(snapshot) ? snapshot : {};
  const persisted = object(source[STORE_KEY]) ? source[STORE_KEY] : {};
  let store = createStore(persisted);
  if (store.migration?.legacyImported) return store;

  const legacy = new Map();
  for (const [key, value] of Object.entries(source)) {
    let match = key.match(/^scannedQuestions_(.+)$/);
    if (match) { const id = match[1]; legacy.set(id, { ...legacy.get(id), questions: value }); continue; }
    match = key.match(/^formConfig_(.+)$/);
    if (match) { const id = match[1]; legacy.set(id, { ...legacy.get(id), config: value }); }
  }
  for (const [id, value] of legacy) {
    const imported = fromLegacy(id, value.questions, value.config);
    store = setProfile(store, mergeProfile(imported, getProfile(store, id)));
  }

  const singleton = object(source.aksProfile) && source.aksProfile.formId ? { ...source.aksProfile, formId: idOf(source.aksProfile.formId) } : null;
  if (singleton) store = setProfile(store, mergeProfile(getProfile(store, singleton.formId), singleton));

  let csvOwner = singleton?.formId || String(options.currentFormId || "").trim();
  if (!csvOwner && listProfiles(store).length === 1) csvOwner = listProfiles(store)[0].formId;
  const csvData = Array.isArray(source.csvData) ? source.csvData : null;
  if (csvData && csvOwner && getProfile(store, csvOwner)) {
    store = updateProfile(store, csvOwner, (profile) => own(profile, "csv") && profile.csv?.length ? profile : {
      ...profile, csv: [...csvData], csvName: profile.csvName || "Dữ liệu từ bản cũ"
    });
  }

  const singletonSchedule = object(source.aksSchedule) ? source.aksSchedule : null;
  let scheduleOwner = String(singletonSchedule?.formId || singleton?.formId || options.currentFormId || "").trim();
  if (!scheduleOwner && listProfiles(store).length === 1) scheduleOwner = listProfiles(store)[0].formId;
  if (singletonSchedule && scheduleOwner) {
    const imported = { ...singletonSchedule, formId: scheduleOwner };
    store = setSchedule(store, getSchedule(store, scheduleOwner) || imported);
  }

  const unassigned = { ...record(store.migration?.unassigned) };
  if (csvData && !csvOwner) unassigned.csvData = [...csvData];
  if (Array.isArray(source.lastScannedQuestions)) unassigned.lastScannedQuestions = [...source.lastScannedQuestions];
  if (object(source.lastFormConfig)) unassigned.lastFormConfig = { ...source.lastFormConfig };
  if (singletonSchedule && !scheduleOwner) unassigned.schedule = { ...singletonSchedule };
  store.migration = {
    ...record(store.migration), legacyImported: true,
    ...(Object.keys(unassigned).length ? { unassigned } : {})
  };
  return store;
}

/**
 * Reconciles question configuration after scanning or loading profile.
 * - Matches by stable question ID / entry ID.
 * - Preserves valid user-configured weights/texts.
 * - Generates balanced default distribution summing to 100% using Largest Remainder Method (Hare-Niemeyer).
 * - Other/Khác option gets 0%; 100% distributed to regular options.
 * - Required checkbox gets safe default with at least one option > 0.
 * - Re-maps weights when options change order or items are added/removed.
 * - Prunes removed questions.
 */
export function reconcileQuestionConfig(previousConfig = {}, scannedQuestions = [], previousQuestions = []) {
  const prevConf = object(previousConfig) ? previousConfig : {};
  const prevQs = Array.isArray(previousQuestions) ? previousQuestions : [];
  const prevQMap = new Map();
  for (const pq of prevQs) {
    if (pq?.id) prevQMap.set(String(pq.id), pq);
    if (pq?.title) prevQMap.set(String(pq.title), pq);
  }

  const result = {};

  for (const q of (Array.isArray(scannedQuestions) ? scannedQuestions : [])) {
    if (!q) continue;
    const qKey = String(q.id || q.title || "").trim();
    if (!qKey) continue;

    const existingEntry = prevConf[qKey] || prevConf[q.title] || null;
    const options = Array.isArray(q.options) ? q.options : [];
    const isChoice = ["radio", "select", "scale", "linear_scale"].includes(q.type);
    const isCheckbox = q.type === "checkbox";

    if (!isChoice && !isCheckbox) {
      // Free text, date, time, file, paragraph, etc.
      result[qKey] = existingEntry ? { ...existingEntry } : { weights: [], texts: [] };
      continue;
    }

    // Identify which options are "other"
    const isOptionOther = (opt) => {
      if (opt && typeof opt === "object") {
        if (opt.other || opt.isOther) return true;
        const txt = String(opt.text || "").trim().toLowerCase();
        return ["khac", "mục khác", "muc khac", "other"].includes(txt) || txt.startsWith("khác:") || txt.startsWith("muc khac:");
      }
      return false;
    };

    const getOptionText = (opt) => {
      if (typeof opt === "string") return opt;
      return String(opt?.text ?? opt?.value ?? "").trim();
    };

    // Case 1: Check if user already had a valid configuration for this question
    if (existingEntry && Array.isArray(existingEntry.weights) && existingEntry.weights.length > 0) {
      // Find previous question definition to see if options changed
      const oldQ = prevQMap.get(qKey) || prevQMap.get(q.title);
      const oldOptions = Array.isArray(oldQ?.options) ? oldQ.options : [];

      if (oldOptions.length > 0 && oldOptions.length === existingEntry.weights.length) {
        // Build map from old option text -> weight
        const textToWeight = new Map();
        oldOptions.forEach((opt, idx) => {
          textToWeight.set(getOptionText(opt), Number(existingEntry.weights[idx] || 0));
        });

        // Map weights to new options
        let allMatched = true;
        const remappedWeights = options.map((newOpt) => {
          const t = getOptionText(newOpt);
          if (textToWeight.has(t)) {
            return textToWeight.get(t);
          }
          allMatched = false;
          return 0;
        });

        const remapSum = remappedWeights.reduce((a, b) => a + b, 0);
        if (allMatched && (isCheckbox ? remapSum > 0 : Math.abs(remapSum - 100) < 0.01)) {
          result[qKey] = {
            ...existingEntry,
            weights: remappedWeights,
            texts: Array.isArray(existingEntry.texts) ? existingEntry.texts : []
          };
          continue;
        }
      }

      // If length matches directly and sum is valid:
      const curSum = existingEntry.weights.reduce((a, b) => a + Number(b || 0), 0);
      if (existingEntry.weights.length === options.length && (isCheckbox ? curSum > 0 : Math.abs(curSum - 100) < 0.01)) {
        result[qKey] = {
          ...existingEntry,
          weights: existingEntry.weights.map(Number),
          texts: Array.isArray(existingEntry.texts) ? existingEntry.texts : []
        };
        continue;
      }
    }

    // Case 2: New question or invalid/empty existing config -> Generate balanced defaults
    const N = options.length;
    if (N === 0) {
      result[qKey] = { weights: [], texts: [] };
      continue;
    }

    if (isChoice) {
      // Other options get 0; distribute 100 to regular options
      const regularIndices = [];
      options.forEach((opt, idx) => {
        if (!isOptionOther(opt)) regularIndices.push(idx);
      });

      const Nreg = regularIndices.length > 0 ? regularIndices.length : N;
      const targetIndices = regularIndices.length > 0 ? regularIndices : Array.from({ length: N }, (_, i) => i);

      const base = Math.floor(100 / Nreg);
      const remainder = 100 - base * Nreg;

      const weights = new Array(N).fill(0);
      targetIndices.forEach((optIdx, rank) => {
        weights[optIdx] = rank < remainder ? base + 1 : base;
      });

      result[qKey] = {
        weights,
        texts: existingEntry?.texts || []
      };
      if (q.title && String(q.title).trim() !== qKey) {
        result[String(q.title).trim()] = result[qKey];
      }
    } else if (isCheckbox) {
      // Checkbox: if required, at least one option > 0 (e.g. 100% on first regular option, or balanced)
      const weights = new Array(N).fill(0);
      const regularIdx = options.findIndex((opt) => !isOptionOther(opt));
      const chosenIdx = regularIdx >= 0 ? regularIdx : 0;
      weights[chosenIdx] = 100;

      result[qKey] = {
        weights,
        texts: existingEntry?.texts || []
      };
      if (q.title && String(q.title).trim() !== qKey) {
        result[String(q.title).trim()] = result[qKey];
      }
    }
  }

  return result;
}

/**
 * Pure state machine transition for active session lifecycle and Step Protocol.
 * Monotonic revision and single-writer CAS support.
 */
export function transitionSession(session, event = {}) {
  if (!object(session)) return session;

  // CAS / Revision check if expectedRevision is provided
  if (event.expectedRevision !== undefined && event.expectedRevision !== session.revision) {
    throw new Error(`STALE_STEP: REVISION_MISMATCH (expected ${event.expectedRevision}, current ${session.revision})`);
  }

  const type = String(event.type || "").toUpperCase();
  const at = Number(event.at) || Date.now();
  const next = { ...session, updatedAt: at };
  next.revision = (Number(session.revision) || 0) + 1;
  next.heartbeatAt = at;

  if (!next.lifecycle) next.lifecycle = SESSION_LIFECYCLE.ACTIVE;
  if (!next.phase) next.phase = SESSION_PHASE.PREPARING;

  switch (type) {
    case "REQUEST_PAUSE":
    case "PAUSE_REQUESTED":
      if (["running", "resuming", "starting"].includes(session.status) || session.lifecycle === SESSION_LIFECYCLE.ACTIVE) {
        next.status = SESSION_STATUS.PAUSE_REQUESTED;
        next.lifecycle = SESSION_LIFECYCLE.PAUSE_REQUESTED;
      }
      return next;

    case "PAUSE_ACK":
    case "PAUSED":
      next.status = SESSION_STATUS.PAUSED;
      next.lifecycle = SESSION_LIFECYCLE.PAUSED;
      next.active = false;
      if (event.checkpoint) {
        next.checkpoint = { ...event.checkpoint };
      }
      return next;

    case "RESUME":
    case "RESUME_START":
    case "RESUMING":
      if (session.status === SESSION_STATUS.RESUMING || session.status === SESSION_STATUS.RUNNING) {
        return session;
      }
      next.status = SESSION_STATUS.RESUMING;
      next.lifecycle = SESSION_LIFECYCLE.ACTIVE;
      next.phase = SESSION_PHASE.FILLING;
      next.active = true;
      next.error = "";
      next.runEpoch = (Number(session.runEpoch) || 1) + 1;
      if (!next.activeResponse && next.checkpoint?.responseIndex !== undefined) {
        next.activeResponse = {
          index: next.checkpoint.responseIndex,
          phase: next.checkpoint.phase || "resuming"
        };
      }
      return next;

    case "RUNNING":
      next.status = SESSION_STATUS.RUNNING;
      next.lifecycle = SESSION_LIFECYCLE.ACTIVE;
      next.active = true;
      return next;

    case "COMMIT_AND_PAUSE":
      if (session.attemptToken && event.token === session.attemptToken) {
        next.completed = (session.completed || 0) + 1;
        delete next.attemptToken;
      }
      next.status = SESSION_STATUS.PAUSED;
      next.lifecycle = SESSION_LIFECYCLE.PAUSED;
      next.active = false;
      return next;

    case "SET_CHECKPOINT":
      if (event.checkpoint) {
        next.checkpoint = { ...event.checkpoint };
      }
      return next;

    case "CANCEL":
    case "CANCELLED":
      next.status = SESSION_STATUS.CANCELLED;
      next.lifecycle = SESSION_LIFECYCLE.CANCELLED;
      next.active = false;
      return next;

    case "STEP_STARTED":
      if (event.phase) next.phase = event.phase;
      if (event.stepId) next.stepId = event.stepId;
      if (event.leaseOwner !== undefined) next.leaseOwner = event.leaseOwner;
      if (event.leaseDurationMs) next.leaseExpiresAt = at + Number(event.leaseDurationMs);
      return next;

    case "STEP_ACK":
      if (event.phase) next.phase = event.phase;
      if (event.pageSignature) next.pageSignature = event.pageSignature;
      if (Array.isArray(event.newVerifiedIds) && event.newVerifiedIds.length > 0) {
        const set = new Set(Array.isArray(next.verifiedQuestionIds) ? next.verifiedQuestionIds : []);
        event.newVerifiedIds.forEach((id) => set.add(String(id)));
        next.verifiedQuestionIds = Array.from(set);
      }
      return next;

    case "NAVIGATION_PREPARED":
      next.phase = SESSION_PHASE.NAVIGATING;
      next.status = "navigating";
      if (event.fromSignature) next.fromSignature = event.fromSignature;
      if (event.navigationToken) next.expectedNavigationToken = event.navigationToken;
      if (Array.isArray(event.verifiedQuestionIds)) {
        const set = new Set(Array.isArray(next.verifiedQuestionIds) ? next.verifiedQuestionIds : []);
        event.verifiedQuestionIds.forEach((id) => set.add(String(id)));
        next.verifiedQuestionIds = Array.from(set);
      }
      return next;

    case "PAGE_READY":
      if (next.phase === SESSION_PHASE.NAVIGATING) {
        next.phase = event.isFinalPage ? SESSION_PHASE.FINAL_READY : SESSION_PHASE.FILLING;
        next.status = "running";
      }
      if (event.pageSignature) next.pageSignature = event.pageSignature;
      return next;

    case "SUBMIT_PREPARED":
      next.phase = SESSION_PHASE.SUBMITTING;
      next.status = "submitting";
      if (event.attemptToken) next.attemptToken = event.attemptToken;
      return next;

    case "SUBMIT_COMMITTED":
      next.phase = SESSION_PHASE.CONFIRMING;
      next.status = "confirming";
      next.completed = (Number(next.completed) || 0) + 1;
      next.confirmedToken = next.attemptToken;
      delete next.attemptToken;
      return next;

    case "COMPLETED":
      next.lifecycle = SESSION_LIFECYCLE.COMPLETED;
      next.status = "completed";
      next.active = false;
      return next;

    case "FAILED":
      next.lifecycle = SESSION_LIFECYCLE.FAILED;
      next.status = "error";
      next.active = false;
      if (event.error) next.error = String(event.error);
      return next;

    default:
      return next;
  }
}

/**
 * Maps every possible session status to its exhaustive screen key.
 * Never returns null, empty, or undefined.
 */
export function resolveStatusScreenType(session) {
  if (!object(session) || !session.status) return "idle";
  const st = String(session.status).toLowerCase();

  switch (st) {
    case "starting":
    case "resuming":
    case "recovering":
      return "starting";
    case "running":
    case "filling":
      return "running";
    case "navigating":
      return "navigating";
    case "submitting":
    case "confirming":
      return "submitting";
    case "pause_requested":
      return "pause_requested";
    case "paused":
      return "paused";
    case "awaiting_manual":
      return "awaiting_manual";
    case "unresolved":
      return "unresolved";
    case "error":
      return session.attemptToken ? "unresolved" : "error";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "fallback_diagnostic";
  }
}

/**
 * Returns extension icon badge text and color according to session status.
 */
export function getBadgeInfo(session) {
  if (!object(session) || !session.status) return { text: "", color: "" };
  const st = String(session.status).toLowerCase();

  if (["running", "filling", "starting", "resuming", "navigating", "submitting", "confirming"].includes(st)) {
    const text = session.target > 0 ? `${session.completed || 0}/${session.target}` : "▶";
    return { text, color: "#3b82f6" };
  }
  if (st === "paused") {
    return { text: "Ⅱ", color: "#f59e0b" };
  }
  if (st === "pause_requested") {
    return { text: "…", color: "#f59e0b" };
  }
  if (["awaiting_manual", "unresolved", "error"].includes(st)) {
    return { text: "!", color: "#ef4444" };
  }
  return { text: "", color: "" };
}

/**
 * Initializes session for Event-Driven Persisted Step Protocol
 */
export function initStepSession(initial = {}) {
  const now = Date.now();
  return {
    id: initial.id || `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    formId: String(initial.formId || ""),
    formUrl: String(initial.formUrl || ""),
    tabId: Number(initial.tabId || 0),
    source: initial.source || "ratio",
    target: Number(initial.target || 1),
    completed: Number(initial.completed || 0),
    status: "starting",
    runEpoch: Number(initial.runEpoch || 1),
    stepId: `step-${now}-${Math.random().toString(36).slice(2, 8)}`,
    stepType: "INSPECT_PAGE",
    leaseOwner: null,
    leaseExpiresAt: 0,
    notBefore: now,
    verifiedQuestionIds: Array.isArray(initial.verifiedQuestionIds) ? [...initial.verifiedQuestionIds] : [],
    runtimeNonce: String(initial.runtimeNonce || `nonce-${now}-${Math.random().toString(36).slice(2, 8)}`),
    responseIndex: Number(initial.responseIndex || 0),
    pageSignature: "",
    attemptToken: null,
    submitToken: null,
    confirmedToken: null,
    checkpoint: null,
    createdAt: now,
    heartbeatAt: now,
    recoveries: 0,
    active: true
  };
}

/**
 * Atomic state and lease transition for Step Protocol
 */
export function transitionStep(session, patch = {}) {
  if (!object(session)) return session;
  const next = { ...session };
  const now = Date.now();

  if (patch.stepType !== undefined) {
    next.stepType = patch.stepType;
    next.stepId = `step-${now}-${Math.random().toString(36).slice(2, 8)}`;
  }
  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.leaseOwner !== undefined) {
    next.leaseOwner = patch.leaseOwner;
    const dur = Number(patch.leaseDurationMs || 10000);
    next.leaseExpiresAt = now + dur;
  }
  if (patch.notBefore !== undefined) {
    next.notBefore = patch.notBefore;
  }
  if (patch.pageSignature !== undefined) {
    next.pageSignature = patch.pageSignature;
  }
  if (Array.isArray(patch.newVerifiedIds) && patch.newVerifiedIds.length > 0) {
    const existing = new Set(Array.isArray(next.verifiedQuestionIds) ? next.verifiedQuestionIds : []);
    patch.newVerifiedIds.forEach((id) => existing.add(String(id)));
    next.verifiedQuestionIds = Array.from(existing);
  }
  if (patch.attemptToken !== undefined) {
    next.attemptToken = patch.attemptToken;
  }
  if (patch.responseIndex !== undefined) {
    next.responseIndex = patch.responseIndex;
  }
  if (patch.completed !== undefined) {
    next.completed = patch.completed;
  }
  next.heartbeatAt = now;
  return next;
}

export const SESSION_LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  PAUSE_REQUESTED: "pause_requested",
  PAUSED: "paused",
  CANCELLING: "cancelling",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed"
});

export const SESSION_PHASE = Object.freeze({
  PREPARING: "preparing",
  FILLING: "filling",
  VERIFYING: "verifying",
  NAVIGATING: "navigating",
  FINAL_READY: "final_ready",
  SUBMITTING: "submitting",
  CONFIRMING: "confirming",
  RECOVERING: "recovering",
  WAITING_FOR_PAGE: "waiting_for_page"
});




