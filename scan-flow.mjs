export const SCAN_STATUS = Object.freeze({
  PARSING: "parsing", FILLING: "filling", MANUAL: "awaiting_manual",
  SUBMITTING: "submitting", CONFIRMING: "confirming", COMPLETE: "complete",
  CANCELLED: "cancelled", ERROR: "error"
});

export const SUPPORTED_SCAN_TYPES = Object.freeze(["text", "paragraph", "radio", "checkbox", "select", "date", "time"]);
const supported = new Set(SUPPORTED_SCAN_TYPES), choiceTypes = new Set(["radio", "checkbox", "select"]);
const terminal = new Set([SCAN_STATUS.COMPLETE, SCAN_STATUS.CANCELLED, SCAN_STATUS.ERROR]);
const hasValue = (value) => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== "";
const now = (event) => Number(event?.at) || Date.now();
const copy = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function normalizeRule(rule) {
  if (rule && typeof rule === "object" && !Array.isArray(rule)) {
    const mode = ["fixed", "random", "manual"].includes(rule.mode) ? rule.mode : "fixed";
    return mode === "fixed" ? { mode, value: copy(rule.value) } : { mode };
  }
  return { mode: "fixed", value: copy(rule) };
}

export function normalizeScreening(screening = {}) {
  const result = {};
  const entries = Array.isArray(screening)
    ? screening.filter((item) => item && typeof item === "object" && (item.questionId ?? item.id) != null)
      .map((item) => [item.questionId ?? item.id, item.rule ?? (item.mode ? item : item.value)])
    : Object.entries(screening || {});
  for (const [id, rule] of entries) {
    const key = String(id);
    if (key && !["__proto__", "constructor", "prototype"].includes(key)) result[key] = normalizeRule(rule);
  }
  return result;
}

export const isUnsupportedQuestion = (question = {}) => !supported.has(question.type)
  || (choiceTypes.has(question.type) && !Array.isArray(question.options));

function choiceMatches(question, value) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || !question.options?.length) return false;
  const labels = question.options.map((option) => String(option?.text ?? option));
  return values.every((candidate) => {
    const text = String(candidate ?? "").trim();
    const index = text.match(/^\[(\d+)]$/);
    return index ? Number(index[1]) <= labels.length && Number(index[1]) > 0
      : /^\{[\s\S]+}$/.test(text) || labels.some((label) => label === text);
  });
}

export function manualReason(question = {}, rule, answer) {
  if (hasValue(answer)) return "";
  if (isUnsupportedQuestion(question)) return question.required ? "required_unsupported" : "";
  if (rule?.mode === "manual") return "screening_manual";
  if (rule?.mode === "fixed") {
    if (!hasValue(rule.value)) return question.required ? "screening_empty" : "";
    if (choiceTypes.has(question.type) && !choiceMatches(question, rule.value)) return "screening_invalid";
  }
  if (choiceTypes.has(question.type) && question.required && !question.options?.length) return "missing_options";
  return "";
}

export const questionNeedsManual = (question, rule, answer) => Boolean(manualReason(question, rule, answer));

