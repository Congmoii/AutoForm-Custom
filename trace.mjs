export const TRACE_KEY = "aksRuntimeTrace";
export const MAX_TRACE_ENTRIES = 200;

let traceQueue = Promise.resolve();

export function maskToken(token) {
  if (!token) return "";
  const s = String(token);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-6)}`;
}

export async function trace(source, event, data = {}) {
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
    traceQueue = traceQueue.then(async () => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          const res = await chrome.storage.local.get(TRACE_KEY).catch(() => ({}));
          const list = Array.isArray(res?.[TRACE_KEY]) ? res[TRACE_KEY] : [];
          list.push(entry);
          if (list.length > MAX_TRACE_ENTRIES) {
            list.splice(0, list.length - MAX_TRACE_ENTRIES);
          }
          await chrome.storage.local.set({ [TRACE_KEY]: list }).catch(() => {});
        }
      } catch {}
    });
    await traceQueue;
    return entry;
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[AKS:TRACE] Failed to log trace:", err);
    }
    return null;
  }
}
