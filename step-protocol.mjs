// step-protocol.mjs — Protocol dùng chung giữa Background và Content
// Bất biến envelope: sessionId, responseId, responseIndex, runEpoch, revision, stepId, stepType, leaseExpiresAt, payloadHash

export const MANDATORY_ENVELOPE_FIELDS = Object.freeze([
  "sessionId",
  "responseId",
  "responseIndex",
  "runEpoch",
  "revision",
  "stepId",
  "stepType",
  "leaseExpiresAt",
  "payloadHash"
]);

// Chuẩn hóa JSON đệ quy để đảm bảo thứ tự key nhất quán cho hàm băm
export function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : canonicalizeJson(v))).join(",") + "]";
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(value[k])).join(",") + "}";
}

// Thuật toán SHA-256 thuần JS cho môi trường Browser (Content Script) đồng bộ
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

// Băm payload đồng bộ
export function computePayloadHash(data) {
  const json = canonicalizeJson(data);
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      const crypto = globalThis.nodeCrypto || null;
      if (crypto) {
        return crypto.createHash("sha256").update(json).digest("hex");
      }
    } catch {}
  }
  return pureSha256(json);
}

// Khởi tạo Node crypto nếu đang trong môi trường Node
if (typeof process !== "undefined" && process.versions?.node && !globalThis.nodeCrypto) {
  try {
    import("node:crypto").then((m) => {
      globalThis.nodeCrypto = m;
    }).catch(() => {});
  } catch {}
}

// Tạo step envelope bất biến
export function createStepEnvelope({
  sessionId,
  responseId,
  responseIndex,
  runEpoch,
  revision,
  stepId,
  stepType,
  leaseExpiresAt,
  operationId,
  payload = {}
}) {
  const payloadHash = computePayloadHash(payload);
  const envelope = {
    sessionId: String(sessionId ?? ""),
    responseId: String(responseId ?? ""),
    responseIndex: Number(responseIndex ?? 0),
    runEpoch: Number(runEpoch ?? 1),
    revision: Number(revision ?? 1),
    stepId: String(stepId ?? ""),
    stepType: String(stepType ?? ""),
    leaseExpiresAt: Number(leaseExpiresAt ?? 0),
    payloadHash: String(payloadHash ?? ""),
    ...(operationId ? { operationId: String(operationId) } : {})
  };
  validateEnvelope(envelope);
  return Object.freeze(envelope);
}

// Sao chép an toàn step envelope với revision mới mà không mutate envelope cũ
export function cloneEnvelopeWithRevision(envelope, newRevision) {
  validateEnvelope(envelope);
  const rev = Number(newRevision);
  if (!Number.isInteger(rev) || rev <= 0) {
    throw new Error("INVALID_ENVELOPE_FIELD: revision must be positive integer");
  }
  const cloned = {
    sessionId: String(envelope.sessionId ?? ""),
    responseId: String(envelope.responseId ?? ""),
    responseIndex: Number(envelope.responseIndex ?? 0),
    runEpoch: Number(envelope.runEpoch ?? 1),
    revision: rev,
    stepId: String(envelope.stepId ?? ""),
    stepType: String(envelope.stepType ?? ""),
    leaseExpiresAt: Number(envelope.leaseExpiresAt ?? 0),
    payloadHash: String(envelope.payloadHash ?? ""),
    ...(envelope.operationId ? { operationId: String(envelope.operationId) } : {})
  };
  validateEnvelope(cloned);
  return Object.freeze(cloned);
}

// Kiểm tra tính hợp lệ của Envelope: từ chối nếu thiếu bất kỳ trường bắt buộc nào hoặc sai kiểu/miền giá trị
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("ENVELOPE_MISSING_OR_INVALID");
  }
  for (const field of MANDATORY_ENVELOPE_FIELDS) {
    const val = envelope[field];
    if (val === undefined || val === null || val === "") {
      throw new Error(`MISSING_MANDATORY_ENVELOPE_FIELD: ${field}`);
    }
  }

  // Domain & Type validation
  if (typeof envelope.sessionId !== "string" || !envelope.sessionId.trim()) {
    throw new Error("INVALID_ENVELOPE_FIELD: sessionId must be non-empty string");
  }
  if (typeof envelope.responseId !== "string" || !envelope.responseId.trim()) {
    throw new Error("INVALID_ENVELOPE_FIELD: responseId must be non-empty string");
  }
  if (!Number.isInteger(envelope.responseIndex) || envelope.responseIndex < 0) {
    throw new Error("INVALID_ENVELOPE_FIELD: responseIndex must be non-negative integer");
  }
  if (!Number.isInteger(envelope.runEpoch) || envelope.runEpoch <= 0) {
    throw new Error("INVALID_ENVELOPE_FIELD: runEpoch must be positive integer");
  }
  if (!Number.isInteger(envelope.revision) || envelope.revision <= 0) {
    throw new Error("INVALID_ENVELOPE_FIELD: revision must be positive integer");
  }
  if (typeof envelope.stepId !== "string" || !envelope.stepId.trim()) {
    throw new Error("INVALID_ENVELOPE_FIELD: stepId must be non-empty string");
  }
  if (typeof envelope.stepType !== "string" || !envelope.stepType.trim()) {
    throw new Error("INVALID_ENVELOPE_FIELD: stepType must be non-empty string");
  }
  if (!Number.isFinite(envelope.leaseExpiresAt) || envelope.leaseExpiresAt <= 0) {
    throw new Error("INVALID_ENVELOPE_FIELD: leaseExpiresAt must be positive finite number");
  }
  if (typeof envelope.payloadHash !== "string" || !/^[0-9a-f]{64}$/i.test(envelope.payloadHash)) {
    throw new Error("INVALID_ENVELOPE_FIELD: payloadHash must be 64-char hex string");
  }
}