export function defaultScanAnswer(question = {}, random = Math.random, date = new Date()) {
  const choices = (question.options || []).filter((option) => !option.other);
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

export function analyzeScanQuestions(questions = [], screening = {}, manualAnswers = {}) {
  const rules = normalizeScreening(screening), answers = { ...manualAnswers }, pendingManual = [], unsupported = [];
  for (const question of questions) {
    const questionId = String(question?.id ?? ""), rule = rules[questionId] || rules["*"];
    if (!questionId) { unsupported.push({ questionId, title: question?.title || "", reason: "missing_question_id" }); continue; }
    if (rule?.mode === "fixed" && hasValue(rule.value)) answers[questionId] = copy(rule.value);
    const unsupportedQuestion = isUnsupportedQuestion(question);
    if (unsupportedQuestion) unsupported.push({ questionId, title: question.title || "", reason: "unsupported_type" });
    const reason = manualReason(question, rule, answers[questionId]);
    if (reason) pendingManual.push({ questionId, title: question.title || "", reason });
  }
  return { screening: rules, answers, pendingManual, unsupported, ready: pendingManual.length === 0 };
}

export function createScanState({ id = "", formId = "", formUrl = "", lastGoodQuestions = [], screening = {}, startedAt = Date.now() } = {}) {
  return {
    version: 1, id, formId, formUrl, status: SCAN_STATUS.PARSING, active: true,
    questions: [], lastGoodQuestions: copy(lastGoodQuestions), screening: normalizeScreening(screening),
    answers: {}, pendingManual: [], unsupported: [],
    submit: { token: null, count: 0, clickedAt: null, confirmedAt: null },
    startedAt, updatedAt: startedAt, error: ""
  };
}

function requireStatus(state, ...allowed) {
  if (!allowed.includes(state.status)) throw new Error(`Sự kiện không hợp lệ khi quét đang ở trạng thái ${state.status}.`);
}

function sameToken(state, event) {
  if (!event.token || event.token !== state.submit.token) throw new Error("Mã xác nhận lượt gửi không hợp lệ.");
}

export const hasUnresolvedSubmit = (state = {}) => Boolean(state.submit?.token && !state.submit?.confirmedAt);
export const canSubmit = (state = {}) => state.status === SCAN_STATUS.FILLING && !state.pendingManual?.length
  && !state.submit?.token && Number(state.submit?.count || 0) === 0;
export const effectiveQuestions = (state = {}) => [SCAN_STATUS.ERROR, SCAN_STATUS.CANCELLED].includes(state.status)
  ? state.lastGoodQuestions || [] : state.questions || [];

export function transitionScan(input, event = {}) {
  const state = copy(input), type = event.type, at = now(event);
  if (!state?.status || !type) throw new Error("Thiếu trạng thái hoặc sự kiện quét.");
  if (type === "FAIL" || type === "CANCEL") {
    if (state.status === SCAN_STATUS.COMPLETE) throw new Error("Lượt quét đã hoàn tất.");
    state.status = type === "FAIL" ? SCAN_STATUS.ERROR : SCAN_STATUS.CANCELLED;
    state.active = false; state.error = type === "FAIL" ? String(event.error?.message || event.error || "Quét thất bại.") : "";
    state.updatedAt = at; return state;
  }
  if (terminal.has(state.status)) {
    if (state.status === SCAN_STATUS.COMPLETE && type === "GOOGLE_CONFIRMED" && event.token === state.submit.token) return state;
    throw new Error(`Lượt quét đã kết thúc ở trạng thái ${state.status}.`);
  }
  if (type === "SCHEMA_PARSED") {
    requireStatus(state, SCAN_STATUS.PARSING);
    if (!Array.isArray(event.questions) || !event.questions.length) throw new Error("Không đọc được câu hỏi của Form.");
    const analysis = analyzeScanQuestions(event.questions, state.screening, state.answers);
    Object.assign(state, analysis, { questions: copy(event.questions), status: analysis.ready ? SCAN_STATUS.FILLING : SCAN_STATUS.MANUAL, schemaParsedAt: at, updatedAt: at });
    return state;
  }
  if (type === "MANUAL_ANSWERED") {
    requireStatus(state, SCAN_STATUS.MANUAL, SCAN_STATUS.FILLING);
    const questionId = String(event.questionId ?? "");
    if (!state.questions.some((question) => String(question.id) === questionId)) throw new Error("Câu hỏi thủ công không thuộc Form đang quét.");
    if (hasValue(event.answer)) state.answers[questionId] = copy(event.answer); else delete state.answers[questionId];
    const analysis = analyzeScanQuestions(state.questions, state.screening, state.answers);
    Object.assign(state, analysis, { status: analysis.ready ? SCAN_STATUS.FILLING : SCAN_STATUS.MANUAL, updatedAt: at });
    return state;
  }
  if (type === "PREPARE_SUBMIT") {
    if (state.status === SCAN_STATUS.SUBMITTING && event.token === state.submit.token) return state;
    if (!canSubmit(state)) throw new Error("Lượt quét chưa sẵn sàng để bấm Gửi.");
    if (!event.token) throw new Error("Thiếu mã xác nhận trước khi bấm Gửi.");
    state.status = SCAN_STATUS.SUBMITTING; state.submit.token = String(event.token); state.submit.preparedAt = at; state.updatedAt = at;
    return state;
  }
  if (type === "SUBMIT_CLICKED") {
    if (state.status === SCAN_STATUS.CONFIRMING) { sameToken(state, event); return state; }
    requireStatus(state, SCAN_STATUS.SUBMITTING); sameToken(state, event);
    if (state.submit.count !== 0) throw new Error("Lượt quét chỉ được bấm Gửi đúng một lần.");
    state.submit.count = 1; state.submit.clickedAt = at; state.status = SCAN_STATUS.CONFIRMING; state.updatedAt = at;
    return state;
  }
  if (type === "SUBMIT_REJECTED") {
    requireStatus(state, SCAN_STATUS.SUBMITTING, SCAN_STATUS.CONFIRMING); sameToken(state, event);
    state.status = SCAN_STATUS.FILLING;
    state.submit = { token: null, count: 0, clickedAt: null, confirmedAt: null, rejectedAt: at };
    state.updatedAt = at; state.error = String(event.error || "Google từ chối phản hồi thử.");
    return state;
  }
  if (type === "SCAN_COMPLETED") {
    if (!Array.isArray(event.questions) || !event.questions.length) throw new Error("Không đọc được câu hỏi của Form.");
    state.status = SCAN_STATUS.COMPLETE;
    state.active = false;
    state.questions = copy(event.questions);
    state.lastGoodQuestions = copy(event.questions);
    state.completedAt = at;
    state.updatedAt = at;
    state.error = "";
    return state;
  }
  if (type === "GOOGLE_CONFIRMED") {
    requireStatus(state, SCAN_STATUS.CONFIRMING); sameToken(state, event);
    if (state.submit.count !== 1) throw new Error("Không thể hoàn tất khi chưa bấm Gửi đúng một lần.");
    state.submit.confirmedAt = at; state.status = SCAN_STATUS.COMPLETE; state.active = false;
    state.lastGoodQuestions = copy(state.questions); state.completedAt = at; state.updatedAt = at; state.error = "";
    return state;
  }
  throw new Error(`Sự kiện quét không được hỗ trợ: ${type}.`);
}

export function restoreScanState(raw = {}) {
  const base = createScanState({
    id: raw.id, formId: raw.formId, formUrl: raw.formUrl,
    lastGoodQuestions: raw.lastGoodQuestions || [], screening: raw.screening || {}, startedAt: raw.startedAt
  });
  const state = { ...base, ...copy(raw), screening: normalizeScreening(raw.screening || {}), submit: { ...base.submit, ...(copy(raw.submit) || {}) } };
  state.questions = Array.isArray(state.questions) ? state.questions : [];
  state.lastGoodQuestions = Array.isArray(state.lastGoodQuestions) ? state.lastGoodQuestions : [];
  state.answers = state.answers && typeof state.answers === "object" ? state.answers : {};
  state.pendingManual = Array.isArray(state.pendingManual) ? state.pendingManual : [];
  state.unsupported = Array.isArray(state.unsupported) ? state.unsupported : [];
  state.submit.count = Math.min(1, Math.max(0, Number(state.submit.count) || 0));
  if (state.status === SCAN_STATUS.COMPLETE && state.submit?.token && (state.submit.count !== 1 || !state.submit.confirmedAt)) {
    state.status = SCAN_STATUS.ERROR; state.active = false; state.error = "Trạng thái hoàn tất không có xác nhận hợp lệ từ Google.";
  } else if (!terminal.has(state.status) && state.submit.token && !state.submit.confirmedAt) {
    state.status = state.submit.count === 1 ? SCAN_STATUS.CONFIRMING : SCAN_STATUS.SUBMITTING;
    state.active = true;
  }
  return state;
}
