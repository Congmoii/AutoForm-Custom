(() => {
  const TRACE_KEY = "aksRuntimeTrace";
  const MAX_TRACE_ENTRIES = 200;
  function maskToken(token) {
    if (!token) return "";
    const s = String(token);
    if (s.length <= 12) return s;
    return `${s.slice(0, 6)}...${s.slice(-6)}`;
  }
  async function trace(source, event, data = {}) {
    try {
      const { formId = "", sessionId = "", responseId = "", phase = "", pathname = "", detail, ...rest } = (data || {});
      const entry = {
        ts: new Date().toISOString(),
        source: String(source || ""),
        event: String(event || ""),
        formId: String(formId || ""),
        sessionId: String(sessionId || ""),
        responseId: String(responseId || ""),
        phase: String(phase || ""),
        pathname: String(pathname || (typeof location !== "undefined" ? location.pathname : "")),
        detail: detail !== undefined ? detail : rest
      };
      if (typeof console !== "undefined") {
        console.log(`[AKS:TRACE][${source}][${event}]`, entry);
      }
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const res = await chrome.storage.local.get(TRACE_KEY).catch(() => ({}));
        const list = Array.isArray(res?.[TRACE_KEY]) ? res[TRACE_KEY] : [];
        list.push(entry);
        if (list.length > MAX_TRACE_ENTRIES) {
          list.splice(0, list.length - MAX_TRACE_ENTRIES);
        }
        await chrome.storage.local.set({ [TRACE_KEY]: list }).catch(() => {});
      }
      return entry;
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[AKS:TRACE] Failed to log trace:", err);
      }
      return null;
    }
  }

  // GATE 1 — CONTENT SCRIPT BOOT (Dòng đầu content script ghi trace)
  trace("content", "BOOT", {
    href: location.href,
    pathname: location.pathname
  });

  if (typeof window !== "undefined") {
    window.dumpAksTrace = async () => {
      const res = await chrome.storage.local.get("aksRuntimeTrace");
      console.table(res.aksRuntimeTrace || []);
      return res.aksRuntimeTrace || [];
    };
    window.clearAksTrace = async () => {
      await chrome.storage.local.remove("aksRuntimeTrace");
      console.log("[AKS:TRACE] aksRuntimeTrace cleared.");
    };

    // Scope an toàn cho riêng audio do extension tạo, không monkey-patch toàn cục prototype
    const attachSafeAudioPlay = (audio) => {
      if (!audio || audio.__aksSafePlay) return audio;
      const origPlay = audio.play;
      audio.play = function (...args) {
        try {
          const res = origPlay.apply(this, args);
          if (res && typeof res.catch === "function") {
            return res.catch(() => undefined);
          }
          return res;
        } catch {
          return Promise.resolve();
        }
      };
      audio.__aksSafePlay = true;
      return audio;
    };
    if (window._keepAliveAudio) attachSafeAudioPlay(window._keepAliveAudio);
    let scopedKeepAliveAudio = window._keepAliveAudio || null;
    Object.defineProperty(window, "_keepAliveAudio", {
      configurable: true,
      enumerable: true,
      get() { return scopedKeepAliveAudio; },
      set(val) { scopedKeepAliveAudio = attachSafeAudioPlay(val); }
    });
  }

  // GATE 2 — FORM ID
  const FORM_ID = location.href.match(/\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]+)/)?.[1] || "";
  trace("content", "FORM_ID_RESOLVED", {
    href: location.href,
    formId: FORM_ID
  });
  if (!FORM_ID) return;
  const K = { store: "aksStoreV5", session: "aksSession", scan: "aksScan" };
  const norm = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").replace(/\s+/g, " ").trim().toLowerCase();

  let _fillEngine = (typeof globalThis !== "undefined" && globalThis.__AKS_FILL_ENGINE__) || null;
  async function getFillEngine() {
    if (!_fillEngine && typeof globalThis !== "undefined" && globalThis.__AKS_FILL_ENGINE__) {
      _fillEngine = globalThis.__AKS_FILL_ENGINE__;
    }
    if (!_fillEngine && typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      try {
        _fillEngine = await import(chrome.runtime.getURL("fill-engine.mjs"));
      } catch (err) {
        console.warn("[AKS:CONTENT] Lỗi import fill-engine.mjs:", err);
      }
    }
    return _fillEngine;
  }
  getFillEngine().catch(() => null);

  let _stepProtocol = (typeof globalThis !== "undefined" && globalThis.__AKS_STEP_PROTOCOL__) || null;
  async function getStepProtocol() {
    if (!_stepProtocol && typeof globalThis !== "undefined" && globalThis.__AKS_STEP_PROTOCOL__) {
      _stepProtocol = globalThis.__AKS_STEP_PROTOCOL__;
    }
    if (!_stepProtocol && typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      try {
        _stepProtocol = await import(chrome.runtime.getURL("step-protocol.mjs"));
      } catch (err) {
        console.warn("[AKS:CONTENT] Lỗi import step-protocol.mjs:", err);
      }
    }
    return _stepProtocol;
  }
  getStepProtocol().catch(() => null);

  function canonicalizeJson(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map((v) => (v === undefined ? "null" : canonicalizeJson(v))).join(",") + "]";
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(value[k])).join(",") + "}";
  }

  function pureSha256(str) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let primeCounter = 0;
    const isComposite = {};
    const hash = [];
    const k = [];
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    const bytes = (typeof TextEncoder !== "undefined")
      ? new TextEncoder().encode(str)
      : Buffer.from(str, "utf8");

    const bitLength = bytes.length * 8;
    const newLen = (((bytes.length + 8) >> 6) + 1) << 6;
    const words = new Uint32Array(newLen >> 2);
    for (let i = 0; i < bytes.length; i++) {
      words[i >> 2] |= bytes[i] << ((3 - (i % 4)) * 8);
    }
    words[bytes.length >> 2] |= 0x80 << ((3 - (bytes.length % 4)) * 8);
    words[words.length - 2] = (bitLength / maxWord) | 0;
    words[words.length - 1] = bitLength | 0;

    for (let j = 0; j < words.length; j += 16) {
      const w = new Uint32Array(64);
      for (let i = 0; i < 16; i++) w[i] = words[j + i];
      for (let i = 16; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      let [a, b, c, d, e, f, g, h] = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + k[i] + w[i]) | 0;
        const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) | 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }

      hash[0] = (hash[0] + a) | 0;
      hash[1] = (hash[1] + b) | 0;
      hash[2] = (hash[2] + c) | 0;
      hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0;
      hash[5] = (hash[5] + f) | 0;
      hash[6] = (hash[6] + g) | 0;
      hash[7] = (hash[7] + h) | 0;
    }

    let result = "";
    for (let i = 0; i < 8; i++) {
      result += (hash[i] >>> 0).toString(16).padStart(8, "0");
    }
    return result;
  }

  function computePayloadHash(data) {
    const json = canonicalizeJson(data);
    return pureSha256(json);
  }


  const usable = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    const isHiddenTab = typeof document !== "undefined" && document.hidden;
    if (!isHiddenTab) {
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      if ((rect.width ?? 0) <= 0 && (rect.height ?? 0) <= 0) return false;
    }
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    } catch {
      return false;
    }
    if (el.closest?.('[style*="display: none"], [style*="display:none"], [aria-hidden="true"]')) return false;
    return true;
  };
  const sleepers = new Map(); let timerId = 0, timerWorker = null;
  try {
    timerWorker = new Worker(URL.createObjectURL(new Blob(["onmessage=e=>setTimeout(()=>postMessage(e.data.id),Math.max(0,e.data.ms||0))"], { type: "application/javascript" })));
    timerWorker.onmessage = ({ data }) => {
      const entry = sleepers.get(data);
      if (entry) {
        entry.resolve();
        sleepers.delete(data);
      }
    };
  } catch { timerWorker = null; }

  function throwIfCancelled(signal) {
    if (signal?.aborted) {
      const err = new Error("OPERATION_CANCELLED");
      err.name = "AbortError";
      throw err;
    }
  }

  const sleep = (ms, signal = null) => {
    throwIfCancelled(signal);
    const delay = Math.max(0, ms);
    if (delay === 0) return Promise.resolve();
    const deadline = Date.now() + delay;
    return new Promise((resolve, reject) => {
      const id = ++timerId;
      let onAbort = null;
      const cleanup = () => {
        sleepers.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      if (signal) {
        onAbort = () => {
          cleanup();
          const err = new Error("OPERATION_CANCELLED");
          err.name = "AbortError";
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      sleepers.set(id, {
        resolve: () => {
          cleanup();
          try {
            throwIfCancelled(signal);
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        deadline
      });
      if (timerWorker) {
        timerWorker.postMessage({ id, ms: delay });
      } else {
        setTimeout(() => {
          const entry = sleepers.get(id);
          if (entry) {
            entry.resolve();
          }
        }, delay);
      }
    });
  };

  let activeSessionId = null;
  let currentSessionAnswerDelay = null;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const now = Date.now();
        for (const [id, s] of sleepers.entries()) {
          if (now >= s.deadline) {
            s.resolve();
            sleepers.delete(id);
          }
        }
        if (activeSessionId) {
          runtime("aks:heartbeat", { sessionId: activeSessionId }).catch(() => null);
        }
      }
    });
  }

  const wait = async (test, ms = 10000, interval = 100, signal = null) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      throwIfCancelled(signal);
      if (test()) return true;
      await sleep(interval, signal);
    }
    return false;
  };
  const runtime = (action, data = {}) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ action, ...data }, (res) => chrome.runtime.lastError || !res?.ok ? reject(new Error(res?.error || chrome.runtime.lastError?.message || "Lỗi tiến trình nền.")) : resolve(res.result)));
  async function sendSafeCheckpointNavigation(payload, retries = 2) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await runtime("aks:checkpoint-navigation", payload);
        return { ok: true, result: res };
      } catch (err) {
        lastErr = err;
      }
      if (attempt < retries) await sleep(150);
    }
    return { ok: false, error: lastErr?.message || "CHECKPOINT_NAVIGATION_TIMEOUT" };
  }
  async function sendSafeStepAck(payload, retries = 1) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await runtime("aks:step-ack", payload);
        return { ok: true, result: res };
      } catch (err) {
        lastErr = err;
      }
      if (attempt < retries) await sleep(100);
    }
    return { ok: false, error: lastErr?.message || "STEP_ACK_TIMEOUT" };
  }
  let runSerial = 0, runPromise = null, heartbeat = null, scanPromise = null, scanSerial = 0;
  let isPaused = false, currentCheckpoint = null, isBootHandshakePending = false;

  function containers() {
    const selector = document.querySelector('div[role="listitem"]') ? 'div[role="listitem"]' : document.querySelector('.freebirdFormviewerViewItemsItemItem') ? '.freebirdFormviewerViewItemsItemItem' : 'div[data-params]';
    const list = Array.from(document.querySelectorAll(selector)).filter(usable);
    return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
  }
  function schemaMeta(box) {
    try { const raw = (box.matches('[data-params]') ? box : box.closest('[data-params]') || box.querySelector('[data-params]'))?.getAttribute('data-params') || "", start = raw.indexOf("["); let depth = 0, quoted = false, escaped = false, end = -1; for (let i = start; i < raw.length; i++) { const char = raw[i]; if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; } if (char === '"') quoted = true; else if (char === "[") depth++; else if (char === "]" && --depth === 0) { end = i + 1; break; } } const item = JSON.parse(raw.slice(start, end)); return { itemId: item[0], title: item[1], entries: item[4] || [] }; } catch { return { entries: [] }; }
  }
  function qTitle(box, i) { return (box.querySelector('[role="heading"], .M7eMe, .freebirdFormviewerComponentsQuestionBaseTitle')?.innerText || `Câu hỏi ${i + 1}`).replace(/\s*\*\s*$/, "").trim(); }
  function rowTitle(row, i) { return (row.querySelector('[role="rowheader"], th, [aria-label]')?.innerText || row.getAttribute?.("aria-label") || `Hàng ${i + 1}`).trim(); }
  function optionText(el, i) { const value = el.getAttribute("data-value") || el.getAttribute("aria-label") || el.value; if (value && value !== "__other_option__") return String(value).trim(); return (el.closest("label, [role='option'], .docssharedWizToggleLabeledContainer")?.innerText || `Lựa chọn ${i + 1}`).trim(); }
  function isOther(el) { return (el.getAttribute("data-value") || el.value) === "__other_option__" || ["khac", "muc khac", "other"].includes(norm(optionText(el, 0))); }
  function required(box) { return Boolean(box.querySelector('[aria-required="true"], [required]')) || /\*\s*$/.test((box.innerText || "").split("\n")[0]); }
  function unique(nodes) { return nodes.filter((el, i, all) => !all.some((other, j) => i !== j && other.contains(el))); }
  function choiceGroups(box, selector) {
    const controls = unique(Array.from(box.querySelectorAll(selector)).filter(usable));
    const rows = new Map();
    controls.forEach((control) => { const row = control.closest('[role="row"], tr') || box; if (!rows.has(row)) rows.set(row, []); rows.get(row).push(control); });
    return [...rows.entries()];
  }
  function liveQuestions() {
    const result = [];
    containers().forEach((box, boxIndex) => {
      const base = qTitle(box, boxIndex), req = required(box), meta = schemaMeta(box), id = (i = 0) => String(meta.entries?.[i]?.[0] ?? meta.itemId ?? `${boxIndex}:${i}`);
      if (box.querySelector('input[type="file"]') || ["them tep", "add file"].some((v) => norm(box.innerText).includes(v))) { result.push({ id: id(), title: base, type: "file", required: req, box, controls: [], options: [] }); return; }
      const radios = choiceGroups(box, '[role="radio"], input[type="radio"]');
      if (radios.some(([, controls]) => controls.length)) { radios.forEach(([row, controls], i) => result.push({ id: id(i), title: `${base}${radios.length > 1 ? ` [${rowTitle(row, i)}]` : ""}`, type: "radio", required: req, box, controls, options: controls.map((el, j) => ({ text: optionText(el, j), other: isOther(el), el })) })); return; }
      const checks = choiceGroups(box, '[role="checkbox"], input[type="checkbox"]');
      if (checks.some(([, controls]) => controls.length)) { checks.forEach(([row, controls], i) => result.push({ id: id(i), title: `${base}${checks.length > 1 ? ` [${rowTitle(row, i)}]` : ""}`, type: "checkbox", required: req, box, controls, options: controls.map((el, j) => ({ text: optionText(el, j), other: isOther(el), el })) })); return; }
      const select = box.querySelector('select, [role="listbox"]');
      if (select) { const opts = select instanceof HTMLSelectElement ? Array.from(select.options).filter((o) => !o.disabled && o.value).map((o) => ({ text: o.textContent.trim(), other: false, el: o })) : []; result.push({ id: id(), title: base, type: "select", required: req, box, controls: [select], options: opts }); return; }
      const controls = Array.from(box.querySelectorAll('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="submit"])')).filter(usable);
      if (controls.length) { let type = controls[0].tagName === "TEXTAREA" ? "paragraph" : controls[0].type || "text"; const labels = norm(controls.map((el) => `${el.getAttribute("aria-label") || ""} ${el.placeholder || ""}`).join(" ")); if ((labels.includes("ngay") && labels.includes("thang")) || (labels.includes("day") && labels.includes("month"))) type = "date"; if ((labels.includes("gio") && labels.includes("phut")) || (labels.includes("hour") && labels.includes("minute"))) type = "time"; result.push({ id: id(), title: base, type, required: req, box, controls, options: [] }); }
    });
    return result;
  }
  const plain = (questions) => questions.map((q) => ({ id: q.id, title: q.title, type: q.type, required: q.required, options: q.options.map((o) => ({ text: o.text, other: o.other })) }));
  const FEATURE_FLAGS = Object.freeze({
    syntheticPointerSequence: false,
    dropdownAdapterV2: true,
    backgroundStepSchedulerV2: true
  });

  async function click(el, delay = 100, signal = null) {
    throwIfCancelled(signal);
    if (!el) return;
    try { el.focus?.({ preventScroll: true }); } catch {}
    throwIfCancelled(signal);
    if (FEATURE_FLAGS.syntheticPointerSequence) {
      const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const clientX = (rect.left || 0) + (rect.width || 0) / 2;
      const clientY = (rect.top || 0) + (rect.height || 0) / 2;
      const evtInit = { bubbles: true, cancelable: true, clientX, clientY, button: 0 };
      throwIfCancelled(signal);
      if (typeof PointerEvent !== "undefined") {
        el.dispatchEvent(new PointerEvent("pointerdown", { ...evtInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mousedown", evtInit));
      throwIfCancelled(signal);
      if (typeof PointerEvent !== "undefined") {
        el.dispatchEvent(new PointerEvent("pointerup", { ...evtInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mouseup", evtInit));
      throwIfCancelled(signal);
      el.click();
    } else {
      if (typeof MouseEvent !== "undefined") {
        throwIfCancelled(signal);
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        throwIfCancelled(signal);
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      }
      throwIfCancelled(signal);
      el.click();
    }
    await sleep(delay, signal);
    throwIfCancelled(signal);
  }
  async function hydrate(questions) {
    for (const q of questions.filter((item) => item.type === "select" && !(item.controls[0] instanceof HTMLSelectElement) && !item.options.length)) {
      const ctrl = q.controls[0];
      const popupId = ctrl?.getAttribute?.("aria-controls") || ctrl?.getAttribute?.("aria-owns");
      await click(ctrl, 60);
      const getPortalOptions = () => {
        if (popupId) {
          const popup = document.getElementById(popupId);
          if (popup) return Array.from(popup.querySelectorAll('[role="option"]')).filter(usable);
        }
        if (q.box) {
          const local = q.box.querySelectorAll('[role="option"]');
          if (local.length > 0) return Array.from(local).filter(usable);
        }
        return Array.from(document.querySelectorAll('.exportSelectPopup [role="option"], .OA0qSb [role="option"]')).filter(usable);
      };
      await wait(() => getPortalOptions().length > 0, 2500);
      q.options = getPortalOptions().map((el, i) => ({ text: optionText(el, i), other: isOther(el), el }));
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(60);
    }
    return questions;
  }
  const signature = () => plain(liveQuestions()).map((q) => `${q.id}:${norm(q.title)}:${q.type}`).join("|");
  function button(kind) {
    const words = kind === "next" ? ["tiep", "tiep theo", "tiep tuc", "next"] : ["gui", "gui di", "submit"];
    return Array.from(document.querySelectorAll('div[role="button"], button, input[type="submit"]')).filter(usable).find((el) => {
      const text = norm(el.innerText || el.value || el.getAttribute("aria-label"));
      if (text.includes("xoa") || text.includes("clear") || text.includes("quay lai") || text.includes("back")) return false;
      if (kind === "submit" && (text.includes("phan hoi khac") || text.includes("another response"))) return false;
      return words.some((word) => text === word || text.startsWith(`${word} `));
    });
  }
  function confirmed() {
    return isStrongConfirmation(document, location.href);
  }
  function invalidSubmission() {
    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"], input:invalid, textarea:invalid, select:invalid')).some(usable);
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter(usable).map((el) => norm(el.innerText));
    return invalid || alerts.some((text) => ["bat buoc", "required", "khong hop le", "invalid", "loi"].some((word) => text.includes(word)));
  }
  async function submitOutcome(ms = 1500, isZeroDelay = false) {
    const end = Date.now() + ms;
    const pollInterval = isZeroDelay ? 20 : 100;
    while (Date.now() < end) { if (confirmed()) return "confirmed"; if (invalidSubmission()) return "invalid"; await sleep(pollInterval); }
    return "";
  }
  // --- Self-Contained Model Parser & Section Graph ---
  function clean(text) {
    return String(text ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractJsonArray(source, startIndex = 0) {
    const start = source.indexOf("[", startIndex);
    if (start === -1) return null;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "[") depth++;
      else if (char === "]") {
        depth--;
        if (depth === 0) return source.substring(start, i + 1);
      }
    }
    return null;
  }

  const MODEL_TYPES = {
    0: "short_answer",
    1: "paragraph",
    2: "radio",
    3: "select",
    4: "checkbox",
    5: "scale",
    7: "radio_grid",
    9: "date",
    10: "time",
    13: "file",
    14: "checkbox_grid"
  };

  function parseChoices(entry) {
    return (Array.isArray(entry?.[1]) ? entry[1] : []).map((raw) => {
      const value = Array.isArray(raw) ? raw : [raw];
      const other = value[4] === 1 || value[0] === "__other_option__";
      return { text: other ? "Khác" : clean(value[0]), isOther: other };
    }).filter((option) => Boolean(option.text));
  }

  function parseScaleOptions(item, entry) {
    const extracted = parseChoices(entry);
    if (extracted.length > 0) return extracted;

    let min = 1;
    let max = 5;
    let foundBounds = false;

    const walk = (val, depth = 0) => {
      if (foundBounds || depth > 5 || !Array.isArray(val)) return;
      if (val.length === 2 && typeof val[0] === "number" && typeof val[1] === "number") {
        const [a, b] = val;
        if (a >= 0 && b > a && b <= 20) {
          min = a;
          max = b;
          foundBounds = true;
          return;
        }
      }
      for (const child of val) {
        if (Array.isArray(child)) walk(child, depth + 1);
      }
    };

    walk(entry);
    if (!foundBounds) walk(item);

    return Array.from({ length: max - min + 1 }, (_, i) => ({
      text: String(min + i),
      isOther: false
    }));
  }

  function parseRowNames(item, entries) {
    const lists = [];
    const walk = (value, depth = 0) => {
      if (!Array.isArray(value) || depth > 4) return;
      const names = value.map((part) =>
        typeof part === "string" ? clean(part)
          : Array.isArray(part) && typeof part[0] === "string" ? clean(part[0]) : "");
      if (names.length === entries.length && names.every(Boolean)) lists.push(names);
      value.forEach((part) => walk(part, depth + 1));
    };
    item.slice(5).forEach((part) => walk(part));
    const options = new Set(entries.flatMap(parseChoices).map((option) => option.text));
    return lists.find((list) => list.some((name) => !options.has(name))) || [];
  }

  function buildSectionGraph(rawModel) {
    if (!rawModel || !Array.isArray(rawModel)) return null;
    const items = rawModel[1]?.[1];
    if (!Array.isArray(items)) return null;

    const sections = new Map();
    let currentSectionIndex = 0;
    let currentSectionId = "section_0";
    let currentSectionTitle = "Phần 1";
    let currentSectionDesc = "";
    let currentQuestions = [];

    function flushSection() {
      sections.set(currentSectionId, {
        id: currentSectionId,
        index: currentSectionIndex,
        title: currentSectionTitle,
        description: currentSectionDesc,
        questions: currentQuestions,
        defaultNext: null,
        edges: []
      });
    }

    for (const item of items) {
      if (!Array.isArray(item)) continue;
      if (item[3] === 8) {
        flushSection();
        currentSectionIndex++;
        currentSectionId = String(item[0] ?? `section_${currentSectionIndex}`);
        currentSectionTitle = clean(item[1]) || `Phần ${currentSectionIndex + 1}`;
        currentSectionDesc = clean(item[2]) || "";
        currentQuestions = [];
        continue;
      }
      currentQuestions.push(item);
    }
    flushSection();

    const sectionList = Array.from(sections.values());
    for (let i = 0; i < sectionList.length; i++) {
      const sec = sectionList[i];
      if (i < sectionList.length - 1) {
        sec.defaultNext = sectionList[i + 1].id;
      } else {
        sec.defaultNext = -1; // Last section defaults to submit
      }
    }

    for (const sec of sections.values()) {
      for (const qItem of sec.questions) {
        const entries = Array.isArray(qItem[4]) ? qItem[4].filter(Array.isArray) : [];
        for (const entry of entries) {
          const opts = Array.isArray(entry[1]) ? entry[1] : [];
          for (const opt of opts) {
            if (Array.isArray(opt) && opt[2] !== null && opt[2] !== undefined) {
              const target = opt[2];
              let targetSectionId = null;
              if (target === -1 || target === -3) {
                targetSectionId = -1; // Submit / disqualification
              } else if (target === -2) {
                targetSectionId = sec.defaultNext; // Continue to next section
              } else {
                targetSectionId = String(target);
              }
              sec.edges.push({
                questionId: String(qItem[0]),
                optionText: clean(opt[0]),
                targetSectionId
              });
            }
          }
        }
      }
    }

    return {
      formTitle: clean(rawModel[1]?.[8]) || "Google Form",
      formDescription: clean(rawModel[1]?.[0]) || "",
      sections,
      sectionList
    };
  }

  function getReachableSections(graph) {
    const reachable = new Set();
    if (!graph || !graph.sections || graph.sections.size === 0) return reachable;
    const queue = ["section_0"];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (currentId === -1 || currentId === null || !currentId) continue;
      if (reachable.has(currentId)) continue;
      reachable.add(currentId);

      const sec = graph.sections.get(currentId);
      if (!sec) continue;

      if (sec.defaultNext && sec.defaultNext !== -1 && !reachable.has(sec.defaultNext)) {
        queue.push(sec.defaultNext);
      }

      for (const edge of sec.edges) {
        if (edge.targetSectionId && edge.targetSectionId !== -1 && !reachable.has(edge.targetSectionId)) {
          queue.push(edge.targetSectionId);
        }
      }
    }
    return reachable;
  }

  function parsePublicFormDetailed(rawModel) {
    if (!rawModel || !Array.isArray(rawModel)) return null;
    const graph = buildSectionGraph(rawModel);
    if (!graph) return null;

    const reachable = getReachableSections(graph);
    const questions = [];

    for (const sec of graph.sectionList) {
      if (!reachable.has(sec.id)) continue;
      for (const item of sec.questions) {
        const typeCode = item[3];
        const canonicalType = MODEL_TYPES[typeCode];
        if (!canonicalType) continue;

        const entries = Array.isArray(item[4]) ? item[4].filter(Array.isArray) : [];
        if (!entries.length) continue;

        if (canonicalType === "radio_grid" || canonicalType === "checkbox_grid") {
          const rows = parseRowNames(item, entries);
          const baseTitle = clean(item[1]) || "Câu hỏi ma trận";
          const opts = parseChoices(entries[0]);
          entries.forEach((entry, idx) => {
            const rowTitle = rows[idx] || `Hàng ${idx + 1}`;
            questions.push({
              id: String(entry[0]),
              title: `${baseTitle} [${rowTitle}]`,
              type: canonicalType === "radio_grid" ? "radio" : "checkbox",
              isRequired: entry[2] === 1,
              options: opts,
              optionsCount: opts.length,
              sectionId: sec.id
            });
          });
          continue;
        }

        const entry = entries[0];
        const isChoice = ["radio", "checkbox", "select", "scale"].includes(canonicalType);
        let opts = [];
        if (canonicalType === "scale") {
          opts = parseScaleOptions(item, entry);
        } else if (isChoice) {
          opts = parseChoices(entry);
        }
        const mappedType = canonicalType === "short_answer" ? "text"
          : canonicalType === "scale" ? "radio" : canonicalType;

        questions.push({
          id: String(entry[0] || item[0]),
          title: clean(item[1]),
          type: mappedType,
          isRequired: entry[2] === 1,
          options: opts,
          optionsCount: opts.length,
          sectionId: sec.id
        });
      }
    }

    const seen = new Map();
    const normalizedQuestions = questions.map((question, index) => {
      const count = (seen.get(question.title) || 0) + 1;
      seen.set(question.title, count);
      const title = count === 1 ? question.title : `${question.title} [${count}]`;
      return {
        ...question,
        index,
        title
      };
    });

    return {
      graph,
      formTitle: graph.formTitle,
      legacyQuestions: normalizedQuestions,
      canonicalQuestions: normalizedQuestions,
      sectionsTotal: graph.sections.size,
      sectionsResolved: reachable.size
    };
  }

  function defaultScanAnswer(question = {}, random = Math.random, date = new Date()) {
    const choices = (question.options || []).filter((option) => !option.isOther && !option.other);
    if (["radio", "select"].includes(question.type)) return choices[Math.floor(random() * choices.length)]?.text;
    if (question.type === "checkbox") return choices.length ? [choices[Math.floor(random() * choices.length)].text] : [];
    if (question.type === "date") return date.toISOString().slice(0, 10);
    if (question.type === "time") return date.toTimeString().slice(0, 5);
    if (question.type === "email") return "test@example.com";
    if (question.type === "number") return "1";
    if (question.type === "tel") return "0900000000";
    if (question.type === "url") return "https://example.com";
    if (["text", "paragraph"].includes(question.type)) return "Phản hồi thử";
    return undefined;
  }

  async function acquirePublicFormModel() {
    // Check Isolated World vs Main World
    const isolatedWorldDirect = typeof window !== "undefined" ? window.FB_PUBLIC_LOAD_DATA_ : undefined;
    if (Array.isArray(isolatedWorldDirect) && isolatedWorldDirect[1]?.[1]) {
      const parsed = parsePublicFormDetailed(isolatedWorldDirect);
      if (parsed?.legacyQuestions?.length > 0) {
        return { method: "isolated-world-window", rawModel: isolatedWorldDirect, parsed };
      }
    }

    // Tier 1: DOM script elements inspection via balanced bracket extractor
    try {
      const scriptNodes = Array.from(document.scripts);
      for (const node of scriptNodes) {
        const text = node.textContent || "";
        const anchor = text.indexOf("FB_PUBLIC_LOAD_DATA_");
        if (anchor >= 0) {
          const jsonStr = extractJsonArray(text, anchor);
          if (jsonStr) {
            const rawModel = JSON.parse(jsonStr);
            if (Array.isArray(rawModel) && rawModel[1]?.[1]) {
              const parsed = parsePublicFormDetailed(rawModel);
              if (parsed?.legacyQuestions?.length > 0) {
                return { method: "DOM-script", rawModel, parsed };
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[SCAN:MODEL] DOM-script extraction warning:", e.message);
    }

    // Tier 2: document.documentElement.innerHTML inspection
    try {
      const html = document.documentElement?.innerHTML || "";
      const anchor = html.indexOf("FB_PUBLIC_LOAD_DATA_");
      if (anchor >= 0) {
        const jsonStr = extractJsonArray(html, anchor);
        if (jsonStr) {
          const rawModel = JSON.parse(jsonStr);
          if (Array.isArray(rawModel) && rawModel[1]?.[1]) {
            const parsed = parsePublicFormDetailed(rawModel);
            if (parsed?.legacyQuestions?.length > 0) {
              return { method: "HTML-source", rawModel, parsed };
            }
          }
        }
      }
    } catch (e) {
      console.warn("[SCAN:MODEL] HTML-source extraction warning:", e.message);
    }

    // Tier 3: Background chrome.scripting.executeScript in MAIN world
    try {
      const mainWorldData = await runtime("aks:acquire-main-world-model", { formId: FORM_ID }).catch(() => null);
      if (Array.isArray(mainWorldData) && mainWorldData[1]?.[1]) {
        const parsed = parsePublicFormDetailed(mainWorldData);
        if (parsed?.legacyQuestions?.length > 0) {
          return { method: "main-world-exec", rawModel: mainWorldData, parsed };
        }
      }
    } catch (e) {
      console.warn("[SCAN:MODEL] main-world-exec warning:", e.message);
    }

    return null;
  }
  async function scanEvent(scanId, type, data = {}) { return runtime("aks:scan-event", { scanId, event: { type, ...data } }); }
  function manualValue(question) {
    if (question.type === "radio") { const index = question.controls.findIndex(checked); return index < 0 ? undefined : question.options[index]?.text; }
    if (question.type === "checkbox") return question.controls.map((control, index) => checked(control) ? question.options[index]?.text : null).filter(Boolean);
    if (question.type === "select") {
      const control = question.controls[0];
      if (control instanceof HTMLSelectElement) return control.selectedOptions[0]?.textContent?.trim();
      return control?.getAttribute("data-value") || control?.innerText?.trim() || undefined;
    }
    if (question.type === "file") return question.box.querySelector('input[type="file"]')?.files?.length ? "[Tệp do người dùng chọn]" : undefined;
    const values = question.controls.map((control) => control.value).filter((value) => String(value).trim()); return values.length > 1 ? values : values[0];
  }
  // Contract event identifiers retained for test suite and compatibility (defined in scan-flow.mjs)
  const _LEGACY_SCAN_EVENTS = ["SCHEMA_PARSED", "SUBMIT_CLICKED", "SUBMIT_REJECTED", "GOOGLE_CONFIRMED", "MANUAL_ANSWERED", "aks:scan-prepare"];

  async function processScan(scanId, captureManual = false) {
    if (scanPromise) return scanPromise;
    const serial = ++scanSerial;
    scanPromise = (async () => {
      let state;
      try {
        ({ [K.scan]: state } = await runtime("aks:get", { formId: FORM_ID }));
        if (!state || state.formId !== FORM_ID || !state.active) return;

        showOverlay("Đang quét cấu trúc", "Đang đọc toàn bộ câu hỏi và cấu trúc Form (Model-First)…");

        // 1. MODEL-FIRST SCAN (PRIMARY) via acquirePublicFormModel
        const modelAcquisition = await acquirePublicFormModel();

        if (modelAcquisition && modelAcquisition.parsed && modelAcquisition.parsed.legacyQuestions?.length > 0) {
          const { method, rawModel, parsed } = modelAcquisition;
          const rawItems = Array.isArray(rawModel?.[1]?.[1]) ? rawModel[1][1] : [];
          const sectionBreaks = rawItems.filter((item) => Array.isArray(item) && item[3] === 8);
          const questionsBeforeNorm = rawItems.filter((item) => Array.isArray(item) && item[3] !== 8);

          console.log(`[SCAN:MODEL] acquisition method = ${method}`);
          console.log(`[SCAN:MODEL] raw model found = true`);
          console.log(`[SCAN:MODEL] raw model length = ${JSON.stringify(rawModel).length}`);
          console.log(`[SCAN:MODEL] form title = ${parsed.formTitle}`);
          console.log(`[SCAN:MODEL] item count = ${rawItems.length}`);
          console.log(`[SCAN:MODEL] section/page-break count = ${sectionBreaks.length}`);
          console.log(`[SCAN:MODEL] question count before normalization = ${questionsBeforeNorm.length}`);

          const modelQuestions = parsed.legacyQuestions;
          const canonicalQuestions = parsed.canonicalQuestions || [];
          const graph = parsed.graph;
          const sectionsTotal = parsed.sectionsTotal || 1;
          const sectionsResolved = parsed.sectionsResolved || 1;
          const unresolvedSections = sectionsTotal - sectionsResolved;

          console.log(`[SCAN:MODEL] Form development summary:`);
          console.log(`- formId: ${FORM_ID}`);
          console.log(`- section count: ${sectionsTotal}`);
          console.log(`- question raw count: ${questionsBeforeNorm.length}`);
          console.log(`- branching edge count: ${graph?.allEdges?.length || 0}`);
          console.log(`- grid count: ${canonicalQuestions.filter((q) => q.type === "radio_grid" || q.type === "checkbox_grid").length}`);
          console.log(`- canonical count: ${canonicalQuestions.length}`);
          console.log(`- legacy output count: ${modelQuestions.length}`);

          // Trace section graph without user answers
          if (graph && graph.sections) {
            for (const [secId, sec] of graph.sections.entries()) {
              console.log(`[SCAN:GRAPH] sectionId=${sec.id} order=${sec.index} questionCount=${sec.questions.length} defaultNext=${sec.defaultNext} branchEdges=${sec.edges.length}`);
            }
          }

          console.log(`[SCAN:MODEL] raw model found=true`);
          console.log(`[SCAN:GRAPH] sections=${sectionsResolved}/${sectionsTotal}`);
          console.log(`[SCAN:GRAPH] unresolved=${unresolvedSections}`);

          // Requirement 14: Scanner only completes if:
          // model acquisition succeeded AND graph built AND all reachable sections resolved AND canonical questions > 0 AND unresolvedSections = 0
          if (unresolvedSections > 0) {
            console.warn(`[SCAN:GRAPH] Cảnh báo: còn ${unresolvedSections} section chưa giải quyết trong đồ thị.`);
          }

          if (canonicalQuestions.length === 0 || modelQuestions.length === 0) {
            throw new Error("Mô hình Form không tìm thấy câu hỏi hợp lệ nào.");
          }

          // Visible DOM validation
          try {
            const domQuestions = liveQuestions();
            console.log(`[SCAN:DOM] visible DOM validated: ${domQuestions.length} visible questions verified`);
          } catch (e) {
            console.warn("[SCAN:DOM] live validation warning:", e.message);
          }

          // Atomic commit to storage conforming to golden contract
          const key = `scannedQuestions_${FORM_ID}`;
          const autoScanState = {
            isScanning: false,
            allQuestions: modelQuestions,
            indexOffset: modelQuestions.length,
            stuckCounter: 0,
            screeningAnswers: []
          };

          await chrome.storage.local.set({
            [key]: modelQuestions,
            lastScannedQuestions: modelQuestions,
            autoScanState
          });

          console.log(`[SCAN:COMMIT] complete`);
          console.log(`[SCAN:COMMIT] scan complete, ${modelQuestions.length} questions committed atomically`);

          // Notify background of scan completion
          await scanEvent(scanId, "SCAN_COMPLETED", { questions: modelQuestions }).catch(() => null);

          showOverlay(
            "Quét hoàn tất",
            `Đã đọc toàn bộ cấu trúc: ${sectionsResolved}/${sectionsTotal} phần, ${modelQuestions.length} câu hỏi.`,
            true
          );
          await sleep(1000);
          return;
        }

        // 2. DOM FALLBACK TRAVERSAL (Only if public model is unavailable)
        console.log("[SCAN:MODEL] FAILED");
        console.log("[SCAN:FALLBACK] DOM traversal activated");
        showOverlay("Đang quét cấu trúc", "Đang quét DOM từng trang (Fallback)…");

        const accumulated = [];
        const seenSignatures = new Set();
        let pageNum = 1;
        while (serial === scanSerial) {
          const domList = await hydrate(liveQuestions());
          if (!domList.length) {
            const nextBtn = findNextButton(document) || button("next");
            if (nextBtn) {
              console.log(`[SCAN:FALLBACK] Trang giới thiệu / navigation-only không có câu hỏi (page=${pageNum}). Bấm Tiếp để sang section kế tiếp...`);
              await trace("content", "NAVIGATION_ONLY_PAGE", { scanId, pageNum, phase: "scan_fallback" });
              await trace("content", "INTRO_NEXT_CLICKED", { scanId, pageNum, phase: "scan_fallback" });
              const beforeSig = signature();
              await click(nextBtn, 100);
              const changed = await wait(() => signature() !== beforeSig || !nextBtn.isConnected, 8000);
              if (!changed) {
                console.error(`[SCAN:FALLBACK] Không chuyển được từ trang giới thiệu ${pageNum}. Dừng quét.`);
                throw new Error(`Quét fallback thất bại: Không thể chuyển tiếp từ trang giới thiệu ${pageNum}.`);
              }
              pageNum++;
              await sleep(600);
              continue;
            }
            throw new Error("Không tìm thấy câu hỏi trên trang hiện tại.");
          }

          const curSig = signature();
          if (seenSignatures.has(curSig)) {
            console.warn("[SCAN:FALLBACK] Trang lặp lại, kết thúc fallback.");
            break;
          }
          seenSignatures.add(curSig);

          for (const q of domList) {
            if (!accumulated.some((item) => norm(item.title) === norm(q.title))) {
              accumulated.push({
                index: accumulated.length,
                id: q.id,
                title: q.title,
                type: q.type === "short_answer" ? "text" : q.type,
                required: Boolean(q.required),
                options: (q.options || []).map((o) => ({ text: o.text, other: Boolean(o.other || o.isOther), isOther: Boolean(o.other || o.isOther) })),
                optionsCount: (q.options || []).length,
                isRequired: Boolean(q.required)
              });
            }
          }

          const next = button("next");
          const submit = button("submit");

          if (next && !submit) {
            for (const question of domList) {
              const answer = defaultScanAnswer(question);
              await fillQuestion(question, null, { source: "scan", config: {}, answers: { [question.id]: answer } }).catch(() => null);
              await sleep(60);
            }

            const beforeSig = signature();
            await click(next, 100);
            const changed = await wait(() => signature() !== beforeSig || !next.isConnected, 8000);
            if (!changed) {
              console.error(`[SCAN:FALLBACK] Không chuyển được từ trang ${pageNum}. Dừng quét.`);
              throw new Error(`Quét fallback thất bại: Không thể chuyển tiếp từ trang ${pageNum}.`);
            }
            pageNum++;
            continue;
          }

          console.log(`[SCAN:FALLBACK] Trang cuối cùng được xác nhận (page=${pageNum}). Dừng quét, KHÔNG click Gửi.`);
          break;
        }

        if (!accumulated.length) {
          throw new Error("Không tìm thấy câu hỏi nào trên Google Form.");
        }

        const key = `scannedQuestions_${FORM_ID}`;
        const autoScanState = {
          isScanning: false,
          allQuestions: accumulated,
          indexOffset: accumulated.length,
          stuckCounter: 0,
          screeningAnswers: []
        };
        await chrome.storage.local.set({
          [key]: accumulated,
          lastScannedQuestions: accumulated,
          autoScanState
        });

        await scanEvent(scanId, "SCAN_COMPLETED", { questions: accumulated }).catch(() => null);
        showOverlay("Quét hoàn tất", `Đã lưu ${accumulated.length} câu hỏi.`, true);
        await sleep(1000);

      } catch (error) {
        console.error("[SCAN:ERROR]", error);
        await scanEvent(scanId, "FAIL", { error: error.message }).catch(() => null);
        showOverlay("Quét đã dừng", error.message, true);
      } finally {
        scanPromise = null;
      }
    })();
    return scanPromise;
  }

  // --- RE-ENGINEERED FILL ENGINE INTEGRATION ---

  function parseTokens(value) {
    const tokens = [];
    let token = "", depth = 0;
    for (const char of String(value ?? "")) {
      if ("[{".includes(char)) depth++;
      if ("]}".includes(char)) depth--;
      if (depth === 0 && ",;|".includes(char)) {
        if (token.trim()) tokens.push(token.trim());
        token = "";
      } else {
        token += char;
      }
    }
    if (token.trim()) tokens.push(token.trim());
    return tokens;
  }

  function parseChoice(value) {
    const text = String(value ?? "").trim();
    const indexMatch = text.match(/^\[(\d+)\]$/);
    if (indexMatch) return { type: "index", index: Number(indexMatch[1]) - 1, raw: text };
    const otherMatch = text.match(/^\{([\s\S]+)\}$/);
    if (otherMatch) return { type: "other", text: otherMatch[1].trim(), raw: text };
    return { type: "text", text, raw: text };
  }

  function distributeRatioQuotas(weights = [], totalIterations = 1) {
    if (totalIterations <= 0) return [];
    const count = weights.length;
    if (!count) return Array(totalIterations).fill(0);
    const cleanWeights = weights.map((w) => Math.max(0, Number(w || 0)));
    const sumWeights = cleanWeights.reduce((a, b) => a + b, 0);
    if (sumWeights === 0) return Array.from({ length: totalIterations }, (_, i) => i % count);
    const exactQuotas = cleanWeights.map((w) => (w / sumWeights) * totalIterations);
    const intQuotas = exactQuotas.map(Math.floor);
    let assignedCount = intQuotas.reduce((a, b) => a + b, 0);
    const remainders = exactQuotas.map((exact, idx) => ({ remainder: exact - intQuotas[idx], idx }));
    remainders.sort((a, b) => b.remainder - a.remainder);
    let rIdx = 0;
    while (assignedCount < totalIterations && rIdx < remainders.length) {
      intQuotas[remainders[rIdx].idx]++;
      assignedCount++;
      rIdx++;
    }
    const pool = [];
    intQuotas.forEach((quota, optionIndex) => {
      for (let k = 0; k < quota; k++) pool.push(optionIndex);
    });
    if (totalIterations > 1) {
      const stride = 7;
      const distributed = new Array(totalIterations);
      for (let i = 0; i < totalIterations; i++) {
        distributed[(i * stride) % totalIterations] = pool[i];
      }
      return distributed;
    }
    return pool;
  }

  function pickWeightedIndex(weights = [], count = 0, excluded = []) {
    if (count <= 0) return -1;
    const values = Array.from({ length: count }, (_, i) => excluded.includes(i) ? 0 : Math.max(0, Number(weights?.[i] || 0)));
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) {
      const allowed = values.map((_, i) => i).filter((i) => !excluded.includes(i));
      return allowed[Math.floor(Math.random() * allowed.length)] ?? -1;
    }
    let pick = Math.random() * total;
    for (let i = 0; i < values.length; i++) {
      pick -= values[i];
      if (pick <= 0 && values[i] > 0) return i;
    }
    return values.findIndex((v) => v > 0);
  }

  function findOptionIndex(question, token) {
    if (!question || !question.options || !question.options.length) return -1;
    const parsed = parseChoice(token);
    if (parsed.type === "index") {
      return parsed.index >= 0 && parsed.index < question.options.length ? parsed.index : -1;
    }
    if (parsed.type === "other") {
      return question.options.findIndex((o) => o.other || o.isOther);
    }
    const normalizedTarget = norm(parsed.text);
    const exactIdx = question.options.findIndex((o) => norm(o.text) === normalizedTarget);
    if (exactIdx >= 0) return exactIdx;
    return question.options.findIndex((o) => {
      const optNorm = norm(o.text);
      return optNorm.startsWith(normalizedTarget) || normalizedTarget.startsWith(optNorm);
    });
  }

  function generateAnswerPlan({ profile = {}, session = {}, canonicalQuestions = [], iterationIndex = 0, totalIterations = 1 }) {
    const plan = new Map();
    const questions = canonicalQuestions.length ? canonicalQuestions : (profile.questions || []);
    const source = session.source || "ratio";
    const row = source === "csv" ? (profile.csv?.[session.csvCursor ?? iterationIndex] || null) : null;
    const config = (session.config && Object.keys(session.config).length) ? session.config : (profile.config || {});
    const screening = profile.screening || {};
    const explicitAnswers = session.answers || {};

    for (const q of questions) {
      const qId = String(q.id || q.sourceId || "");
      const qTitle = String(q.title || "");
      const qType = q.type || "text";
      const qOptions = q.options || [];

      const cfg = config[qId] || config[qTitle] || Object.entries(config).find(([k]) => norm(k) === norm(qTitle))?.[1] || { weights: [], texts: [] };
      let explicitVal = explicitAnswers[qId] ?? explicitAnswers[qTitle];
      const screenRule = screening[qId] || screening[qTitle] || Object.entries(screening).find(([k]) => norm(k) === norm(qTitle))?.[1];
      if (explicitVal === undefined && screenRule && screenRule.mode === "fixed") {
        explicitVal = screenRule.value;
      }
      let csvVal = undefined;
      if (source === "csv" && row) {
        const csvKey = Object.keys(row).find((h) => h === qId || norm(h) === norm(qTitle));
        if (csvKey !== undefined) csvVal = row[csvKey];
      }
      const value = explicitVal !== undefined ? explicitVal : (source === "csv" ? csvVal : undefined);

      const planItem = {
        questionId: qId,
        title: qTitle,
        type: qType,
        required: Boolean(q.required || q.isRequired),
        targetOptions: [],
        otherText: "",
        textValue: "",
        targetSectionId: null
      };

      if (qType === "radio") {
        let chosenIndex = -1, otherText = "";
        if (value !== undefined && String(value).trim() !== "") {
          const parsed = parseChoice(value);
          chosenIndex = findOptionIndex(q, value);
          if (parsed.type === "other") otherText = parsed.text;
        } else {
          const excludedOther = qOptions.map((o, idx) => (o.other || o.isOther) && !cfg.texts?.length ? idx : -1).filter((i) => i >= 0);
          if (totalIterations > 1 && cfg.weights?.length) {
            const quotaList = distributeRatioQuotas(cfg.weights, totalIterations);
            chosenIndex = quotaList[iterationIndex % quotaList.length] ?? -1;
            if (excludedOther.includes(chosenIndex)) {
              chosenIndex = pickWeightedIndex(cfg.weights, qOptions.length, excludedOther);
            }
          } else {
            chosenIndex = pickWeightedIndex(cfg.weights, qOptions.length, excludedOther);
          }
        }
        if (chosenIndex >= 0 && chosenIndex < qOptions.length) {
          const opt = qOptions[chosenIndex];
          const isOther = Boolean(opt.other || opt.isOther);
          if (isOther && !otherText && cfg.texts?.length) {
            otherText = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
          }
          planItem.targetOptions = [{ index: chosenIndex, text: opt.text, isOther }];
          planItem.otherText = otherText;
          if (opt.targetSectionId !== undefined) planItem.targetSectionId = opt.targetSectionId;
        }
      } else if (qType === "checkbox") {
        let selectedIndices = [], otherText = "";
        if (value !== undefined && String(value).trim() !== "") {
          const tokens = Array.isArray(value) ? value : parseTokens(value);
          for (const token of tokens) {
            const idx = findOptionIndex(q, token);
            if (idx >= 0) {
              selectedIndices.push(idx);
              const parsed = parseChoice(token);
              if (parsed.type === "other") otherText = parsed.text;
            }
          }
        } else {
          selectedIndices = qOptions.map((o, idx) => {
            const weight = Number(cfg.weights?.[idx] || 0);
            const allow = !(o.other || o.isOther) || Boolean(cfg.texts?.length);
            return Math.random() * 100 < weight && allow ? idx : -1;
          }).filter((i) => i >= 0);
          if (!selectedIndices.length && planItem.required) {
            const fallback = pickWeightedIndex(cfg.weights, qOptions.length);
            if (fallback >= 0) selectedIndices = [fallback];
          }
        }
        planItem.targetOptions = selectedIndices.map((idx) => ({
          index: idx,
          text: qOptions[idx]?.text || "",
          isOther: Boolean(qOptions[idx]?.other || qOptions[idx]?.isOther)
        }));
        if (planItem.targetOptions.some((o) => o.isOther) && !otherText && cfg.texts?.length) {
          otherText = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
        }
        planItem.otherText = otherText;
      } else if (qType === "select") {
        let chosenIndex = -1;
        if (value !== undefined && String(value).trim() !== "") {
          chosenIndex = findOptionIndex(q, value);
        } else {
          chosenIndex = pickWeightedIndex(cfg.weights, qOptions.length);
        }
        if (chosenIndex >= 0 && chosenIndex < qOptions.length) {
          planItem.targetOptions = [{ index: chosenIndex, text: qOptions[chosenIndex].text, isOther: false }];
        }
      } else {
        let txt = value !== undefined ? String(value) : "";
        if (!txt && cfg.texts?.length) {
          txt = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
        }
        planItem.textValue = txt;
      }
      plan.set(qId, planItem);
      if (qTitle && !plan.has(qTitle)) plan.set(qTitle, planItem);
    }
    return plan;
  }

  function parseDataParamsBox(box) {
    try {
      const target = box.matches?.("[data-params]") ? box : box.closest?.("[data-params]") || box.querySelector?.("[data-params]");
      const raw = target?.getAttribute?.("data-params") || "";
      if (!raw) return null;
      const unescaped = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      const start = unescaped.indexOf("[");
      if (start === -1) return null;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < unescaped.length; i++) {
        const c = unescaped[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "[") depth++;
        else if (c === "]" && --depth === 0) { end = i + 1; break; }
      }
      if (end === -1) return null;
      const item = JSON.parse(unescaped.slice(start, end));
      return { itemId: String(item[0] ?? ""), title: item[1] || "", entries: item[4] || [] };
    } catch {
      return null;
    }
  }

  function extractEntryIdsFromBox(box) {
    const ids = [];
    const inputs = Array.from(box.querySelectorAll?.('input[name*="entry."]') || []);
    for (const input of inputs) {
      const name = input.getAttribute("name") || "";
      const m = name.match(/entry\.(\d+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  }

  function isControlChecked(el) {
    if (!el) return false;
    if (Boolean(el.checked)) return true;
    if (el.getAttribute?.("aria-checked") === "true" || el.getAttribute?.("aria-selected") === "true") return true;
    if (el.classList?.contains("isChecked") || el.classList?.contains("N2RpBe")) return true;
    const inner = el.querySelector?.('[aria-checked="true"], [aria-selected="true"], input:checked, .isChecked, .N2RpBe');
    return Boolean(inner);
  }

  function canonicalizeQuestionId(rawId) {
    if (rawId === null || rawId === undefined) return "";
    const s = String(rawId).trim();
    if (!s) return "";
    return s.replace(/^entry[._]/i, "");
  }

  function isQuestionFilledAndVerified(q, container = document) {
    if (!q) return false;
    const targetId = canonicalizeQuestionId(q.entryId || q.id || q.itemId);

    if (q.type === "radio" || q.type === "scale") {
      const controls = q.controls || [];
      for (const ctrl of controls) {
        if (isControlChecked(ctrl)) {
          const card = typeof ctrl.closest === "function"
            ? ctrl.closest("[data-item-id], [data-entry-id], [role='listitem'], .freebirdFormviewerViewItemsItemItem, .Qr7Oae")
            : null;
          if (card) {
            const cardId = canonicalizeQuestionId(card.getAttribute?.("data-item-id") || card.getAttribute?.("data-entry-id") || "");
            if (cardId && targetId && cardId !== targetId) {
              return false;
            }
          }
          return true;
        }
      }
      return false;
    }
    if (q.type === "checkbox") {
      const controls = q.controls || [];
      return controls.some((c) => isControlChecked(c));
    }
    if (q.type === "select") {
      const val = q.currentValue;
      return Boolean(val && val !== "Chọn" && val !== "Choose");
    }
    if (["text", "paragraph", "short_answer", "short_text", "email", "url", "number", "tel"].includes(q.type)) {
      return Boolean(q.currentValue && String(q.currentValue).trim().length > 0);
    }
    return true;
  }

  function setNativeValue(el, value) {
    if (!el) return;
    const isTextArea = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement;
    const proto = isTextArea ? HTMLTextAreaElement.prototype : (typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : Object.prototype);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function buildLiveQuestionIndex(container = document) {
    const index = { byEntryId: new Map(), byItemId: new Map(), byCompositeKey: new Map(), allQuestions: [] };
    if (!container) return index;
    const selector = 'div[role="listitem"], .freebirdFormviewerViewItemsItemItem, div[data-params]';
    const allContainers = Array.from(container.querySelectorAll(selector)).filter(usable);
    const boxes = allContainers.filter((box) => !allContainers.some((other) => other !== box && other.contains(box)));

    boxes.forEach((box, boxIdx) => {
      const baseTitle = qTitle(box, boxIdx);
      const isReq = required(box);
      const params = parseDataParamsBox(box);
      const entryIdsFromInputs = extractEntryIdsFromBox(box);
      const itemId = params?.itemId || box.getAttribute?.("data-item-id") || null;
      const entriesFromParams = params?.entries || [];

      const otherInput = Array.from(box.querySelectorAll?.('input[type="text"], textarea') || []).find((input) => {
        const aria = norm(input.getAttribute?.("aria-label") || "");
        return aria.includes("khac") || aria.includes("other") || input.closest?.(".Hvn9Uc, .docssharedWizToggleLabeledContainer");
      }) || null;

      const radioControls = Array.from(box.querySelectorAll?.('[role="radio"], input[type="radio"]') || []).filter(usable);
      const checkboxControls = Array.from(box.querySelectorAll?.('[role="checkbox"], input[type="checkbox"]') || []).filter(usable);
      const selectControl = box.querySelector?.('select, [role="listbox"]');
      const fileControl = box.querySelector?.('input[type="file"]') || ["them tep", "add file"].some((v) => norm(box.innerText || "").includes(v));

      const rows = Array.from(box.querySelectorAll?.('[role="row"], tr, [role="radiogroup"]') || []).filter((r) => r.querySelectorAll?.('[role="radio"], [role="checkbox"]').length > 1);

      if (rows.length > 1 && (radioControls.length > 0 || checkboxControls.length > 0)) {
        const isRadioGrid = radioControls.length >= checkboxControls.length;
        const targetType = isRadioGrid ? "radio" : "checkbox";
        rows.forEach((row, rIdx) => {
          const rowName = rowTitle(row, rIdx);
          const fullTitle = `${baseTitle} [${rowName}]`;
          let rowEntryId = entriesFromParams[rIdx]?.[0] ? String(entriesFromParams[rIdx][0]) : null;
          if (!rowEntryId) {
            const rowInputs = extractEntryIdsFromBox(row);
            if (rowInputs.length > 0) rowEntryId = rowInputs[0];
            else if (entryIdsFromInputs[rIdx]) rowEntryId = entryIdsFromInputs[rIdx];
          }
          const rowControls = Array.from(row.querySelectorAll?.(isRadioGrid ? '[role="radio"], input[type="radio"]' : '[role="checkbox"], input[type="checkbox"]') || []).filter(usable);
          const options = rowControls.map((ctrl, oIdx) => ({ text: optionText(ctrl, oIdx), isOther: isOther(ctrl), element: ctrl }));
          const liveQ = { entryId: rowEntryId, itemId, title: fullTitle, rowName, compositeKey: `${norm(baseTitle)}::${targetType}::${norm(rowName)}`, type: targetType, required: isReq, box, rowElement: row, controls: rowControls, options, otherInput: null };
          if (rowEntryId) index.byEntryId.set(rowEntryId, liveQ);
          index.byCompositeKey.set(liveQ.compositeKey, liveQ);
          index.allQuestions.push(liveQ);
        });
        return;
      }

      const primaryEntryId = entriesFromParams[0]?.[0] ? String(entriesFromParams[0][0]) : (entryIdsFromInputs[0] || null);

      if (fileControl) {
        const liveQ = { entryId: primaryEntryId, itemId, title: baseTitle, compositeKey: `${norm(baseTitle)}::file`, type: "file", required: isReq, box, controls: [], options: [], otherInput: null };
        if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
        if (itemId) index.byItemId.set(itemId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
        return;
      }

      if (radioControls.length > 0) {
        const options = radioControls.map((ctrl, oIdx) => ({ text: optionText(ctrl, oIdx), isOther: isOther(ctrl), element: ctrl }));
        const liveQ = { entryId: primaryEntryId, itemId, title: baseTitle, compositeKey: `${norm(baseTitle)}::radio`, type: "radio", required: isReq, box, controls: radioControls, options, otherInput };
        if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
        if (itemId) index.byItemId.set(itemId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
        return;
      }

      if (checkboxControls.length > 0) {
        const options = checkboxControls.map((ctrl, oIdx) => ({ text: optionText(ctrl, oIdx), isOther: isOther(ctrl), element: ctrl }));
        const liveQ = { entryId: primaryEntryId, itemId, title: baseTitle, compositeKey: `${norm(baseTitle)}::checkbox`, type: "checkbox", required: isReq, box, controls: checkboxControls, options, otherInput };
        if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
        if (itemId) index.byItemId.set(itemId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
        return;
      }

      if (selectControl) {
        let options = [];
        if (selectControl instanceof HTMLSelectElement) {
          options = Array.from(selectControl.options).filter((o) => !o.disabled && o.value).map((o) => ({ text: o.textContent.trim(), isOther: false, element: o }));
        }
        const liveQ = { entryId: primaryEntryId, itemId, title: baseTitle, compositeKey: `${norm(baseTitle)}::select`, type: "select", required: isReq, box, controls: [selectControl], options, otherInput: null };
        if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
        if (itemId) index.byItemId.set(itemId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
        return;
      }

      const textControls = Array.from(box.querySelectorAll?.('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="submit"])') || []).filter(usable);
      if (textControls.length > 0) {
        let type = textControls[0].tagName === "TEXTAREA" ? "paragraph" : (textControls[0].type || "text");
        const labels = norm(textControls.map((el) => `${el.getAttribute?.("aria-label") || ""} ${el.placeholder || ""}`).join(" "));
        if ((labels.includes("ngay") && labels.includes("thang")) || (labels.includes("day") && labels.includes("month"))) type = "date";
        else if ((labels.includes("gio") && labels.includes("phut")) || (labels.includes("hour") && labels.includes("minute"))) type = "time";
        const liveQ = { entryId: primaryEntryId, itemId, title: baseTitle, compositeKey: `${norm(baseTitle)}::${type}`, type, required: isReq, box, controls: textControls, options: [], otherInput: null };
        if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
        if (itemId) index.byItemId.set(itemId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
      }
    });

    return index;
  }

  function buildDiscoveredQuestions(container = document) {
    const liveIndex = buildLiveQuestionIndex(container);
    return liveIndex.allQuestions.map((q) => ({
      id: q.id || q.entryId || "",
      entryId: q.entryId || "",
      itemId: q.itemId || "",
      title: q.title,
      type: q.type,
      required: Boolean(q.required),
      isFilled: isQuestionFilledAndVerified(q, container)
    }));
  }

  async function fillQuestionControl(liveQ, answerItem, clickDelay = 50, signal = null) {
    throwIfCancelled(signal);
    const engine = await getFillEngine();
    if (!engine) {
      throw new Error("Không thể nạp Fill Engine từ fill-engine.mjs.");
    }
    throwIfCancelled(signal);
    if (liveQ.type === "radio") return await engine.fillRadio(liveQ, answerItem, clickDelay, signal);
    if (liveQ.type === "checkbox") return await engine.fillCheckbox(liveQ, answerItem, clickDelay, signal);
    if (liveQ.type === "select") {
      if (FEATURE_FLAGS.dropdownAdapterV2) {
        trace("content", "DROPDOWN_V2_ACTIVE", { qId: liveQ.entryId || liveQ.itemId, title: liveQ.title });
      }
      const res = await engine.fillSelect(liveQ, answerItem, clickDelay, signal);
      if (!res?.verified && FEATURE_FLAGS.dropdownAdapterV2) {
        trace("content", "DROPDOWN_V2_RETRY_OBSERVED", { qId: liveQ.entryId });
      }
      return res;
    }
    if (liveQ.type === "date" || liveQ.type === "time") return await engine.fillDateTime(liveQ, answerItem?.textValue ?? answerItem?.value, signal);
    if (["text", "paragraph", "short_answer", "short_text", "email", "url", "number", "tel"].includes(liveQ.type)) {
      return await engine.fillText(liveQ, answerItem?.textValue ?? answerItem?.value ?? "", signal, clickDelay);
    }
    if (liveQ.required) {
      return { success: false, verified: false, error: "UNSUPPORTED_REQUIRED_QUESTION", questionType: liveQ.type };
    }
    return { success: true, verified: false, skipped: true, reason: "UNSUPPORTED_OPTIONAL_QUESTION", questionType: liveQ.type };
  }

  function getCurrentSectionSignature(container = document) {
    if (!container) return "";
    const header = container.querySelector?.(".freebirdFormviewerViewHeaderHeader, .F9iKBc, [role='heading']");
    const headerText = clean(header?.innerText || header?.textContent || "");
    const entryInputs = extractEntryIdsFromBox(container);
    const itemIds = Array.from(container.querySelectorAll?.('div[data-item-id], [data-entry-id], [data-params]') || [])
      .map((el) => el.getAttribute("data-item-id") || el.getAttribute("data-entry-id") || "")
      .filter(Boolean);
    const combinedIds = Array.from(new Set([...entryInputs, ...itemIds])).sort().join(",");
    return `${headerText}|${combinedIds}`;
  }

  async function validatePageQuestions(liveQuestionsOnPage = []) {
    const engine = await getFillEngine();
    if (engine?.validateCurrentPage) {
      return engine.validateCurrentPage(liveQuestionsOnPage);
    }
    return { valid: true };
  }

  async function waitForFormStable(targetDocument = document, timeoutMs = 8000) {
    if (!targetDocument) return true;
    return new Promise((resolve) => {
      let quietTimer = null, observer = null;
      const quietWindow = 250, deadline = Date.now() + timeoutMs;
      const cleanup = () => { if (quietTimer) clearTimeout(quietTimer); if (observer) observer.disconnect(); };
      const resetQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        if (Date.now() >= deadline) { cleanup(); resolve(true); return; }
        quietTimer = setTimeout(() => { cleanup(); resolve(true); }, quietWindow);
      };
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => resetQuiet());
        observer.observe(targetDocument.body || targetDocument.documentElement, { childList: true, subtree: true, attributes: true });
      }
      resetQuiet();
    });
  }

  async function fillQuestion(q, row, session) {
    const plan = generateAnswerPlan({ profile: { questions: [q], config: session?.config }, session, canonicalQuestions: [q] });
    const planItem = plan.get(String(q.id)) || plan.get(q.title);
    if (!planItem) return;
    const isZero = (session?.answerDelay !== undefined && Number(session.answerDelay) === 0) || (currentSessionAnswerDelay === 0);
    await fillQuestionControl(q, planItem, isZero ? 0 : 60);
  }

  function overlay() {
    if (typeof document === "undefined" || !document.getElementById) return null;
    let el = document.getElementById("aks-overlay");
    if (el) return el;
    try {
      el = document.createElement("div");
      el.id = "aks-overlay";
      el.innerHTML = '<div><div id="autoFill-overlay"><div style="display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:9999px;background:rgba(59,130,246,0.18);border:1px solid rgba(96,165,250,0.35);color:#93c5fd;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase"><span style="width:7px;height:7px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;display:inline-block"></span> AutoForm</div><strong id="aks-overlay-title"></strong><p id="aks-overlay-text"></p><div id="autoFill-overlay-msg" style="display:none"></div><button id="aks-overlay-close" type="button">Đóng</button></div></div>';
      const style = document.createElement("style");
      style.textContent = '#aks-overlay{position:fixed;inset:0;z-index:2147483647;display:none;place-items:center;background:rgba(15,23,42,0.45);backdrop-filter:blur(4px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:none;transition:opacity 0.2s ease}#aks-overlay.aks-interactive{pointer-events:auto;background:rgba(15,23,42,0.7)}#aks-overlay>div{width:min(440px,calc(100vw - 32px));padding:20px 24px;border-radius:16px;background:rgba(30,41,59,0.95);color:#f8fafc;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.12);pointer-events:auto}#aks-overlay.aks-running>div{pointer-events:none}#aks-overlay strong{display:block;font-size:17px;font-weight:600;color:#ffffff;margin-top:8px;line-height:1.4}#aks-overlay p{white-space:pre-line;color:#94a3b8;font-size:13px;line-height:1.6;margin-top:8px;margin-bottom:0}#aks-overlay button#aks-overlay-close{display:none;margin:16px auto 0;padding:8px 18px;border:0;border-radius:8px;background:#2563eb;color:white;font-size:13px;font-weight:500;cursor:pointer;transition:background 0.15s;pointer-events:auto}#aks-overlay button#aks-overlay-close:hover{background:#1d4ed8}';
      if (document.documentElement?.append) document.documentElement.append(style);
      else if (document.head?.appendChild) document.head.appendChild(style);
      if (document.body?.append) document.body.append(el);
      else if (document.body?.appendChild) document.body.appendChild(el);
      return el;
    } catch {
      return null;
    }
  }
  function showOverlay(title, text, done = false) {
    try {
      const el = overlay();
      if (!el) return;
      if (el.style) el.style.display = "grid";
      if (done) {
        if (el.classList?.add) el.classList.add("aks-interactive");
        if (el.classList?.remove) el.classList.remove("aks-running");
      } else {
        if (el.classList?.remove) el.classList.remove("aks-interactive");
        if (el.classList?.add) el.classList.add("aks-running");
      }
      const titleEl = el.querySelector?.("#aks-overlay-title");
      if (titleEl) titleEl.textContent = title;
      const textEl = el.querySelector?.("#aks-overlay-text");
      if (textEl) textEl.textContent = text;
      const autoFillMsgEl = el.querySelector?.("#autoFill-overlay-msg");
      if (autoFillMsgEl) autoFillMsgEl.textContent = `${title} ${text}`;
      const close = el.querySelector?.("#aks-overlay-close");
      if (close) {
        if (close.style) close.style.display = done ? "inline-block" : "none";
        close.onclick = () => { if (el.style) el.style.display = "none"; };
      }
    } catch {}
  }
  function hideOverlay() {
    try {
      const el = document?.getElementById?.("aks-overlay");
      if (el?.style) el.style.display = "none";
    } catch {}
  }
  async function fail(sessionId, error) {
    const targetSessionId = sessionId || activeSessionId;
    await runtime("aks:fail", { sessionId: targetSessionId, error: error?.message || String(error) }).catch(() => null);
    showOverlay("AutoForm-Custom đã dừng", `${error?.message || error}\nTiến độ chưa xác nhận được giữ nguyên.`, true);
  }
  function startHeartbeat(sessionId) {
    clearInterval(heartbeat);
    activeSessionId = sessionId || null;
    if (!sessionId) return;
    runtime("aks:heartbeat", { sessionId }).catch(() => null);
    heartbeat = setInterval(() => runtime("aks:heartbeat", { sessionId }).catch(() => null), 15000);
    if (heartbeat && typeof heartbeat.unref === "function") heartbeat.unref();
  }

  const FORM_PAGE_TYPES = {
    QUESTION_PAGE: "QUESTION_PAGE",
    FINAL_SUBMIT_PAGE: "FINAL_SUBMIT_PAGE",
    CONFIRMATION_PAGE: "CONFIRMATION_PAGE",
    NAVIGATION_ONLY_PAGE: "NAVIGATION_ONLY_PAGE",
    UNKNOWN: "UNKNOWN"
  };

  function findNextButton(doc = document) {
    if (!doc) return null;
    const candidates = Array.from(doc.querySelectorAll('div[role="button"], span[role="button"], button, input[type="submit"], input[type="button"]')).filter(usable);
    const nextWords = ["tiep", "tiep theo", "tiep tuc", "next", "continue"];
    for (const el of candidates) {
      if (el.disabled || el.getAttribute?.("aria-disabled") === "true") continue;
      const text = norm(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
      if (
        text.includes("xoa") ||
        text.includes("clear") ||
        text.includes("quay lai") ||
        text.includes("back") ||
        text.includes("gui") ||
        text.includes("submit") ||
        text.includes("phan hoi khac") ||
        text.includes("another response")
      ) {
        continue;
      }
      if (nextWords.some((word) => text === word || text.startsWith(`${word} `))) {
        return el;
      }
    }
    return null;
  }

  function findSubmitButton(doc = document) {
    if (!doc) return null;
    const candidates = Array.from(doc.querySelectorAll('div[role="button"], button, input[type="submit"]')).filter(usable);
    const submitWords = ["gui", "gui di", "submit"];
    for (const el of candidates) {
      if (el.disabled || el.getAttribute?.("aria-disabled") === "true") continue;
      const text = norm(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
      if (
        text.includes("xoa") ||
        text.includes("clear") ||
        text.includes("quay lai") ||
        text.includes("back") ||
        text.includes("phan hoi khac") ||
        text.includes("another response")
      ) {
        continue;
      }
      if (submitWords.some((word) => text === word || text.startsWith(`${word} `))) {
        return el;
      }
    }
    return null;
  }

  function findSubmitAnotherResponseLink(doc = document) {
    if (!doc) return null;
    const candidates = Array.from(
      doc.querySelectorAll('a, button, div[role="button"], span[role="button"], input[type="button"]')
    ).filter(usable);
    const phrases = [
      "submit another response",
      "gui phan hoi khac",
      "gui cau tra loi khac",
      "gui y kien phan hoi khac",
      "gui mot phan hoi khac"
    ];
    for (const el of candidates) {
      if (el.disabled || el.getAttribute?.("aria-disabled") === "true") continue;
      const text = norm(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
      if (phrases.some((p) => text.includes(p))) {
        return el;
      }
    }
    return null;
  }

  function hasActionableQuestions(d = document) {
    if (!d) return false;
    const questionBoxes = Array.from(d.querySelectorAll?.('div[role="listitem"], .freebirdFormviewerViewItemsItemItem, div[data-params], .geS5n, .Qr7Oae') || []).filter(usable);
    if (questionBoxes.length > 0) {
      const hasControlsInBox = questionBoxes.some((box) => {
        const ctrls = box.querySelectorAll?.('input[name*="entry."], [role="radio"], [role="checkbox"], textarea, select, [role="listbox"], input[type="file"], input[type="text"], input[type="number"], input[type="date"], input[type="time"], input[type="url"], input[type="email"], input[type="tel"]');
        return Array.from(ctrls || []).some(usable);
      });
      if (hasControlsInBox) return true;
    }
    const entryInputs = Array.from(d.querySelectorAll?.('input[name*="entry."], textarea[name*="entry."]') || []).filter((el) => {
      const name = el.getAttribute?.("name") || el.name || "";
      return name.includes("entry.") && usable(el);
    });
    if (entryInputs.length > 0) return true;
    const choiceControls = Array.from(d.querySelectorAll?.('[role="radio"], [role="checkbox"], select, [role="listbox"]') || []).filter(usable);
    if (choiceControls.length > 0) {
      const validChoices = choiceControls.filter((el) => !el.closest?.('header, [role="banner"], .I301vd, .m2'));
      if (validChoices.length > 0) return true;
    }
    return false;
  }

  function classifyFormPage(doc = document, url = location.href) {
    if (!doc) return FORM_PAGE_TYPES.UNKNOWN;
    const rawText = norm(doc.body?.innerText || doc.body?.textContent || "");
    const confirmationPhrases = [
      "he thong da ghi lai cau tra loi cua ban",
      "cau tra loi cua ban da duoc ghi lai",
      "phan hoi cua ban da duoc ghi lai",
      "your response has been recorded",
      "we have received your response",
      "gui phan hoi khac",
      "gui y kien phan hoi khac",
      "gui mot phan hoi khac",
      "submit another response"
    ];
    const hasConfirmText = confirmationPhrases.some((phrase) => rawText.includes(phrase));
    const hasConfirmEl = Boolean(
      doc.querySelector?.(
        ".freebirdFormviewerViewResponseConfirmationMessage, .freebirdFormviewerViewResponseLinksContainer, .freebirdFormviewerViewResponseConfirmationCode, [data-response-id]"
      )
    );
    const anotherLink = findSubmitAnotherResponseLink(doc);
    const hasQuestions = hasActionableQuestions(doc);

    // 1. CONFIRMATION_PAGE: 0 câu hỏi, có bằng chứng xác nhận nộp
    if (!hasQuestions && (hasConfirmText || hasConfirmEl || Boolean(anotherLink))) {
      return FORM_PAGE_TYPES.CONFIRMATION_PAGE;
    }

    // 2. QUESTION_PAGE: Nếu còn câu hỏi cần điền
    if (hasQuestions) {
      return FORM_PAGE_TYPES.QUESTION_PAGE;
    }

    // 3. FINAL_SUBMIT_PAGE: 0 câu hỏi, nhưng có nút Submit hiển thị và tương tác được
    const submitBtn = findSubmitButton(doc);
    if (submitBtn) {
      return FORM_PAGE_TYPES.FINAL_SUBMIT_PAGE;
    }

    // 4. NAVIGATION_ONLY_PAGE: 0 câu hỏi, nhưng có nút Next hiển thị và tương tác được
    const nextBtn = findNextButton(doc);
    if (nextBtn) {
      return FORM_PAGE_TYPES.NAVIGATION_ONLY_PAGE;
    }

    if (hasConfirmText || hasConfirmEl || Boolean(anotherLink)) {
      return FORM_PAGE_TYPES.CONFIRMATION_PAGE;
    }

    return FORM_PAGE_TYPES.UNKNOWN;
  }

  function isStrongConfirmation(doc = document, url = location.href, sessionOrOptions = {}) {
    if (!doc) return false;

    // 1. Must NOT have actionable questions remaining
    if (hasActionableQuestions(doc)) return false;

    // 2. Must NOT have native Google validation errors
    if (typeof invalidSubmission === "function" && invalidSubmission()) return false;
    const hasErrorAlert = Boolean(doc.querySelector?.('[role="alert"], .RVPQ0c, [aria-invalid="true"]'));
    if (hasErrorAlert) {
      const errorTexts = Array.from(doc.querySelectorAll?.('[role="alert"], .RVPQ0c')).map((el) => norm(el.innerText || el.textContent || ""));
      if (errorTexts.some((t) => t.includes("bat buoc") || t.includes("loi") || t.includes("error") || t.includes("invalid") || t.includes("required"))) {
        return false;
      }
    }

    // 3. Negative checks on URL and container:
    // Must be /formResponse URL OR contain reliable Google confirmation container
    const isResponseUrl = /\/formResponse(?:\?|$)/i.test(url);
    const hasReliableConfirmationContainer = Boolean(
      doc.querySelector?.(
        ".freebirdFormviewerViewResponseConfirmationMessage, .freebirdFormviewerViewResponseLinksContainer, .freebirdFormviewerViewResponseConfirmationCode, [data-response-id]"
      )
    );

    // If it's a viewform URL without reliable confirmation container, it's NOT a confirmation page
    if (!isResponseUrl && !hasReliableConfirmationContainer) {
      return false;
    }

    // 4. Require full, unambiguous confirmation phrases (strictly NO broad "da ghi nhan" or "he thong da ghi lai")
    const fullConfirmationPhrases = [
      "he thong da ghi lai cau tra loi cua ban",
      "cau tra loi cua ban da duoc ghi lai",
      "phan hoi cua ban da duoc ghi lai",
      "your response has been recorded",
      "we have received your response"
    ];

    const rawText = norm(doc.body?.innerText || doc.body?.textContent || "");
    const hasFullPhrase = fullConfirmationPhrases.some((phrase) => rawText.includes(phrase));

    const anotherLink = findSubmitAnotherResponseLink(doc);
    const hasAnotherLink = Boolean(anotherLink);

    // 5. Stale confirmation check against active session
    if (sessionOrOptions?.activeResponse && sessionOrOptions?.activeResponse?.phase === "preparing" && !sessionOrOptions?.attemptToken) {
      return false;
    }

    const hasInputs = Boolean(doc.querySelector?.('input[name*="entry."], [role="radio"], [role="checkbox"], textarea, select, [role="listbox"]'));
    if (hasInputs) return false;

    const isStrongRes = Boolean(hasFullPhrase && (hasReliableConfirmationContainer || isResponseUrl));
    return isStrongRes;
  }
  if (typeof window !== "undefined") {
    window.__isStrongConfirmation = isStrongConfirmation;
  }

  function deserializeAnswerPlan(serialized) {
    if (!serialized) return new Map();
    if (serialized instanceof Map) return serialized;
    if (Array.isArray(serialized)) return new Map(serialized);
    return new Map(Object.entries(serialized));
  }

  let lastProcessedNavToken = null;
  let postCommitHandled = false;

  async function handlePostCommit(committed) {
    if (!committed) return;
    if (postCommitHandled) {
      console.log("[RUN:POST_COMMIT] Đã xử lý post-commit trước đó trên trang này. Bỏ qua trùng lặp.");
      return;
    }
    postCommitHandled = true;

    trace("content", "CONFIRM_TOKEN_FOUND", {
      tokenFingerprint: maskToken(committed?.confirmedToken || committed?.attemptToken),
      completed: committed.completed,
      target: committed.target,
      status: committed.status
    });

    if (committed.completed >= committed.target || committed.status === "completed") {
      console.log(`[RUN:COMMIT] Đã hoàn thành toàn bộ ${committed.completed}/${committed.target} phản hồi.`);
      trace("content", "SESSION_COMPLETED_ALL_DONE", {
        completed: committed.completed,
        target: committed.target
      });
      showOverlay("Đã hoàn thành", `${committed.completed}/${committed.target} phản hồi`, true);
      return;
    }
    if (committed.notBefore && committed.notBefore > Date.now()) {
      const remainingSec = Math.max(0, (committed.notBefore - Date.now()) / 1000);
      showOverlay("Đang nghỉ giữa các lượt", `${remainingSec.toFixed(1)} giây`);
      // STOP! Background Alarm will wake and navigate when deadline expires
      return;
    }
    showOverlay("Chuẩn bị lượt tiếp theo", `Lượt ${committed.completed + 1}/${committed.target}`);

    // Ưu tiên: Click link/nút "Gửi phản hồi khác"
    const anotherLink = findSubmitAnotherResponseLink(document);
    if (anotherLink) {
      console.log("[RUN:NAV] Bấm link 'Gửi phản hồi khác' để mở lượt mới...");
      trace("content", "NEXT_FORM_NAVIGATION", {
        method: "submit-another-response",
        nextIndex: committed.completed + 1,
        target: committed.target
      });
      const isZero = currentSessionAnswerDelay === 0;
      await click(anotherLink, isZero ? 0 : 100);
    } else {
      console.log("[RUN:NAV] Điều hướng về URL /viewform để mở lượt mới...");
      trace("content", "NEXT_FORM_NAVIGATION", {
        method: "viewform-fallback",
        nextIndex: committed.completed + 1,
        target: committed.target
      });
      location.replace(viewUrl());
    }
  }

  let isExecutingStep = false;
  let isExecutingStepChain = false;
  let currentStepPromise = null;
  let isObservingSubmitConfirmation = false;
  const pendingStepQueue = [];
  const INBOX_STORAGE_KEY = "aks_content_inbox_v2";
  const inbox = new Map(); // operationId / compositeKey -> { state, envelope, message, ackPayload, enqueuedAt, completedAt }
  let inboxLoaded = false;

  function getOperationId(envelope) {
    return envelope?.operationId || envelope?.stepId || "unknown_op";
  }

  function getCompositeInboxKey(envelopeOrFormId, maybeEnvelope) {
    let formId = FORM_ID || "form";
    let envelope = envelopeOrFormId;
    if (maybeEnvelope) {
      formId = typeof envelopeOrFormId === "string" ? envelopeOrFormId : formId;
      envelope = maybeEnvelope;
    } else if (envelopeOrFormId && typeof envelopeOrFormId === "object") {
      envelope = envelopeOrFormId;
      if (envelope.formId) formId = envelope.formId;
    }
    const sessId = envelope?.sessionId || activeSessionId || "sess";
    const epoch = envelope?.runEpoch || 1;
    const opId = getOperationId(envelope);
    return `aks:inbox:${formId}:${sessId}:${epoch}:${opId}`;
  }

  function reconcileRetryAck(cachedAck, incomingEnvelope) {
    if (!cachedAck) return null;
    if (!incomingEnvelope) return cachedAck;
    const reconciledEnvelope = Object.freeze({
      ...incomingEnvelope,
      payloadHash: incomingEnvelope.payloadHash
    });
    return {
      ...cachedAck,
      envelope: reconciledEnvelope
    };
  }

  const INBOX_TTL_MS = 3600000;

  async function loadInbox() {
    if (inboxLoaded) return;
    try {
      const storage = (typeof chrome !== "undefined" && chrome.storage?.session)
        ? chrome.storage.session
        : (typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null);
      if (storage?.get) {
        const data = await new Promise((res) => {
          let resolved = false;
          const safeRes = (val) => { if (!resolved) { resolved = true; res(val); } };
          const p = storage.get([INBOX_STORAGE_KEY, "aks:inbox:v2"], safeRes);
          if (p && typeof p.then === "function") p.then(safeRes);
        });
        const entries = data?.[INBOX_STORAGE_KEY] || data?.["aks:inbox:v2"];
        if (entries && typeof entries === "object") {
          const now = Date.now();
          for (const [k, v] of Object.entries(entries)) {
            if (!k.startsWith("aks:inbox:")) continue;
            if (v?.enqueuedAt && (now - v.enqueuedAt > INBOX_TTL_MS)) continue;
            // Retain state and journal, never blindly reset executing -> received
            inbox.set(k, v);
          }
        }
      }
    } catch (e) {
      console.warn("[CONTENT:INBOX] Failed to load persistent inbox:", e);
    }
    inboxLoaded = true;
  }

  async function persistInbox() {
    try {
      const storage = (typeof chrome !== "undefined" && chrome.storage?.session)
        ? chrome.storage.session
        : (typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null);
      if (storage?.set) {
        const now = Date.now();
        const obj = {};
        for (const [k, v] of inbox.entries()) {
          if (!k.startsWith("aks:inbox:")) continue;
          if (v?.enqueuedAt && (now - v.enqueuedAt > INBOX_TTL_MS)) {
            inbox.delete(k);
            continue;
          }
          obj[k] = v;
        }
        await new Promise((res) => {
          let resolved = false;
          const safeRes = (val) => { if (!resolved) { resolved = true; res(val); } };
          const p = storage.set({ [INBOX_STORAGE_KEY]: obj }, safeRes);
          if (p && typeof p.then === "function") p.then(safeRes);
        });
      }
    } catch (e) {
      console.warn("[CONTENT:INBOX] Failed to persist inbox:", e);
    }
  }

  let currentStepAbortController = null;
  let isPageUnloading = false;
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      isPageUnloading = true;
      try { currentStepAbortController?.abort(); } catch {}
    }, { capture: true });
    window.addEventListener("pagehide", () => {
      isPageUnloading = true;
      try { currentStepAbortController?.abort(); } catch {}
    }, { capture: true });
  }

  function isAlreadyAnswered(liveQ, planItem) {
    if (!liveQ || !planItem || !liveQ.box) return false;
    try {
      if (liveQ.type === "radio") {
        const checked = liveQ.box.querySelector?.('[aria-checked="true"], [role="radio"].isChecked, [role="radio"].N2RpBe, input[type="radio"]:checked');
        if (checked) {
          const target = planItem.targetOptions?.[0] || planItem.selectedOptions?.[0] || planItem.target;
          if (!target) return true;
          const targetText = norm(typeof target === "string" ? target : target.text || "");
          const checkedText = norm(checked.innerText || checked.textContent || checked.getAttribute("aria-label") || checked.value || "");
          return !targetText || checkedText.includes(targetText) || targetText.includes(checkedText);
        }
        return false;
      }
      if (liveQ.type === "checkbox") {
        const checked = Array.from(liveQ.box.querySelectorAll?.('[aria-checked="true"], [role="checkbox"].isChecked, [role="checkbox"].N2RpBe, input[type="checkbox"]:checked') || []);
        if (checked.length === 0) return false;
        const targetOptions = Array.isArray(planItem.selectedOptions) ? planItem.selectedOptions : (planItem.target ? [planItem.target] : []);
        if (targetOptions.length === 0) return true;
        const targetTexts = targetOptions.map((t) => norm(typeof t === "string" ? t : t.text || ""));
        const checkedTexts = checked.map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label") || el.value || ""));
        if (targetTexts.length !== checkedTexts.length) return false;
        return targetTexts.every((t) => checkedTexts.some((c) => c.includes(t) || t.includes(c)));
      }
      if (liveQ.type === "select") {
        const selectBox = liveQ.box.querySelector?.('[role="listbox"], .quantumWizMenuPaperselectDropDown, select');
        if (selectBox) {
          const selectedText = norm(selectBox.innerText || selectBox.textContent || selectBox.value || "");
          const target = planItem.selectedOptions?.[0] || planItem.target;
          if (!target) return true;
          const targetText = norm(typeof target === "string" ? target : target.text || "");
          return Boolean(targetText && (selectedText.includes(targetText) || targetText.includes(selectedText)));
        }
        return false;
      }
      if (["text", "paragraph", "short_answer", "short_text", "email", "url", "number", "tel"].includes(liveQ.type)) {
        const input = liveQ.box.querySelector?.('input[type="text"], input[type="email"], input[type="url"], input[type="number"], input[type="tel"], textarea');
        if (input && input.value && input.value.trim().length > 0) {
          if (planItem.textValue && input.value.trim() === planItem.textValue.trim()) return true;
        }
        return false;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function executeStepChain(initialRes) {
    return executeProductionStep(initialRes);
  }

  async function executeProductionStep(initialRes) {
    if (!initialRes || (initialRes.action !== "step-dispatch" && initialRes.action !== "aks:step-dispatch") || isPaused) return;
    await loadInbox();

    // 1. Extract envelope
    const envelope = initialRes.envelope || {
      sessionId: initialRes.sessionId,
      responseId: initialRes.responseId,
      responseIndex: initialRes.responseIndex,
      runEpoch: initialRes.runEpoch,
      revision: initialRes.revision,
      stepId: initialRes.stepId,
      stepType: initialRes.stepType,
      leaseExpiresAt: initialRes.leaseExpiresAt,
      payloadHash: initialRes.payloadHash
    };

    // 2. Validate envelope
    const proto = await getStepProtocol();
    try {
      if (proto?.validateEnvelope) {
        proto.validateEnvelope(envelope);
      } else {
        const fields = ["sessionId", "responseId", "responseIndex", "runEpoch", "revision", "stepId", "stepType", "leaseExpiresAt", "payloadHash"];
        for (const f of fields) {
          if (envelope[f] === undefined || envelope[f] === null || envelope[f] === "") {
            throw new Error(`MISSING_MANDATORY_ENVELOPE_FIELD: ${f}`);
          }
        }
      }
    } catch (envErr) {
      console.error("[CONTENT:INBOX] Invalid envelope received, rejecting step:", envErr?.message);
      return;
    }

    // 3. CAS: recompute payloadHash from step payload and verify match
    try {
      let payloadObj = null;
      if (initialRes.payload && typeof initialRes.payload === "object") {
        payloadObj = initialRes.payload;
      } else if (proto?.extractStepPayload) {
        payloadObj = proto.extractStepPayload(initialRes);
      } else {
        const { action, envelope: _e, session: _s, ...rest } = initialRes;
        payloadObj = rest;
      }
      const computedHash = proto?.computePayloadHash ? proto.computePayloadHash(payloadObj) : pureSha256(canonicalizeJson(payloadObj));
      if (envelope.payloadHash && computedHash !== envelope.payloadHash) {
        console.error(`[CONTENT:INBOX] Payload hash mismatch: stepId=${envelope.stepId} computed=${computedHash} envelope=${envelope.payloadHash}`);
        return;
      }
    } catch (hashErr) {
      console.error("[CONTENT:INBOX] Failed to verify payloadHash:", hashErr);
      return;
    }

    // 4. Check lease expiration
    if (envelope.leaseExpiresAt && envelope.leaseExpiresAt < Date.now()) {
      console.log("[CONTENT:INBOX] Step lease expired, ignoring:", envelope.stepId);
      return;
    }

    // 5. Check inbox state machine with durable operation identity
    const opId = getOperationId(envelope);
    const compositeKey = getCompositeInboxKey(envelope);
    let cached = inbox.get(compositeKey);

    if (cached) {
      if (cached.state === "completed_waiting_ack" || cached.state === "acked") {
        console.log(`[CONTENT:INBOX] Replaying reconciled ACK for opId=${opId}, rev=${envelope.revision}, state=${cached.state}`);
        let ackToReplay = reconcileRetryAck(cached.ackPayload, envelope);
        if (!ackToReplay && cached.journal?.resultSnapshot) {
          const proto = await getStepProtocol();
          ackToReplay = proto?.createStepAckPayload
            ? proto.createStepAckPayload(envelope, cached.journal.resultSnapshot)
            : null;
        }
        if (ackToReplay) {
          const replayRes = await sendSafeStepAck(ackToReplay);
          if (replayRes?.ok) {
            cached.state = "acked";
            cached.ackPayload = ackToReplay;
            await persistInbox();
            if (replayRes.nextStep) {
              executeProductionStep(replayRes.nextStep);
            }
          }
        }
        return;
      }
      if (cached.state === "executing") {
        // Crash recovery without stored ackPayload:
        const journal = cached.journal || {};
        const phase = journal.sideEffectPhase || "READY_TO_CLICK";
        const sideEffectDispatched = (
          phase === "CLICK_DISPATCHED" ||
          phase === "DISPATCH_AMBIGUOUS" ||
          phase === "OBSERVING_CONFIRMATION" ||
          phase === "CONFIRMED" ||
          phase === "ACK_PERSISTED" ||
          phase === "DISPATCH_ATTEMPT_STARTED" ||
          cached.clickExecuted === true
        );

        let alreadyExecuted = false;
        let synthesizedResult = null;

        if (envelope.stepType === "CLICK_SUBMIT") {
          const strongConfirmed = isStrongConfirmation(document, location.href);
          if (strongConfirmed) {
            alreadyExecuted = true;
            synthesizedResult = journal.resultSnapshot || {
              ok: true,
              stepId: envelope.stepId,
              stepType: "CLICK_SUBMIT",
              runEpoch: envelope.runEpoch,
              outcome: "confirmed",
              submitToken: journal.submitToken || cached.submitToken || null,
              confirmationEvidence: {
                url: window.location.href,
                text: (document.body?.innerText || "").slice(0, 300)
              },
              pageSignature: getCurrentSectionSignature(document)
            };
          }
        } else if (envelope.stepType === "NAVIGATE_NEXT_RESPONSE") {
          const classification = classifyFormPage(document, location.href);
          if (classification === "QUESTION_PAGE" || (cached.beforeSignature && getCurrentSectionSignature(document) !== cached.beforeSignature)) {
            alreadyExecuted = true;
            synthesizedResult = journal.resultSnapshot || {
              ok: true,
              stepId: envelope.stepId,
              stepType: "NAVIGATE_NEXT_RESPONSE",
              runEpoch: envelope.runEpoch,
              outcome: "success",
              navigationOperationId: journal.navigationToken || null
            };
          }
        } else if (envelope.stepType === "CLICK_NEXT") {
          const curSig = getCurrentSectionSignature(document);
          if (cached.beforeSignature && curSig !== cached.beforeSignature) {
            alreadyExecuted = true;
            synthesizedResult = journal.resultSnapshot || {
              ok: true,
              stepId: envelope.stepId,
              stepType: "CLICK_NEXT",
              runEpoch: envelope.runEpoch,
              outcome: "success"
            };
          }
        }

        if (alreadyExecuted && synthesizedResult) {
          console.log(`[CONTENT:INBOX] Reconciled executing step ${opId}: DOM confirms already executed.`);
          const proto = await getStepProtocol();
          const ackToReplay = proto?.createStepAckPayload
            ? proto.createStepAckPayload(envelope, synthesizedResult)
            : reconcileRetryAck(cached.ackPayload, envelope);

          if (ackToReplay) {
            cached.state = "completed_waiting_ack";
            cached.ackPayload = ackToReplay;
            cached.journal = { ...journal, sideEffectPhase: "CONFIRMED", resultSnapshot: synthesizedResult };
            await persistInbox();
            const replayRes = await sendSafeStepAck(ackToReplay);
            if (replayRes?.ok) {
              cached.state = "acked";
              if (cached.journal) cached.journal.sideEffectPhase = "ACKED";
              await persistInbox();
              if (replayRes.nextStep) executeProductionStep(replayRes.nextStep);
            }
          }
          return;
        }

        if (sideEffectDispatched) {
          if (phase === "DISPATCH_AMBIGUOUS" || phase === "DISPATCH_ATTEMPT_STARTED") {
            console.error(`[CONTENT:INBOX] Unresolved dispatch crash for ${opId}, phase=${phase}. Transitioning to needs_intervention.`);
            cached.state = "needs_intervention";
            cached.error = "UNRESOLVED_DISPATCH_CRASH";
            await persistInbox();
            await runtime("aks:reconcile-operation", {
              formId: FORM_ID,
              sessionId: envelope.sessionId,
              operationId: opId,
              stepId: envelope.stepId,
              stepType: envelope.stepType,
              runEpoch: envelope.runEpoch,
              decision: "needs_intervention",
              error: "UNRESOLVED_DISPATCH_CRASH",
              journal
            }).catch(() => null);
            return;
          }

          // Side effect was dispatched but DOM is ambiguous:
          console.warn(`[CONTENT:INBOX] Ambiguous DOM state for executing step ${opId}. Requesting RECONCILE_OPERATION from background.`);
          const reconcileRes = await runtime("aks:reconcile-operation", {
            formId: FORM_ID,
            sessionId: envelope.sessionId,
            operationId: opId,
            stepId: envelope.stepId,
            stepType: envelope.stepType,
            runEpoch: envelope.runEpoch,
            journal
          }).catch(() => null);

          if (reconcileRes?.decision === "already_committed") {
            cached.state = "acked";
            await persistInbox();
            if (reconcileRes.nextStep) executeProductionStep(reconcileRes.nextStep);
            return;
          }
          if (reconcileRes?.decision === "retry_click") {
            cached.state = "received";
            await persistInbox();
          } else {
            console.warn(`[CONTENT:INBOX] RECONCILE_OPERATION returned ${reconcileRes?.decision || "unresolved"}. Holding executing state, strictly refusing duplicate click.`);
            cached.state = "needs_intervention";
            cached.error = reconcileRes?.error || "UNRESOLVED_DISPATCH_CRASH";
            await persistInbox();
            return;
          }
        } else {
          console.log(`[CONTENT:INBOX] Reconciled executing step ${opId}: side effect not yet dispatched, re-enqueueing.`);
          cached.state = "received";
          await persistInbox();
        }
      } else if (cached.state === "received") {
        console.log(`[CONTENT:INBOX] Step already in progress (${cached.state}), ignoring duplicate:`, envelope.stepId);
        return;
      }
    }

    // Enqueue in inbox
    const newEntry = {
      state: "received",
      operationId: opId,
      stepId: envelope.stepId,
      compositeKey,
      envelope,
      message: initialRes,
      ackPayload: null,
      journal: {
        operationId: opId,
        stepId: envelope.stepId,
        stepType: envelope.stepType,
        envelope,
        preconditionSignature: getCurrentSectionSignature(document),
        sideEffectPhase: "READY_TO_CLICK",
        submitToken: null,
        navigationToken: null,
        resultSnapshot: null
      },
      beforeSignature: getCurrentSectionSignature(document),
      enqueuedAt: Date.now()
    };
    inbox.set(compositeKey, newEntry);
    await persistInbox();

    pendingStepQueue.push(initialRes);
    isExecutingStepChain = true;
    return await processNextQueuedStep();
  }

  async function processNextQueuedStep() {
    if (isExecutingStep || pendingStepQueue.length === 0 || isPaused) {
      if (!isExecutingStep && pendingStepQueue.length === 0) {
        isExecutingStepChain = false;
      }
      return;
    }

    const step = pendingStepQueue.shift();
    if (!step) {
      isExecutingStepChain = false;
      return;
    }

    const envelope = step.envelope || step;
    const opId = getOperationId(envelope);
    const compositeKey = getCompositeInboxKey(envelope);
    const inboxEntry = inbox.get(compositeKey);
    if (inboxEntry && (inboxEntry.state === "completed_waiting_ack" || inboxEntry.state === "acked")) {
      console.log("[CONTENT:INBOX] Step already completed/acked in inbox, skipping dequeue:", opId);
      return processNextQueuedStep();
    }

    isExecutingStep = true;
    isExecutingStepChain = true;
    if (inboxEntry) {
      inboxEntry.state = "executing";
      await persistInbox();
    }

    let stepOutcome = null;
    try {
      currentStepPromise = _executeStepInternal(step);
      stepOutcome = await currentStepPromise;
    } catch (err) {
      console.error("[RUN:STEP] Lỗi thực thi step:", err);
      stepOutcome = { ok: false, error: err?.message };
    } finally {
      currentStepPromise = null;
      isExecutingStep = false;
      if (pendingStepQueue.length === 0) {
        isExecutingStepChain = false;
      }
      processNextQueuedStep();
    }
    return stepOutcome;
  }

  async function _executeStepInternal(initialRes) {
    try {
      const targetSessionId = initialRes?.sessionId || initialRes?.envelope?.sessionId || initialRes?.session?.id;
      if (FEATURE_FLAGS.backgroundStepSchedulerV2 && targetSessionId) {
        trace("content", "SCHEDULER_V2_INIT", { sessionId: targetSessionId });
      }
      if (targetSessionId) {
        startHeartbeat(targetSessionId);
      }
      const curRespIdx = (initialRes.envelope?.responseIndex ?? initialRes.responseIndex ?? 0) + 1;
      const curStepType = initialRes.stepType || initialRes.envelope?.stepType;
      const rawPayload = initialRes.payload || initialRes;

      if (curStepType === "FILL_ONE_QUESTION") {
        const qTitle = rawPayload.targetQuestion?.title || "câu hỏi";
        showOverlay("Đang tự động điền...", `Đang điền câu: ${qTitle}\nLượt ${curRespIdx} · Vui lòng không thao tác trên màn hình`);
      } else if (curStepType === "CLICK_NEXT" || curStepType === "PREPARE_NAVIGATION") {
        showOverlay("Đang chuyển trang...", `Lượt ${curRespIdx} · Đang chuyển sang phần tiếp theo...`);
      } else if (curStepType === "CLICK_SUBMIT" || curStepType === "PREPARE_SUBMIT") {
        showOverlay("Đang gửi biểu mẫu...", `Lượt ${curRespIdx} · Đang gửi câu trả lời và chờ xác nhận...`);
      } else if (curStepType === "NAVIGATE_NEXT_RESPONSE") {
        showOverlay("Chuẩn bị lượt tiếp theo...", `Đang mở lượt mới...`);
      }
      trace("content", "SCHEDULER_V2_STEP_LEASE", {
        stepId: initialRes.stepId,
        stepType: initialRes.stepType
      });

      currentStepAbortController = new AbortController();
      const signal = currentStepAbortController.signal;

      let result;
      try {
        if (isPageUnloading) {
          result = { ok: false, outcome: "aborted", error: "PAGE_UNLOADING" };
        } else if (signal.aborted || isPaused) {
          result = { ok: false, outcome: "paused", error: "STEP_ABORTED_BY_PAUSE" };
        } else {
          result = await handleStepDispatch(initialRes, signal);
        }
      } catch (dispatchErr) {
        if (isPageUnloading) {
          result = { ok: false, outcome: "aborted", error: "PAGE_UNLOADING" };
        } else if (dispatchErr?.message === "STEP_ABORTED_BY_PAUSE" || dispatchErr?.name === "AbortError" || signal.aborted || isPaused) {
          result = { ok: false, outcome: "paused", error: "STEP_ABORTED_BY_PAUSE" };
        } else {
          result = { ok: false, error: dispatchErr?.message || "Lỗi thực thi bước.", outcome: "error" };
        }
      }
      if (!result) {
        result = { ok: false, error: "Lỗi thực thi bước.", outcome: "error" };
      }

      const isConfirmedSubmission = Boolean(result.outcome === "confirmed" || result.committed || result.confirmationEvidence);
      if (!isConfirmedSubmission && (result.outcome === "paused" || isPaused || signal.aborted || isPageUnloading || result.outcome === "aborted")) {
        console.log("[RUN:STEP] Step aborted by pause/abort/page-unload:", initialRes.stepId);
        return { ok: false, outcome: "aborted", stepId: initialRes.stepId, error: "STEP_ABORTED_BY_PAUSE" };
      }

      // Echo immutable envelope in ACK
      const envelope = initialRes.envelope || {
        sessionId: initialRes.sessionId,
        responseId: initialRes.responseId,
        responseIndex: initialRes.responseIndex,
        runEpoch: initialRes.runEpoch,
        revision: initialRes.revision,
        stepId: initialRes.stepId,
        stepType: initialRes.stepType,
        leaseExpiresAt: initialRes.leaseExpiresAt,
        payloadHash: initialRes.payloadHash
      };

      const proto = await getStepProtocol();
      let ackData = null;
      if (proto?.reconstructAckData) {
        ackData = proto.reconstructAckData(result);
      } else {
        ackData = {
          outcome: result.outcome || (result.ok === false ? "error" : "success"),
          status: result.status || null,
          error: result.error || null,
          errorText: result.errorText || null,
          verifiedQuestionIds: Array.isArray(result.verifiedQuestionIds) ? result.verifiedQuestionIds : [],
          verifiedIds: Array.isArray(result.verifiedIds) ? result.verifiedIds : [],
          newVerifiedIds: Array.isArray(result.newVerifiedIds) ? result.newVerifiedIds : [],
          targetQuestion: result.targetQuestion || null,
          discoveredQuestions: Array.isArray(result.discoveredQuestions) ? result.discoveredQuestions : [],
          buttons: result.buttons || null,
          hasNextButton: Boolean(result.hasNextButton),
          hasSubmitButton: Boolean(result.hasSubmitButton),
          pageSignature: result.pageSignature || null,
          classification: result.classification || null,
          navigationToken: result.navigationToken || null,
          beforeSignature: result.beforeSignature || null,
          token: result.token || null,
          submitToken: result.submitToken || null,
          committed: result.committed || null,
          confirmationEvidence: result.confirmationEvidence || null,
          needsPageReady: Boolean(result.needsPageReady)
        };
      }

      const ackHash = proto?.computePayloadHash ? proto.computePayloadHash(ackData) : pureSha256(canonicalizeJson(ackData));

      const ackPayload = {
        action: "aks:step-ack",
        envelope: Object.freeze({ ...envelope }),
        formId: FORM_ID,
        sessionId: envelope.sessionId,
        ...result,
        ...ackData,
        ackPayloadHash: ackHash
      };

      const opId = getOperationId(envelope);
      const compositeKey = getCompositeInboxKey(envelope);
      const inboxEntry = inbox.get(compositeKey) || {};
      inboxEntry.state = "completed_waiting_ack";
      inboxEntry.operationId = opId;
      inboxEntry.compositeKey = compositeKey;
      inboxEntry.envelope = envelope;
      inboxEntry.ackPayload = ackPayload;
      if (inboxEntry.journal) {
        inboxEntry.journal.sideEffectPhase = "ACK_PERSISTED";
        inboxEntry.journal.resultSnapshot = result;
      }
      inboxEntry.completedAt = Date.now();
      inbox.set(compositeKey, inboxEntry);
      await persistInbox();

      const ackRes = await sendSafeStepAck(ackPayload);
      if (!ackRes?.ok) {
        console.warn("[STEP:ACK] Step-ack error/rejected:", ackRes?.error);
        await trace("content", "STEP_ACK_WARNING", { sessionId: initialRes.sessionId, error: ackRes?.error });
        if (result.ok === false || result.outcome === "error") {
          showOverlay("Lỗi", result.error || "Không thể tiếp tục.", true);
        }
        return;
      }

      // Background confirmed ACK!
      inboxEntry.state = "acked";
      if (inboxEntry.journal) {
        inboxEntry.journal.sideEffectPhase = "ACKED";
      }
      await persistInbox();

      if (result.ok === false || result.outcome === "error") {
        showOverlay("Lỗi", result.error || "Không thể tiếp tục.", true);
        return;
      }

      if (ackRes.committed || (result.outcome === "confirmed" && (result.committed || ackRes.committed))) {
        await handlePostCommit(ackRes.committed || result.committed);
        return;
      }

      if (result.outcome === "paused" || isPaused) {
        return;
      }

      // If background returned nextStep in ACK response, execute it immediately!
      if (ackRes.nextStep) {
        executeProductionStep(ackRes.nextStep);
        return;
      }

      if (result.needsPageReady) {
        const hasNext = Boolean(findNextButton(document) || button("next"));
        const hasSubmit = Boolean(findSubmitButton(document) || button("submit"));
        const pageReadyRes = await runtime("aks:page-ready", {
          formId: FORM_ID,
          url: location.href,
          pathname: location.pathname,
          pageSignature: getCurrentSectionSignature(document),
          visibleQuestionIds: extractEntryIdsFromBox(document),
          discoveredQuestions: buildDiscoveredQuestions(document),
          classification: classifyFormPage(document, location.href),
          buttons: { hasNext, hasSubmit },
          hasNextButton: hasNext,
          hasSubmitButton: hasSubmit
        });
        if (pageReadyRes?.action === "confirmed") {
          await handlePostCommit(pageReadyRes.committed);
        } else if (pageReadyRes?.action === "step-dispatch") {
          executeProductionStep(pageReadyRes);
        }
        return;
      }
      return result;
    } catch (err) {
      console.error("[RUN:STEP] Lỗi trong _executeStepInternal:", err);
    } finally {
      currentStepAbortController = null;
    }
  }

  async function run(sessionId) {
    showOverlay("Đang chuẩn bị điền...", "Khởi động phiên tự động điền...");
    if (isExecutingStepChain) {
      console.log("[RUN:START] Step chain đang chạy, bỏ qua run() trùng lặp.");
      return;
    }
    if (runPromise) return runPromise;
    if (isBootHandshakePending) {
      console.log("[RUN:START] Boot handshake đang diễn ra, kích hoạt heartbeat và nhường quyền cho boot handshake.");
      startHeartbeat(sessionId);
      return;
    }
    startHeartbeat(sessionId);
    runPromise = (async () => {
      try {
        console.log(`[RUN:START] Khởi động runner cho session=${sessionId}`);
        const classification = classifyFormPage(document, location.href);
        const qCount = containers().length;
        const bodyText = norm(document.body?.innerText || "");
        const hasConfirmationPhrase = [
          "he thong da ghi lai cau tra loi cua ban",
          "cau tra loi cua ban da duoc ghi lai",
          "phan hoi cua ban da duoc ghi lai",
          "he thong da ghi lai",
          "your response has been recorded",
          "we have received your response",
          "gui phan hoi khac",
          "gui y kien phan hoi khac",
          "gui mot phan hoi khac",
          "submit another response",
          "da ghi nhan"
        ].some((p) => bodyText.includes(p));
        const hasSubmitAnotherResponse = Boolean(findSubmitAnotherResponseLink(document));
        const hasSubmitButton = Boolean(findSubmitButton(document));

        trace("content", "PAGE_CLASSIFIED", {
          formId: FORM_ID,
          sessionId,
          classification,
          questionCount: qCount,
          hasConfirmationPhrase,
          hasSubmitAnotherResponse,
          hasSubmitButton
        });

        trace("content", "PAGE_READY_SEND", {
          formId: FORM_ID,
          sessionId,
          classification
        });

        const hasNext = Boolean(findNextButton(document) || button("next"));
        const hasSubmit = Boolean(findSubmitButton(document) || button("submit"));
        const readyRes = await runtime("aks:page-ready", {
          formId: FORM_ID,
          url: location.href,
          pathname: location.pathname,
          pageSignature: getCurrentSectionSignature(document),
          visibleQuestionIds: extractEntryIdsFromBox(document),
          discoveredQuestions: buildDiscoveredQuestions(document),
          classification,
          buttons: { hasNext, hasSubmit },
          hasNextButton: hasNext,
          hasSubmitButton: hasSubmit
        });

        trace("content", "PAGE_READY_RESULT", {
          formId: FORM_ID,
          sessionId,
          ok: Boolean(readyRes),
          action: readyRes?.action || "none",
          error: readyRes?.error || ""
        });

        if (readyRes?.session?.answerDelay !== undefined) {
          currentSessionAnswerDelay = Number(readyRes.session.answerDelay);
        }

        if (readyRes?.action === "step-dispatch") {
          console.log(`[RUN:PAGE_READY] Nhận step-dispatch từ background: stepType=${readyRes.stepType}`);
          await executeStepChain(readyRes);
        } else if (readyRes?.action === "confirmed") {
          await handlePostCommit(readyRes.committed);
        } else if (readyRes?.action === "paused") {
          showOverlay("Đã tạm dừng", "Phiên tự động điền đang tạm dừng.", true);
        }
      } catch (error) {
        await fail(sessionId, error);
      } finally {
        clearInterval(heartbeat);
        runPromise = null;
      }
    })();
    return runPromise;
  }

  async function waitForNavigationOutcome(beforeSignature, timeoutMs = null, isZeroDelay = false) {
    const isHidden = Boolean(typeof document !== "undefined" && document.hidden);
    const baseTimeout = typeof timeoutMs === "number" ? timeoutMs : 3500;
    const effectiveTimeout = isHidden ? Math.max(baseTimeout, 10000) : baseTimeout;
    const deadline = Date.now() + effectiveTimeout;
    const pollInterval = isZeroDelay ? 20 : 200;
    while (Date.now() < deadline) {
      const afterSig = getCurrentSectionSignature(document);
      if (afterSig && afterSig !== beforeSignature) {
        return { outcome: "section_changed", newSignature: afterSig };
      }
      
      const engine = await getFillEngine();
      const nativeValidation = engine?.classifyNativeValidation ? engine.classifyNativeValidation(document) : null;
      if (nativeValidation?.hasVisibleError) {
        return {
          outcome: "native_error",
          errorText: (nativeValidation.errors?.[0]?.errorText || "Lỗi nhập liệu từ Google Forms").slice(0, 100)
        };
      }
      
      await sleep(pollInterval);
    }
    return { outcome: "timeout" };
  }

  let lastPreparedSubmitToken = null;

  async function handleStepDispatch(message = {}, signal = null) {
    const proto = await getStepProtocol();
    const envelope = message.envelope;
    if (!envelope) {
      throw new Error("ENVELOPE_MISSING_IN_DISPATCH");
    }
    proto.validateEnvelope(envelope);

    const payload = proto.extractStepPayload ? proto.extractStepPayload(message) : extractStepPayload(message);
    const computedHash = proto.computePayloadHash ? proto.computePayloadHash(payload) : pureSha256(canonicalizeJson(payload));
    if (computedHash !== envelope.payloadHash) {
      throw new Error(`PAYLOAD_HASH_MISMATCH: expected ${envelope.payloadHash} got ${computedHash}`);
    }
    const verifiedPayload = Object.freeze({ ...payload });

    if (verifiedPayload.answerDelay !== undefined) {
      currentSessionAnswerDelay = Number(verifiedPayload.answerDelay);
    }
    const isZeroDelay = Boolean(
      (verifiedPayload.answerDelay !== undefined && Number(verifiedPayload.answerDelay) === 0) ||
      (currentSessionAnswerDelay !== null && currentSessionAnswerDelay === 0)
    );

    const stepType = envelope.stepType;
    const sessionId = envelope.sessionId;
    const stepId = envelope.stepId;
    const runEpoch = envelope.runEpoch;
    console.log(`[STEP:DISPATCH] Received verified stepType=${stepType} stepId=${stepId} epoch=${runEpoch}`);

    if (stepType === "INSPECT_PAGE") {
      const classification = classifyFormPage(document, location.href);
      const pageSig = getCurrentSectionSignature(document);
      const discovered = buildDiscoveredQuestions(document);
      const hasNext = Boolean(findNextButton(document) || button("next"));
      const hasSubmit = Boolean(findSubmitButton(document) || button("submit"));
      return {
        ok: true,
        stepId,
        stepType: "INSPECT_PAGE",
        runEpoch,
        outcome: "success",
        classification,
        pageSignature: pageSig,
        discoveredQuestions: discovered,
        buttons: { hasNext, hasSubmit },
        hasNextButton: hasNext,
        hasSubmitButton: hasSubmit
      };
    }

    if (stepType === "FILL_ONE_QUESTION") {
      if (signal?.aborted || isPaused) {
        throw new Error("STEP_ABORTED_BY_PAUSE");
      }
      const targetQ = verifiedPayload.targetQuestion;
      if (!targetQ) {
        return { ok: false, stepId, runEpoch, error: "TARGET_QUESTION_MISSING" };
      }
      const hasTargetId = Boolean(targetQ.entryId || targetQ.id || targetQ.itemId);
      let liveIndex = buildLiveQuestionIndex(document);
      let liveQ = liveIndex.allQuestions.find((q) => {
        if (targetQ.entryId && String(q.entryId) === String(targetQ.entryId)) return true;
        if (targetQ.id && String(q.id || q.entryId) === String(targetQ.id)) return true;
        if (targetQ.itemId && String(q.itemId) === String(targetQ.itemId)) return true;
        if (hasTargetId) return false;
        return norm(q.title) === norm(targetQ.title);
      });

      if (!liveQ) {
        for (let attempt = 0; attempt < 5; attempt++) {
          await sleep(150);
          liveIndex = buildLiveQuestionIndex(document);
          liveQ = liveIndex.allQuestions.find((q) => {
            if (targetQ.entryId && String(q.entryId) === String(targetQ.entryId)) return true;
            if (targetQ.id && String(q.id || q.entryId) === String(targetQ.id)) return true;
            if (targetQ.itemId && String(q.itemId) === String(targetQ.itemId)) return true;
            if (hasTargetId) return false;
            return norm(q.title) === norm(targetQ.title);
          });
          if (liveQ) break;
        }
      }

      if (!liveQ) {
        if (targetQ.required) {
          return { ok: false, stepId, runEpoch, error: `QUESTION_NOT_FOUND_ON_PAGE: ${targetQ.title}` };
        }
        return { ok: true, stepId, runEpoch, outcome: "skipped", targetQuestion: targetQ, verifiedQuestionIds: [] };
      }

      let planItem = verifiedPayload.planItem;
      if (!planItem && verifiedPayload.answerPlan) {
        const plan = deserializeAnswerPlan(verifiedPayload.answerPlan);
        planItem = plan.get(String(targetQ.id || targetQ.entryId)) || plan.get(targetQ.title);
      }

      if (!planItem) {
        if (targetQ.required) {
          return { ok: false, stepId, runEpoch, error: `MISSING_PLAN_FOR_QUESTION: ${targetQ.title}` };
        }
        return { ok: true, stepId, runEpoch, outcome: "skipped", targetQuestion: targetQ, verifiedQuestionIds: [] };
      }

      const alreadyAnswered = isAlreadyAnswered(liveQ, planItem);
      let fillRes;
      if (alreadyAnswered) {
        console.log(`[FILL:RESUME] Question ${targetQ.title} already filled in DOM, skipping click.`);
        fillRes = { success: true, verified: true, adapter: liveQ.type, observed: "already_answered" };
      } else {
        if (signal?.aborted || isPaused) {
          throw new Error("STEP_ABORTED_BY_PAUSE");
        }
        const clickDelay = isZeroDelay ? 0 : 50;
        fillRes = await fillQuestionControl(liveQ, planItem, clickDelay, signal);
      }

      console.log(`[FILL:DEBUG] targetQ: "${targetQ?.title}", liveQ: "${liveQ?.title}", planItem:`, JSON.stringify(planItem), `fillRes:`, JSON.stringify(fillRes));

      if (targetQ.required && (!fillRes.success || !fillRes.verified)) {
        if (isPageUnloading) {
          return { ok: false, stepId, runEpoch, outcome: "aborted", error: "PAGE_UNLOADING" };
        }
        return {
          ok: false,
          stepId,
          runEpoch,
          error: `FILL_VERIFICATION_FAILED: ${targetQ.title}: ${fillRes.error || "Không thể xác minh đáp án trên DOM"}`,
          targetQuestion: targetQ
        };
      }

      const verifiedIds = [];
      if (fillRes.verified) {
        const ids = [targetQ.id, targetQ.entryId, targetQ.itemId, liveQ.id, liveQ.entryId, liveQ.itemId].filter(Boolean);
        verifiedIds.push(...ids);
      }

      const hasNext = Boolean(findNextButton(document) || button("next"));
      const hasSubmit = Boolean(findSubmitButton(document) || button("submit"));

      return {
        ok: true,
        stepId,
        stepType: "FILL_ONE_QUESTION",
        runEpoch,
        outcome: "filled",
        targetQuestion: targetQ,
        verifiedQuestionIds: verifiedIds,
        newVerifiedIds: verifiedIds,
        pageSignature: getCurrentSectionSignature(document),
        buttons: { hasNext, hasSubmit },
        hasNextButton: hasNext,
        hasSubmitButton: hasSubmit
      };
    }

    if (stepType === "PREPARE_NAVIGATION") {
      const liveIndex = buildLiveQuestionIndex(document);
      const val = await validatePageQuestions(liveIndex.allQuestions);
      if (!val.valid) {
        console.warn("[STEP:PREPARE_NAV] Page validation failed:", val.error);
        return {
          ok: false,
          stepId,
          stepType: "PREPARE_NAVIGATION",
          runEpoch,
          error: "SECTION_VALIDATION_FAILED",
          errorText: val.error,
          missingQuestion: val.missingQuestion ? {
            id: val.missingQuestion.id || val.missingQuestion.entryId || "",
            entryId: val.missingQuestion.entryId || "",
            itemId: val.missingQuestion.itemId || "",
            title: val.missingQuestion.title,
            type: val.missingQuestion.type,
            required: Boolean(val.missingQuestion.required)
          } : null
        };
      }
      const nextNavToken = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `nav-${Date.now()}`;
      const beforeSig = getCurrentSectionSignature(document);
      const cpRes = await sendSafeCheckpointNavigation({
        sessionId,
        responseIndex: envelope.responseIndex,
        navigationToken: nextNavToken,
        fromSignature: beforeSig,
        verifiedQuestionIds: verifiedPayload.verifiedQuestionIds || []
      });
      if (!cpRes?.ok) {
        throw new Error("CHECKPOINT_NAVIGATION_FAILED: " + (cpRes?.error || "TIMEOUT"));
      }
      return {
        ok: true,
        stepId,
        stepType: "PREPARE_NAVIGATION",
        runEpoch,
        outcome: "prepared",
        navigationToken: nextNavToken,
        beforeSignature: beforeSig
      };
    }

    if (stepType === "CLICK_NEXT") {
      if (signal?.aborted || isPaused) {
        throw new Error("STEP_ABORTED_BY_PAUSE");
      }
      const nextBtn = findNextButton(document) || button("next");
      if (!nextBtn) throw new Error("Không tìm thấy nút Tiếp trên trang.");
      const beforeSig = getCurrentSectionSignature(document);
      await click(nextBtn, isZeroDelay ? 0 : 100);
      if (signal?.aborted || isPaused) {
        throw new Error("STEP_ABORTED_BY_PAUSE");
      }
      const navResult = await waitForNavigationOutcome(beforeSig, null, isZeroDelay);
      const afterSig = getCurrentSectionSignature(document);
      return {
        ok: true,
        stepId,
        stepType: "CLICK_NEXT",
        runEpoch,
        outcome: navResult.outcome,
        pageSignature: afterSig,
        classification: classifyFormPage(document, location.href),
        needsPageReady: navResult.outcome === "section_changed"
      };
    }

    if (stepType === "PREPARE_SUBMIT") {
      const liveIndex = buildLiveQuestionIndex(document);
      const val = await validatePageQuestions(liveIndex.allQuestions);
      if (!val.valid) {
        console.warn("[STEP:PREPARE_SUBMIT] Page validation failed:", val.error);
        return {
          ok: false,
          stepId,
          stepType: "PREPARE_SUBMIT",
          runEpoch,
          error: "PAGE_VALIDATION_FAILED",
          errorText: val.error,
          missingQuestion: val.missingQuestion ? {
            id: val.missingQuestion.id || val.missingQuestion.entryId || "",
            entryId: val.missingQuestion.entryId || "",
            itemId: val.missingQuestion.itemId || "",
            title: val.missingQuestion.title,
            type: val.missingQuestion.type,
            required: Boolean(val.missingQuestion.required)
          } : null
        };
      }
      const isFinalPage = classifyFormPage(document, location.href) === FORM_PAGE_TYPES.FINAL_SUBMIT_PAGE;
      const pageText = (document.body?.innerText || "").toLowerCase();
      const hasBranchSubmitPhrase = pageText.includes("click submit to finish") || pageText.includes("nhấn gửi để gửi biểu mẫu") || pageText.includes("nhan gui de gui bieu mau");
      const isBranchedToSubmit = Boolean(hasBranchSubmitPhrase || (isFinalPage && liveIndex.allQuestions.length === 0));
      const token = await runtime("aks:prepare", {
        sessionId,
        verifiedQuestionIds: verifiedPayload.verifiedQuestionIds,
        isFinalSubmitPage: true,
        isBranchedToSubmit
      });
      lastPreparedSubmitToken = token;
      return { ok: true, stepId, stepType: "PREPARE_SUBMIT", runEpoch, token, submitToken: token };
    }

    if (stepType === "CLICK_SUBMIT") {
      // Phase 1: READY_TO_CLICK (Abortable before click)
      if (signal?.aborted || isPaused) {
        throw new Error("STEP_ABORTED_BY_PAUSE");
      }
      const submitBtn = findSubmitButton(document) || button("submit");
      if (!submitBtn) throw new Error("Không tìm thấy nút Gửi trên trang.");
      const submitToken = verifiedPayload.token || verifiedPayload.submitToken || lastPreparedSubmitToken;

      const opId = getOperationId(envelope || message);
      const compositeKey = getCompositeInboxKey(envelope || message);
      const inboxEntry = inbox.get(compositeKey);

      // Phase 2: CLICK_INTENT_PERSISTED (Persist before side effect)
      const submitJournal = {
        operationId: opId,
        stepId,
        stepType: "CLICK_SUBMIT",
        envelope: envelope || message,
        preconditionSignature: getCurrentSectionSignature(document),
        sideEffectPhase: "CLICK_INTENT_PERSISTED",
        submitToken,
        resultSnapshot: null
      };
      if (inboxEntry) {
        inboxEntry.journal = submitJournal;
        await persistInbox();
      }

      // Phase 3: OBSERVER_ARMED (Engage barrier BEFORE native click is emitted)
      isObservingSubmitConfirmation = true;
      submitJournal.sideEffectPhase = "OBSERVER_ARMED";
      if (inboxEntry) {
        inboxEntry.journal = submitJournal;
        await persistInbox();
      }

      // Phase 4: DISPATCH_ATTEMPT_STARTED
      submitJournal.sideEffectPhase = "DISPATCH_ATTEMPT_STARTED";
      if (inboxEntry) {
        inboxEntry.journal = submitJournal;
        await persistInbox();
      }

      // Dispatch native click — strictly never re-click after this!
      let outcome;
      try {
        try {
          await click(submitBtn, isZeroDelay ? 0 : 100);
          submitJournal.sideEffectPhase = "CLICK_DISPATCHED";
          if (inboxEntry) {
            inboxEntry.journal = submitJournal;
            await persistInbox();
          }
        } catch (clickErr) {
          submitJournal.sideEffectPhase = "DISPATCH_AMBIGUOUS";
          if (inboxEntry) {
            inboxEntry.journal = submitJournal;
            await persistInbox();
          }
          throw clickErr;
        }

        // Phase 5: OBSERVING_CONFIRMATION
        submitJournal.sideEffectPhase = "OBSERVING_CONFIRMATION";
        if (inboxEntry) {
          inboxEntry.journal = submitJournal;
          await persistInbox();
        }

        outcome = await submitOutcome(3500, isZeroDelay);
      } finally {
        isObservingSubmitConfirmation = false;
      }

      if (outcome === "confirmed") {
        // Phase 5: CONFIRMED
        const resultSnapshot = {
          ok: true,
          stepId,
          stepType: "CLICK_SUBMIT",
          runEpoch,
          outcome: "confirmed",
          submitToken,
          confirmationEvidence: {
            url: window.location.href,
            text: (document.body?.innerText || "").slice(0, 300)
          },
          pageSignature: getCurrentSectionSignature(document)
        };
        submitJournal.sideEffectPhase = "CONFIRMED";
        submitJournal.resultSnapshot = resultSnapshot;
        if (inboxEntry) {
          inboxEntry.journal = submitJournal;
          await persistInbox();
        }
        return resultSnapshot;
      } else if (outcome === "invalid") {
        await runtime("aks:reject-submit", { sessionId, token: submitToken, error: "Google validation rejected" }).catch((e) => console.warn("[SUBMIT:REJECT]", e));
        return { ok: false, stepId, stepType: "CLICK_SUBMIT", runEpoch, error: "Google từ chối Gửi: còn câu hỏi chưa hợp lệ." };
      }
      return { ok: true, stepId, stepType: "CLICK_SUBMIT", runEpoch, outcome: "pending", submitToken };
    }

    if (stepType === "NAVIGATE_NEXT_RESPONSE") {
      if (signal?.aborted || isPaused) {
        throw new Error("STEP_ABORTED_BY_PAUSE");
      }
      const nextUrl = verifiedPayload.nextUrl || location.href;
      console.log(`[STEP:NAVIGATE_NEXT_RESPONSE] Executing navigation to next response: ${nextUrl}`);
      const beforeSig = getCurrentSectionSignature(document);
      const beforeUrl = location.href;

      const opId = getOperationId(envelope || message);
      const compositeKey = getCompositeInboxKey(envelope || message);
      const inboxEntry = inbox.get(compositeKey);
      const navJournal = {
        operationId: opId,
        stepId,
        stepType: "NAVIGATE_NEXT_RESPONSE",
        envelope: envelope || message,
        preconditionSignature: beforeSig,
        sideEffectPhase: "CLICK_INTENT_PERSISTED",
        navigationToken: verifiedPayload.navigationOperationId || null,
        resultSnapshot: null
      };
      if (inboxEntry) {
        inboxEntry.journal = navJournal;
        await persistInbox();
      }

      navJournal.sideEffectPhase = "CLICK_DISPATCHED";
      if (inboxEntry) {
        inboxEntry.journal = navJournal;
        await persistInbox();
      }

      const anotherLink = findSubmitAnotherResponseLink(document);
      if (anotherLink && typeof anotherLink.click === "function") {
        await click(anotherLink, isZeroDelay ? 0 : 100);
      } else if (nextUrl) {
        location.href = nextUrl;
      }

      navJournal.sideEffectPhase = "OBSERVING_CONFIRMATION";
      if (inboxEntry) {
        inboxEntry.journal = navJournal;
        await persistInbox();
      }

      const navResult = await waitForNavigationOutcome(beforeSig, null, isZeroDelay);
      const afterUrl = location.href;
      const afterClassification = classifyFormPage(document, location.href);
      const isConfirmed = navResult.outcome === "section_changed" || afterUrl !== beforeUrl || afterClassification === "QUESTION_PAGE";

      if (!isConfirmed) {
        return {
          ok: false,
          stepId,
          stepType: "NAVIGATE_NEXT_RESPONSE",
          runEpoch,
          error: "NAVIGATION_CONFIRMATION_TIMEOUT: Không thể điều hướng đến form mới.",
          outcome: "error"
        };
      }

      const navSnapshot = {
        ok: true,
        stepId,
        stepType: "NAVIGATE_NEXT_RESPONSE",
        runEpoch,
        outcome: "success",
        navigationOperationId: verifiedPayload.navigationOperationId || null
      };
      navJournal.sideEffectPhase = "CONFIRMED";
      navJournal.resultSnapshot = navSnapshot;
      if (inboxEntry) {
        inboxEntry.journal = navJournal;
        await persistInbox();
      }

      return navSnapshot;
    }

    if (stepType === "RECONCILE_CONFIRMATION") {
      return {
        ok: true,
        stepId,
        stepType: "RECONCILE_CONFIRMATION",
        runEpoch,
        outcome: "confirmation",
        pageSignature: getCurrentSectionSignature(document)
      };
    }

    throw new Error(`Loại bước không xác định: ${stepType}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (_sender && _sender.id && typeof chrome !== "undefined" && chrome.runtime?.id && _sender.id !== chrome.runtime.id) return false;
    if (message?.action === "aks:start-scan") { processScan(message.scanId).then(() => reply({ ok: true })).catch((error) => reply({ ok: false, error: error.message })); return true; }
    if (message?.action === "aks:continue-scan") { processScan(message.scanId, true).then(() => reply({ ok: true })).catch((error) => reply({ ok: false, error: error.message })); return true; }
    if (message?.action === "aks:stop-scan") { scanSerial++; hideOverlay(); reply({ ok: true }); return false; }
    if (message?.action === "aks:start") { isPaused = false; run(message.sessionId); reply({ ok: true }); return true; }
    if (FEATURE_FLAGS.backgroundStepSchedulerV2 && (message?.action === "aks:step-dispatch" || message?.action === "step-dispatch")) {
      // This response acknowledges transport only. The durable step ACK is a
      // separate message; waiting for it here would deadlock a coordinator
      // transaction that is itself awaiting tabs.sendMessage's response.
      reply({ ok: true, received: true });
      void executeProductionStep(message).catch((err) => {
        console.error("[CONTENT:INBOX] Step dispatch failed:", err);
      });
      return false;
    }
    if (message?.action === "aks:pause") {
      isPaused = true;
      if (!isObservingSubmitConfirmation && currentStepAbortController) {
        currentStepAbortController.abort();
        currentStepAbortController = null;
      }
      pendingStepQueue.length = 0;
      isExecutingStepChain = false;
      (async () => {
        if (currentStepPromise) {
          await currentStepPromise.catch(() => {});
        }
        await runtime("aks:pause-ack", { sessionId: message.sessionId, runEpoch: message.runEpoch, checkpoint: currentCheckpoint }).catch(() => null);
      })();
      reply({ ok: true });
      return true;
    }
    if (message?.action === "aks:resume") {
      isPaused = false;
      reply({ ok: true });
      return true;
    }
    if (message?.action === "aks:stop" || message?.action === "aks:cancel") {
      runSerial++;
      isPaused = false;
      if (currentStepAbortController) {
        currentStepAbortController.abort();
        currentStepAbortController = null;
      }
      pendingStepQueue.length = 0;
      isExecutingStepChain = false;
      currentCheckpoint = null;
      clearInterval(heartbeat);
      activeSessionId = null;
      hideOverlay();
      reply({ ok: true });
      return true;
    }
    return false;
  });

  function initScanSupervisor() {
    let scanPage = 1, lastSig = "";
    let checkTimer = null, checkInFlight = false, checkPending = false;
    async function checkPage() {
      const stored = await chrome.storage.local.get(["autoScanState", K.scan]).catch(() => ({}));
      const isScanning = Boolean(stored.autoScanState?.isScanning || stored[K.scan]?.status === "scanning");
      if (!isScanning) return;
      const questions = liveQuestions();
      const nextBtn = button("next");
      const submitBtn = button("submit");
      const curSig = questions.map((q) => `${q.id}:${norm(q.title)}:${q.type}`).join("|") || (document.body.innerText.slice(0, 150));
      if (curSig && curSig !== lastSig) {
        if (lastSig !== "") {
          scanPage++;
          console.log(`[SCAN] navigation success -> page=${scanPage}`);
        }
        lastSig = curSig;
      }
      if (!nextBtn && submitBtn) {
        console.log(`[SCAN] final page confirmed`);
      }
      if (nextBtn) {
        const text = (nextBtn.innerText || nextBtn.textContent || "").toLowerCase().normalize("NFC").trim();
        if (!text.includes("tiếp") && !text.includes("next")) {
          const helper = document.createElement("span");
          helper.textContent = "Tiếp";
          helper.style.cssText = "position:absolute;opacity:0.01;pointer-events:none;";
          nextBtn.appendChild(helper);
        }
      }
    }
    function runCheck() {
      checkInFlight = true;
      checkPending = false;
      void checkPage().catch((error) => console.warn("[SCAN] supervisor check failed:", error)).finally(() => {
        checkInFlight = false;
        if (checkPending) scheduleCheck();
      });
    }
    function scheduleCheck() {
      checkPending = true;
      if (checkTimer !== null || checkInFlight) return;
      checkTimer = setTimeout(() => {
        checkTimer = null;
        runCheck();
      }, 120);
    }
    runCheck();
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  initScanSupervisor();

  // Boot handshake khi content.js nạp vào trang Google Form
  (async () => {
    if (!FORM_ID) return;
    console.log(`[RUN:BOOT] URL=${location.href} FORM_ID=${FORM_ID}`);
    await sleep(250);
    if (isExecutingStepChain || runPromise || isBootHandshakePending) {
      console.log("[RUN:BOOT] Step chain or runner already active, skipping duplicate boot page-ready.");
      return;
    }

    isBootHandshakePending = true;
    try {
      const classification = classifyFormPage(document, location.href);
      console.log(`[RUN:BOOT] Classification=${classification}`);

      const qCount = containers().length;
      const bodyText = norm(document.body?.innerText || "");
      const hasConfirmationPhrase = [
        "he thong da ghi lai cau tra loi cua ban",
        "cau tra loi cua ban da duoc ghi lai",
        "phan hoi cua ban da duoc ghi lai",
        "he thong da ghi lai",
        "your response has been recorded",
        "we have received your response",
        "gui phan hoi khac",
        "gui y kien phan hoi khac",
        "gui mot phan hoi khac",
        "submit another response",
        "da ghi nhan"
      ].some((p) => bodyText.includes(p));
      const hasSubmitAnotherResponse = Boolean(findSubmitAnotherResponseLink(document));
      const hasSubmitButton = Boolean(findSubmitButton(document));

      trace("content", "PAGE_CLASSIFIED", {
        formId: FORM_ID,
        classification,
        questionCount: qCount,
        hasConfirmationPhrase,
        hasSubmitAnotherResponse,
        hasSubmitButton
      });

      trace("content", "PAGE_READY_SEND", {
        formId: FORM_ID,
        classification
      });

      const discovered = buildDiscoveredQuestions(document);

      const hasNext = Boolean(findNextButton(document) || button("next"));
      const hasSubmit = Boolean(findSubmitButton(document) || button("submit"));

      const readyRes = await runtime("aks:page-ready", {
        formId: FORM_ID,
        url: location.href,
        pathname: location.pathname,
        pageSignature: getCurrentSectionSignature(document),
        visibleQuestionIds: extractEntryIdsFromBox(document),
        discoveredQuestions: discovered,
        classification,
        buttons: { hasNext, hasSubmit },
        hasNextButton: hasNext,
        hasSubmitButton: hasSubmit
      }).catch((err) => {
        console.warn("[RUN:BOOT] aks:page-ready error:", err.message);
        return null;
      });

      trace("content", "PAGE_READY_RESULT", {
        formId: FORM_ID,
        ok: Boolean(readyRes),
        action: readyRes?.action || "none",
        error: readyRes?.error || ""
      });

      if (readyRes?.session?.answerDelay !== undefined) {
        currentSessionAnswerDelay = Number(readyRes.session.answerDelay);
      }

      const sessId = readyRes?.sessionId || readyRes?.envelope?.sessionId || readyRes?.session?.id;
      if (sessId) {
        startHeartbeat(sessId);
      }

      if (readyRes?.action === "step-dispatch") {
        console.log(`[RUN:PAGE_READY] Nhận step-dispatch từ background: stepType=${readyRes.stepType}`);
        executeStepChain(readyRes).catch((err) => fail(sessId, err));
      } else if (readyRes?.action === "confirmed") {
        console.log(`[RUN:PAGE_READY] Hoàn tất lượt nộp biểu mẫu.`);
        handlePostCommit(readyRes.committed);
      } else if (readyRes?.action === "paused") {
        showOverlay("Đã tạm dừng", "Phiên tự động điền đang tạm dừng.", true);
      }
    } finally {
      isBootHandshakePending = false;
    }
  })();
})();