// So sánh tuyệt đối 2 envelope
export function areEnvelopesIdentical(env1, env2) {
  if (!env1 || !env2) return false;
  for (const field of MANDATORY_ENVELOPE_FIELDS) {
    if (String(env1[field]) !== String(env2[field])) {
      return false;
    }
  }
  return true;
}

// Trích xuất hoặc chuẩn hóa payload từ step dispatch message
export function extractStepPayload(message = {}) {
  if (message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  const stepType = message.stepType || message.envelope?.stepType;
  if (stepType === "INSPECT_PAGE") {
    return {
      classification: message.classification || message.pageType,
      pageSignature: message.pageSignature
    };
  }
  if (stepType === "FILL_ONE_QUESTION") {
    return {
      targetQuestion: message.targetQuestion,
      planItem: message.planItem
    };
  }
  if (stepType === "PREPARE_NAVIGATION") {
    return { hasNext: true };
  }
  if (stepType === "CLICK_NEXT") {
    return { action: "CLICK_NEXT" };
  }
  if (stepType === "PREPARE_SUBMIT") {
    return { isFinalPage: true };
  }
  if (stepType === "CLICK_SUBMIT") {
    return { token: message.token || message.submitToken || "" };
  }
  if (stepType === "NAVIGATE_NEXT_RESPONSE") {
    return {
      navigationOperationId: message.navigationOperationId || "",
      nextUrl: message.nextUrl || ""
    };
  }
  return {};
}

// Tái tạo ackData canonical từ ACK message
export function reconstructAckData(message = {}) {
  return {
    outcome: message.outcome || (message.ok === false ? "error" : "success"),
    status: message.status || null,
    error: message.error || null,
    errorText: message.errorText || null,
    verifiedQuestionIds: Array.isArray(message.verifiedQuestionIds) ? message.verifiedQuestionIds : [],
    verifiedIds: Array.isArray(message.verifiedIds) ? message.verifiedIds : [],
    newVerifiedIds: Array.isArray(message.newVerifiedIds) ? message.newVerifiedIds : [],
    targetQuestion: message.targetQuestion || null,
    discoveredQuestions: Array.isArray(message.discoveredQuestions) ? message.discoveredQuestions : [],
    buttons: message.buttons || null,
    hasNextButton: Boolean(message.hasNextButton),
    hasSubmitButton: Boolean(message.hasSubmitButton),
    pageSignature: message.pageSignature || null,
    classification: message.classification || null,
    navigationToken: message.navigationToken || null,
    navigationOperationId: message.navigationOperationId || null,
    beforeSignature: message.beforeSignature || null,
    token: message.token || null,
    submitToken: message.submitToken || null,
    committed: message.committed || null,
    confirmationEvidence: message.confirmationEvidence || null,
    needsPageReady: Boolean(message.needsPageReady)
  };
}

// Tạo ACK payload từ step result và echo envelope
export function createStepAckPayload(envelope, result = {}) {
  validateEnvelope(envelope);
  const ackData = reconstructAckData(result);
  const ackPayloadHash = computePayloadHash(ackData);
  return {
    action: "aks:step-ack",
    envelope: Object.freeze({ ...envelope }),
    ackPayloadHash,
    ...ackData
  };
}

// Durable phases for CLICK_SUBMIT execution
export const SUBMIT_PHASES = Object.freeze({
  READY_TO_CLICK: "READY_TO_CLICK",
  CLICK_INTENT_PERSISTED: "CLICK_INTENT_PERSISTED",
  OBSERVER_ARMED: "OBSERVER_ARMED",
  DISPATCH_ATTEMPT_STARTED: "DISPATCH_ATTEMPT_STARTED",
  CLICK_DISPATCHED: "CLICK_DISPATCHED",
  DISPATCH_AMBIGUOUS: "DISPATCH_AMBIGUOUS",
  OBSERVING_CONFIRMATION: "OBSERVING_CONFIRMATION",
  CONFIRMED: "CONFIRMED",
  ACK_PERSISTED: "ACK_PERSISTED",
  ACKED: "ACKED"
});

// Băm submit token bằng SHA-256 xác định
export function hashSubmitToken(token) {
  const str = String(token ?? "");
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      const crypto = globalThis.nodeCrypto || null;
      if (crypto) {
        return crypto.createHash("sha256").update(str).digest("hex");
      }
    } catch {}
  }
  return pureSha256(str);
}

// Tạo bản ghi commit chuẩn hóa cho bất biến idempotency
export function createCommitRecord({
  sessionId,
  responseId,
  runEpoch,
  operationId,
  stepId,
  submitToken = null,
  submitTokenHash = null
}) {
  const tokenHash = submitTokenHash || (submitToken ? hashSubmitToken(submitToken) : "");
  const record = {
    sessionId: String(sessionId ?? ""),
    responseId: String(responseId ?? ""),
    runEpoch: Number(runEpoch ?? 1),
    operationId: String(operationId ?? ""),
    stepId: String(stepId ?? ""),
    submitTokenHash: String(tokenHash ?? "")
  };
  return Object.freeze(record);
}

// Khóa canonical cho commit record
export function canonicalizeCommitKey(record) {
  if (!record || typeof record !== "object") {
    throw new Error("INVALID_COMMIT_RECORD");
  }
  const sId = String(record.sessionId ?? "");
  const rId = String(record.responseId ?? "");
  const epoch = Number(record.runEpoch ?? 1);
  const opId = String(record.operationId ?? "");
  const stepId = String(record.stepId ?? "");
  const tokHash = String(record.submitTokenHash ?? (record.submitToken ? hashSubmitToken(record.submitToken) : ""));
  return `commit:${sId}:${rId}:${epoch}:${opId}:${stepId}:${tokHash}`;
}

// Khớp chính xác tuyệt đối giữa 2 commit record
export function matchCommitRecord(a, b) {
  if (!a || !b) return false;
  return (
    String(a.sessionId ?? "") === String(b.sessionId ?? "") &&
    String(a.responseId ?? "") === String(b.responseId ?? "") &&
    Number(a.runEpoch ?? 0) === Number(b.runEpoch ?? 0) &&
    String(a.operationId ?? "") === String(b.operationId ?? "") &&
    String(a.stepId ?? "") === String(b.stepId ?? "") &&
    String(a.submitTokenHash ?? "") === String(b.submitTokenHash ?? "")
  );
}

// Create journal entry for crash recovery
export function createJournalEntry({
  operationId,
  stepId,
  stepType,
  envelope,
  preconditionSignature = null,
  sideEffectPhase = "READY_TO_CLICK",
  submitToken = null,
  navigationToken = null,
  resultSnapshot = null
}) {
  return {
    operationId: String(operationId || envelope?.operationId || stepId || ""),
    stepId: String(stepId || envelope?.stepId || ""),
    stepType: String(stepType || envelope?.stepType || ""),
    envelope: envelope ? Object.freeze({ ...envelope }) : null,
    preconditionSignature: preconditionSignature || null,
    sideEffectPhase: String(sideEffectPhase || "READY_TO_CLICK"),
    submitToken: submitToken || null,
    navigationToken: navigationToken || null,
    resultSnapshot: resultSnapshot ? Object.freeze({ ...resultSnapshot }) : null,
    updatedAt: Date.now()
  };
}

// Single canonical composite key in inbox storage
export function getCompositeInboxKey(formIdOrEnvelope, maybeEnvelope) {
  let formId = "form";
  let envelope = null;
  if (maybeEnvelope) {
    formId = typeof formIdOrEnvelope === "string" ? formIdOrEnvelope : "form";
    envelope = maybeEnvelope;
  } else if (typeof formIdOrEnvelope === "object" && formIdOrEnvelope !== null) {
    envelope = formIdOrEnvelope;
    formId = envelope.formId || "form";
  } else if (typeof formIdOrEnvelope === "string") {
    formId = formIdOrEnvelope;
  }
  const fId = formId || "form";
  const sessId = envelope?.sessionId || "sess";
  const epoch = envelope?.runEpoch || 1;
  const opId = envelope?.operationId || envelope?.stepId || "op";
  return `aks:inbox:${fId}:${sessId}:${epoch}:${opId}`;
}
