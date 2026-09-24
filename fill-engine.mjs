/**
 * FILL ENGINE — AUTO KHẢO SÁT v4.0.4 / v2
 * 
 * Kiến trúc độc lập xử lý toàn bộ chu trình:
 * SCAN OUTPUT → ANSWER PLAN → LIVE DOM MAPPING → FILL → VERIFY → NEXT → BRANCH → SUBMIT
 */

// --- 1. CHUẨN HÓA VĂN BẢN VÀ KÝ TỰ ---

export function norm(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function clean(text) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phân tách các token phân cách bởi dấu phẩy, chấm phẩy, hoặc dấu sổ thẳng.
 * Tôn trọng các khối đóng mở ngoặc [] và {}.
 */
export function parseTokens(value) {
  const tokens = [];
  let token = "";
  let depth = 0;
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

/**
 * Phân tích cú pháp lựa chọn:
 * - [1] -> dạng index (1-based)
 * - {Nội dung} -> dạng ô Khác (Other)
 * - "Chuỗi" -> text thông thường
 */
export function parseChoice(value) {
  const text = String(value ?? "").trim();
  const indexMatch = text.match(/^\[(\d+)\]$/);
  if (indexMatch) {
    return { type: "index", index: Number(indexMatch[1]) - 1, raw: text };
  }
  const otherMatch = text.match(/^\{([\s\S]+)\}$/);
  if (otherMatch) {
    return { type: "other", text: otherMatch[1].trim(), raw: text };
  }
  return { type: "text", text, raw: text };
}

// --- 2. RATIO ENGINE & ANSWER PLAN GENERATOR ---

/**
 * Thuật toán phân bổ hạn mức theo tỷ lệ (Largest Remainder Method / Hamilton-Hare).
 * Đảm bảo trên `totalIterations` lượt chạy, số lần chọn từng đáp án khớp chuẩn xác 100% với % cấu hình.
 * 
 * @param {number[]} weights Mảng trọng số tỷ lệ (tổng ~ 100%)
 * @param {number} totalIterations Tổng số lượt chạy
 * @returns {number[]} Mảng phân bổ index cho từng lượt chạy (độ dài = totalIterations)
 */
export function distributeRatioQuotas(weights = [], totalIterations = 1) {
  if (totalIterations <= 0) return [];
  const count = weights.length;
  if (!count) return Array(totalIterations).fill(0);

  const cleanWeights = weights.map((w) => Math.max(0, Number(w || 0)));
  const sumWeights = cleanWeights.reduce((a, b) => a + b, 0);

  // Nếu không có trọng số nào, chia đều
  if (sumWeights === 0) {
    return Array.from({ length: totalIterations }, (_, i) => i % count);
  }

  // Tính số lượng chính xác dạng thập phân
  const exactQuotas = cleanWeights.map((w) => (w / sumWeights) * totalIterations);
  const intQuotas = exactQuotas.map(Math.floor);
  let assignedCount = intQuotas.reduce((a, b) => a + b, 0);
  const remainders = exactQuotas.map((exact, idx) => ({ remainder: exact - intQuotas[idx], idx }));

  // Sắp xếp phần dư giảm dần để phân bổ các suất còn thiếu
  remainders.sort((a, b) => b.remainder - a.remainder);
  let rIdx = 0;
  while (assignedCount < totalIterations && rIdx < remainders.length) {
    intQuotas[remainders[rIdx].idx]++;
    assignedCount++;
    rIdx++;
  }

  // Trải phẳng danh sách lựa chọn theo hạn mức đã chia
  const pool = [];
  intQuotas.forEach((quota, optionIndex) => {
    for (let k = 0; k < quota; k++) {
      pool.push(optionIndex);
    }
  });

  // Xáo trộn có tính quy luật đều (Interleave / Stride) để không dồn cục một đáp án
  if (totalIterations > 1) {
    // Sử dụng bước nhảy nguyên tố cùng nhau với totalIterations
    const stride = 7;
    const distributed = new Array(totalIterations);
    for (let i = 0; i < totalIterations; i++) {
      distributed[(i * stride) % totalIterations] = pool[i];
    }
    return distributed;
  }

  return pool;
}

/**
 * Chọn ngẫu nhiên có trọng số cho 1 lượt đơn lẻ
 */
export function pickWeightedIndex(weights = [], count = 0, excluded = []) {
  if (count <= 0) return -1;
  const values = Array.from({ length: count }, (_, i) =>
    excluded.includes(i) ? 0 : Math.max(0, Number(weights?.[i] || 0))
  );
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const allowed = values.map((_, i) => i).filter((i) => !excluded.includes(i));
    if (!allowed.length) return -1;
    return allowed[Math.floor(Math.random() * allowed.length)];
  }
  let pick = Math.random() * total;
  for (let i = 0; i < values.length; i++) {
    pick -= values[i];
    if (pick <= 0 && values[i] > 0) return i;
  }
  return values.findIndex((v) => v > 0);
}

/**
 * Tìm chỉ mục đáp án tương ứng từ chuỗi hoặc token
 */
export function findOptionIndex(question, token) {
  if (!question || !question.options || !question.options.length) return -1;
  const parsed = parseChoice(token);
  if (parsed.type === "index") {
    return parsed.index >= 0 && parsed.index < question.options.length ? parsed.index : -1;
  }
  if (parsed.type === "other") {
    return question.options.findIndex((o) => o.other || o.isOther);
  }
  // Tìm theo khớp chính xác hoặc khớp chuẩn hóa
  const normalizedTarget = norm(parsed.text);
  const exactIdx = question.options.findIndex((o) => norm(o.text) === normalizedTarget);
  if (exactIdx >= 0) return exactIdx;

  // Khớp mờ nhẹ (nếu option bắt đầu bằng token hoặc ngược lại)
  return question.options.findIndex((o) => {
    const optNorm = norm(o.text);
    return optNorm.startsWith(normalizedTarget) || normalizedTarget.startsWith(optNorm);
  });
}

/**
 * Tạo kế hoạch trả lời (AnswerPlan) hoàn chỉnh trước khi chạm vào Live DOM.
 * 
 * @param {object} params
 * @param {object} params.profile Hồ sơ câu hỏi & cấu hình form
 * @param {object} params.session Phiên chạy hiện tại
 * @param {Array}  params.canonicalQuestions Danh sách câu hỏi kinh điển từ scan
 * @param {object} params.sectionGraph Đồ thị phân nhánh (nếu có)
 * @param {number} params.iterationIndex Lượt chạy hiện tại (0-based)
 * @param {number} params.totalIterations Tổng số lượt chạy
 * @returns {Map<string, object>} Map<entryIdOrId, AnswerPlanItem>
 */
export function generateAnswerPlan({
  profile = {},
  session = {},
  canonicalQuestions = [],
  sectionGraph = null,
  iterationIndex = 0,
  totalIterations = 1
}) {
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

    // Tìm cấu hình cho câu hỏi
    const cfg = config[qId] || config[qTitle] || Object.entries(config).find(([k]) => norm(k) === norm(qTitle))?.[1] || { weights: [], texts: [] };

    // 1. Kiểm tra Explicit Answers (từ session hoặc test)
    let explicitVal = explicitAnswers[qId] ?? explicitAnswers[qTitle];

    // 2. Kiểm tra Screening Rules
    const screenRule = screening[qId] || screening[qTitle] || Object.entries(screening).find(([k]) => norm(k) === norm(qTitle))?.[1];
    if (explicitVal === undefined && screenRule && screenRule.mode === "fixed") {
      explicitVal = screenRule.value;
    }

    // 3. Đọc dữ liệu từ CSV nếu nguồn là CSV
    let csvVal = undefined;
    if (source === "csv" && row) {
      const csvKey = Object.keys(row).find((h) => h === qId || norm(h) === norm(qTitle));
      if (csvKey !== undefined) csvVal = row[csvKey];
    }

    const value = explicitVal !== undefined ? explicitVal : (source === "csv" ? csvVal : undefined);

    let planItem = {
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
      let chosenIndex = -1;
      let otherText = "";

      if (value !== undefined && String(value).trim() !== "") {
        const parsed = parseChoice(value);
        chosenIndex = findOptionIndex(q, value);
        if (parsed.type === "other") {
          otherText = parsed.text;
        }
      } else {
        // Áp dụng tỷ lệ
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
        if (opt.targetSectionId !== undefined) {
          planItem.targetSectionId = opt.targetSectionId;
        }
      }
    } else if (qType === "checkbox") {
      let selectedIndices = [];
      let otherText = "";

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
        // Tỷ lệ cho checkbox: mỗi option được chọn theo xác suất %
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
      // Text, Paragraph, Date, Time
      let txt = value !== undefined ? String(value) : "";
      if (!txt && cfg.texts?.length) {
        txt = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
      }
      planItem.textValue = txt;
    }

    plan.set(qId, planItem);
    // Index phụ theo title để tra cứu nhanh nếu cần
    if (qTitle && !plan.has(qTitle)) {
      plan.set(qTitle, planItem);
    }
  }

  return plan;
}

// --- 3. LIVE DOM QUESTION INDEXING & MATCHING ---

/**
 * Trích xuất cấu trúc dữ liệu data-params của Google Forms
 */
export function parseDataParams(box) {
  try {
    const target = box.matches?.("[data-params]") ? box : box.closest?.("[data-params]") || box.querySelector?.("[data-params]");
    const raw = target?.getAttribute?.("data-params") || "";
    if (!raw) return null;

    const unescaped = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const start = unescaped.indexOf("[");
    if (start === -1) return null;

    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

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
      else if (c === "]" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) return null;

    const item = JSON.parse(unescaped.slice(start, end));
    return {
      itemId: String(item[0] ?? ""),
      title: item[1] || "",
      typeCode: item[3],
      entries: item[4] || []
    };
  } catch {
    return null;
  }
}

/**
 * Trích xuất toàn bộ các entryId có trong khối DOM
 */
export function extractEntryIds(box) {
  const ids = [];
  const inputs = Array.from(box.querySelectorAll?.('input[name*="entry."]') || []);
  for (const input of inputs) {
    const name = input.getAttribute("name") || "";
    const m = name.match(/entry\.(\d+)/);
    if (m && !ids.includes(m[1])) {
      ids.push(m[1]);
    }
  }
  return ids;
}

/**
 * Tìm tiêu đề hiển thị của câu hỏi trên Live DOM
 */
export function extractQuestionTitle(box, fallbackIndex = 0) {
  const heading = box.querySelector?.('[role="heading"], .M7eMe, .freebirdFormviewerComponentsQuestionBaseTitle');
  const raw = heading?.innerText || heading?.textContent || `Câu hỏi ${fallbackIndex + 1}`;
  return raw.replace(/\s*\*\s*$/, "").trim();
}

/**
 * Kiểm tra xem phần tử có hiển thị và tương tác được không
 */
export function isElementUsable(el) {
  if (!el || el.isConnected === false) return false;
  if (typeof getComputedStyle === "undefined") return true;
  try {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getBoundingClientRect().width > 0;
  } catch {
    return true;
  }
}

/**
 * Đọc nhãn text của một lựa chọn DOM
 */
export function getOptionLabel(el, idx = 0) {
  const attrVal = el.getAttribute?.("data-value") || el.getAttribute?.("aria-label") || el.value;
  if (attrVal && attrVal !== "__other_option__") {
    return String(attrVal).trim();
  }
  const labelContainer = el.closest?.("label, [role='option'], .docssharedWizToggleLabeledContainer");
  const text = labelContainer?.innerText || labelContainer?.textContent || `Lựa chọn ${idx + 1}`;
  return text.trim();
}

/**
 * Kiểm tra xem option có phải ô "Mục khác" (Other) không
 */
export function checkIsOther(el) {
  const val = el.getAttribute?.("data-value") || el.value;
  if (val === "__other_option__") return true;
  const label = norm(getOptionLabel(el));
  return ["khac", "muc khac", "other"].includes(label);
}

/**
 * Lập chỉ mục toàn bộ câu hỏi trên trang DOM hiện tại theo Khóa định danh ổn định.
 * 
 * @param {Document|HTMLElement} container Root container (mặc định document)
 * @returns {{
 *   byEntryId: Map<string, LiveQuestion>,
 *   byItemId: Map<string, LiveQuestion>,
 *   byCompositeKey: Map<string, LiveQuestion>,
 *   allQuestions: LiveQuestion[]
 * }}
 */
export function buildLiveQuestionIndex(container = (typeof document !== "undefined" ? document : null)) {
  const index = {
    byEntryId: new Map(),
    byItemId: new Map(),
    byCompositeKey: new Map(),
    allQuestions: []
  };

  if (!container) return index;

  // Lấy các container câu hỏi
  const selector = 'div[role="listitem"], .freebirdFormviewerViewItemsItemItem, div[data-params]';
  const allContainers = Array.from(container.querySelectorAll(selector)).filter(isElementUsable);
  // Lọc lấy các container lá (leaf containers)
  const boxes = allContainers.filter((box) => !allContainers.some((other) => other !== box && other.contains(box)));

  boxes.forEach((box, boxIdx) => {
    const baseTitle = extractQuestionTitle(box, boxIdx);
    const isReq = Boolean(box.querySelector?.('[aria-required="true"], [required]')) || /\*\s*$/.test((box.innerText || box.textContent || "").split("\n")[0]);
    const params = parseDataParams(box);
    const entryIdsFromInputs = extractEntryIds(box);

    const itemId = params?.itemId || box.getAttribute?.("data-item-id") || null;
    const entriesFromParams = params?.entries || [];

    // Tìm ô nhập nội dung Khác nếu có
    const otherInput = Array.from(box.querySelectorAll?.('input[type="text"], textarea') || []).find((input) => {
      const aria = norm(input.getAttribute?.("aria-label") || "");
      return aria.includes("khac") || aria.includes("other") || input.closest?.(".Hvn9Uc, .docssharedWizToggleLabeledContainer");
    }) || null;

    // 1. Phân tích loại câu hỏi
    // A. Radio hoặc Linear Scale
    const radioControls = Array.from(box.querySelectorAll?.('[role="radio"], input[type="radio"]') || []).filter(isElementUsable);
    // B. Checkbox
    const checkboxControls = Array.from(box.querySelectorAll?.('[role="checkbox"], input[type="checkbox"]') || []).filter(isElementUsable);
    // C. Select / Dropdown
    const selectControl = box.querySelector?.('select, [role="listbox"]');
    // D. File
    const fileControl = box.querySelector?.('input[type="file"]') || ["them tep", "add file"].some((v) => norm(box.innerText || "").includes(v));

    // Kiểm tra xem có phải Grid (Likert Matrix) không: Có nhiều nhóm radio/checkbox theo hàng
    const rows = Array.from(box.querySelectorAll?.('[role="row"], tr, [role="radiogroup"]') || []).filter((r) => r.querySelectorAll?.('[role="radio"], [role="checkbox"]').length > 1);

    if (rows.length > 1 && (radioControls.length > 0 || checkboxControls.length > 0)) {
      // GRID / LIKERT MATRIX
      const isRadioGrid = radioControls.length >= checkboxControls.length;
      const targetType = isRadioGrid ? "radio" : "checkbox";

      rows.forEach((row, rIdx) => {
        const rowHeader = row.querySelector?.('[role="rowheader"], th, [aria-label]') || row;
        const rowName = clean(rowHeader.getAttribute?.("aria-label") || rowHeader.innerText || rowHeader.textContent || `Hàng ${rIdx + 1}`);
        const fullTitle = `${baseTitle} [${rowName}]`;

        // Tìm rowEntryId
        let rowEntryId = entriesFromParams[rIdx]?.[0] ? String(entriesFromParams[rIdx][0]) : null;
        if (!rowEntryId) {
          const rowInputs = extractEntryIds(row);
          if (rowInputs.length > 0) rowEntryId = rowInputs[0];
          else if (entryIdsFromInputs[rIdx]) rowEntryId = entryIdsFromInputs[rIdx];
        }

        const rowControls = Array.from(row.querySelectorAll?.(isRadioGrid ? '[role="radio"], input[type="radio"]' : '[role="checkbox"], input[type="checkbox"]') || []).filter(isElementUsable);
        const options = rowControls.map((ctrl, oIdx) => ({
          text: getOptionLabel(ctrl, oIdx),
          isOther: checkIsOther(ctrl),
          element: ctrl
        }));

        const liveQ = {
          entryId: rowEntryId,
          itemId,
          parentGridId: itemId || (entryIdsFromInputs[0] || null),
          title: fullTitle,
          rowName,
          compositeKey: `${norm(baseTitle)}::${targetType}::${norm(rowName)}`,
          type: targetType,
          required: isReq,
          box,
          rowElement: row,
          controls: rowControls,
          options,
          otherInput: null
        };

        if (rowEntryId) index.byEntryId.set(rowEntryId, liveQ);
        index.byCompositeKey.set(liveQ.compositeKey, liveQ);
        index.allQuestions.push(liveQ);
      });
      return;
    }

    // CÂU HỎI ĐƠN (NON-GRID)
    let primaryEntryId = entriesFromParams[0]?.[0] ? String(entriesFromParams[0][0]) : (entryIdsFromInputs[0] || null);

    if (fileControl) {
      const liveQ = {
        entryId: primaryEntryId,
        itemId,
        title: baseTitle,
        compositeKey: `${norm(baseTitle)}::file`,
        type: "file",
        required: isReq,
        box,
        controls: [],
        options: [],
        otherInput: null
      };
      if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
      if (itemId) index.byItemId.set(itemId, liveQ);
      index.byCompositeKey.set(liveQ.compositeKey, liveQ);
      index.allQuestions.push(liveQ);
      return;
    }

    if (radioControls.length > 0) {
      const options = radioControls.map((ctrl, oIdx) => ({
        text: getOptionLabel(ctrl, oIdx),
        isOther: checkIsOther(ctrl),
        element: ctrl
      }));
      const liveQ = {
        entryId: primaryEntryId,
        itemId,
        title: baseTitle,
        compositeKey: `${norm(baseTitle)}::radio`,
        type: "radio",
        required: isReq,
        box,
        controls: radioControls,
        options,
        otherInput
      };
      if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
      if (itemId) index.byItemId.set(itemId, liveQ);
      index.byCompositeKey.set(liveQ.compositeKey, liveQ);
      index.allQuestions.push(liveQ);
      return;
    }

    if (checkboxControls.length > 0) {
      const options = checkboxControls.map((ctrl, oIdx) => ({
        text: getOptionLabel(ctrl, oIdx),
        isOther: checkIsOther(ctrl),
        element: ctrl
      }));
      const liveQ = {
        entryId: primaryEntryId,
        itemId,
        title: baseTitle,
        compositeKey: `${norm(baseTitle)}::checkbox`,
        type: "checkbox",
        required: isReq,
        box,
        controls: checkboxControls,
        options,
        otherInput
      };
      if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
      if (itemId) index.byItemId.set(itemId, liveQ);
      index.byCompositeKey.set(liveQ.compositeKey, liveQ);
      index.allQuestions.push(liveQ);
      return;
    }

    if (selectControl) {
      let options = [];
      if (selectControl instanceof (typeof HTMLSelectElement !== "undefined" ? HTMLSelectElement : Object)) {
        options = Array.from(selectControl.options || [])
          .filter((o) => !o.disabled && o.value)
          .map((o) => ({ text: o.textContent.trim(), isOther: false, element: o }));
      }
      const liveQ = {
        entryId: primaryEntryId,
        itemId,
        title: baseTitle,
        compositeKey: `${norm(baseTitle)}::select`,
        type: "select",
        required: isReq,
        box,
        controls: [selectControl],
        options,
        otherInput: null
      };
      if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
      if (itemId) index.byItemId.set(itemId, liveQ);
      index.byCompositeKey.set(liveQ.compositeKey, liveQ);
      index.allQuestions.push(liveQ);
      return;
    }

    // Text / Paragraph / Date / Time
    const textControls = Array.from(
      box.querySelectorAll?.('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="submit"])') || []
    ).filter(isElementUsable);

    if (textControls.length > 0) {
      let type = textControls[0].tagName === "TEXTAREA" ? "paragraph" : (textControls[0].type || "text");
      const labels = norm(textControls.map((el) => `${el.getAttribute?.("aria-label") || ""} ${el.placeholder || ""}`).join(" "));
      if ((labels.includes("ngay") && labels.includes("thang")) || (labels.includes("day") && labels.includes("month"))) {
        type = "date";
      } else if ((labels.includes("gio") && labels.includes("phut")) || (labels.includes("hour") && labels.includes("minute"))) {
        type = "time";
      }

      const liveQ = {
        entryId: primaryEntryId,
        itemId,
        title: baseTitle,
        compositeKey: `${norm(baseTitle)}::${type}`,
        type,
        required: isReq,
        box,
        controls: textControls,
        options: [],
        otherInput: null
      };
      if (primaryEntryId) index.byEntryId.set(primaryEntryId, liveQ);
      if (itemId) index.byItemId.set(itemId, liveQ);
      index.byCompositeKey.set(liveQ.compositeKey, liveQ);
      index.allQuestions.push(liveQ);
    }
  });

  return index;
}

/**
 * Ánh xạ một câu hỏi kinh điển sang câu hỏi trên Live DOM qua thứ bậc định danh.
 * 
 * @param {object} canonicalQuestion Câu hỏi kinh điển (từ scan profile)
 * @param {object} liveIndex Bộ chỉ mục từ `buildLiveQuestionIndex`
 * @param {Function} logger Hàm ghi log cảnh báo
 * @returns {LiveQuestion|null}
 */
export function matchQuestionToLive(canonicalQuestion, liveIndex, logger = console.warn) {
  if (!canonicalQuestion || !liveIndex) return null;

  const qId = String(canonicalQuestion.id || canonicalQuestion.sourceId || "");

  // Mức 1: entry.XXXXXXXX
  if (qId && liveIndex.byEntryId.has(qId)) {
    return liveIndex.byEntryId.get(qId);
  }

  // Mức 2: itemId
  if (canonicalQuestion.itemId && liveIndex.byItemId.has(String(canonicalQuestion.itemId))) {
    return liveIndex.byItemId.get(String(canonicalQuestion.itemId));
  }

  // Mức 3: Composite Key (Fallback khẩn cấp)
  const normTitle = norm(canonicalQuestion.title || "");
  const targetType = canonicalQuestion.type || "";

  // Thử khớp theo key composite chính xác
  const compositeKey = `${normTitle}::${targetType}`;
  if (liveIndex.byCompositeKey.has(compositeKey)) {
    logger(`[FILL:MATCH] IDENTITY_FALLBACK_USED for question "${canonicalQuestion.title}" (Key: ${compositeKey})`);
    return liveIndex.byCompositeKey.get(compositeKey);
  }

  // Thử khớp với Likert row: Title chứa [RowName]
  const gridMatch = canonicalQuestion.title?.match(/^([\s\S]+?)\s*\[([\s\S]+)\]$/);
  if (gridMatch) {
    const baseNorm = norm(gridMatch[1]);
    const rowNorm = norm(gridMatch[2]);
    const gridCompositeKey = `${baseNorm}::${targetType}::${rowNorm}`;
    if (liveIndex.byCompositeKey.has(gridCompositeKey)) {
      logger(`[FILL:MATCH] IDENTITY_FALLBACK_USED for Likert row "${canonicalQuestion.title}" (Key: ${gridCompositeKey})`);
      return liveIndex.byCompositeKey.get(gridCompositeKey);
    }
  }

  // Thử tìm theo so sánh title mờ
  const matched = liveIndex.allQuestions.find((liveQ) => {
    return norm(liveQ.title) === normTitle || (gridMatch && norm(liveQ.title) === norm(gridMatch[0]));
  });

  if (matched) {
    logger(`[FILL:MATCH] IDENTITY_FALLBACK_USED via normalized title match for "${canonicalQuestion.title}"`);
    return matched;
  }

  return null;
}

// --- 4. PER-TYPE ADAPTERS & POST-FILL VERIFICATION ---

/**
 * Kiểm tra trạng thái đã được chọn của control
 */
export function isControlChecked(el) {
  if (!el) return false;
  return Boolean(el.checked) ||
    el.getAttribute?.("aria-checked") === "true" ||
    el.getAttribute?.("aria-selected") === "true" ||
    Boolean(el.classList?.contains("isChecked"));
}

/**
 * Xác minh một câu hỏi đã được điền và kiểm tra ánh xạ card/entry ID
 */
export function isQuestionFilledAndVerified(q, container = (typeof document !== "undefined" ? document : null)) {
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

/**
 * Gán giá trị văn bản an toàn qua prototype setter
 */
export function setNativeValue(el, value, signal = null) {
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (!el) return;
  const isTextArea = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement;
  const proto = isTextArea ? HTMLTextAreaElement.prototype : (typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : Object.prototype);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }

  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }

  if (typeof Event !== "undefined") {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

export const FEATURE_FLAGS = {
  syntheticPointerSequence: false,
  dropdownAdapterV2: true,
  backgroundStepSchedulerV2: true
};

/**
 * Tạo một khoảng dừng có thể hủy bỏ
 */
export function abortableSleep(ms, signal = null) {
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  const delay = Math.max(0, ms);
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let t = null;
    let onAbort = null;
    const cleanup = () => {
      if (t) clearTimeout(t);
      if (signal?.removeEventListener && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    if (signal?.addEventListener) {
      onAbort = () => {
        cleanup();
        const err = new Error("OPERATION_CANCELLED");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    t = setTimeout(() => {
      cleanup();
      if (signal?.aborted) {
        const err = new Error("OPERATION_CANCELLED");
        err.name = "AbortError";
        reject(err);
      } else {
        resolve();
      }
    }, delay);
  });
}

/**
 * Kích hoạt chuỗi sự kiện click người dùng thật
 */
export async function triggerClick(el, sleepMs = 50, signal) {
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (!el) return;
  try { el.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch {}
  try { el.focus?.({ preventScroll: true }); } catch {}
  
  const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const clientX = (rect.left || 0) + (rect.width || 0) / 2;
  const clientY = (rect.top || 0) + (rect.height || 0) / 2;
  const evtInit = { bubbles: true, cancelable: true, clientX, clientY, button: 0 };
  if (typeof PointerEvent !== "undefined") {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...evtInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  }
  if (typeof MouseEvent !== "undefined") {
    el.dispatchEvent(new MouseEvent("mousedown", evtInit));
  }
  if (typeof PointerEvent !== "undefined") {
    el.dispatchEvent(new PointerEvent("pointerup", { ...evtInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  }
  if (typeof MouseEvent !== "undefined") {
    el.dispatchEvent(new MouseEvent("mouseup", evtInit));
  }
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  el.click();

  const parentContainer = el.closest?.(".docssharedWizTogglelabeledControl, .docssharedWizToggleLabeledContainer, label");
  if (parentContainer && parentContainer !== el) {
    try { parentContainer.click?.(); } catch {}
  }

  if (sleepMs > 0) {
    await abortableSleep(sleepMs, signal);
  }
}

/**
 * Adapter điền câu hỏi Radio
 */
export async function fillRadio(liveQ, answerItem, clickDelay = 50, signal) {
  const fp = liveQ ? `${liveQ.id || "0"}:${liveQ.type || "radio"}:${(liveQ.title || "").slice(0, 40)}` : "unknown";
  if (!liveQ || !answerItem) {
    return {
      success: false,
      verified: false,
      error: "Dữ liệu câu hỏi hoặc câu trả lời không hợp lệ",
      questionFingerprint: fp,
      adapter: "radio",
      expected: "Dữ liệu hợp lệ",
      observed: "liveQ hoặc answerItem null"
    };
  }

  let target = answerItem.targetOptions?.[0];
  if (!target && answerItem.targetOption) {
    target = answerItem.targetOption;
  }
  if (!target && answerItem.value !== undefined && answerItem.value !== null) {
    target = { text: String(answerItem.value), index: -1, isOther: false };
  }
  if (!target) {
    return { success: true, verified: true, questionFingerprint: fp, adapter: "radio" };
  }

  let targetControl = null;
  if (target.isOther) {
    const otherIdx = liveQ.options.findIndex((o) => o.isOther);
    if (otherIdx >= 0) {
      targetControl = liveQ.controls[otherIdx];
    }
  } else {
    // Khớp theo text hoặc index
    const normTarget = norm(target.text);
    const foundIdx = liveQ.options.findIndex((o) => norm(o.text) === normTarget);
    if (foundIdx >= 0) targetControl = liveQ.controls[foundIdx];
    else if (target.index >= 0 && target.index < liveQ.controls.length) {
      targetControl = liveQ.controls[target.index];
    }
  }

  if (!targetControl) {
    return {
      success: false,
      verified: false,
      error: `Không tìm thấy lựa chọn "${target.text}"`,
      questionFingerprint: fp,
      adapter: "radio",
      expected: target.text,
      observed: "Không tìm thấy control tương ứng"
    };
  }

  console.log(`[FILL:RADIO] Question: "${liveQ.title}", Target: "${target.text}", targetControl found: ${Boolean(targetControl)}, beforeChecked: ${isControlChecked(targetControl)}`);
  if (!isControlChecked(targetControl)) {
    await triggerClick(targetControl, clickDelay, signal);
  }
  console.log(`[FILL:RADIO] After click: isChecked: ${isControlChecked(targetControl)}, aria-checked: ${targetControl.getAttribute?.("aria-checked")}`);

  // Nếu là ô khác, điền tiếp text
  if (target.isOther && answerItem.otherText) {
    const textEl = liveQ.otherInput || liveQ.box?.querySelector('input[type="text"], textarea');
    if (textEl) {
      setNativeValue(textEl, answerItem.otherText);
    }
  }

  const verificationDoc = liveQ.box?.ownerDocument || targetControl.ownerDocument || (typeof document !== "undefined" ? document : null);
  const isExpectedOptionCheckedOnCurrentCard = () => {
    if (!verificationDoc) return false;
    const freshIndex = buildLiveQuestionIndex(verificationDoc);
    const freshQ = (liveQ.entryId && freshIndex.byEntryId.get(String(liveQ.entryId))) ||
      (liveQ.itemId && freshIndex.byItemId.get(String(liveQ.itemId))) ||
      (liveQ.compositeKey && freshIndex.byCompositeKey.get(liveQ.compositeKey));
    if (!freshQ || freshQ.type !== "radio") return false;
    let freshIdx = target.isOther
      ? freshQ.options.findIndex((option) => option.isOther)
      : freshQ.options.findIndex((option) => norm(option.text) === norm(target.text));
    if (freshIdx < 0 && target.index >= 0 && target.index < freshQ.controls.length) {
      freshIdx = target.index;
    }
    const freshControl = freshQ.controls[freshIdx];
    return Boolean(freshControl && freshControl.isConnected !== false && (
      isControlChecked(freshControl) ||
      freshControl.classList?.contains("N2RpBe") ||
      freshControl.querySelector?.('[aria-checked="true"], [aria-selected="true"], input:checked, .isChecked, .N2RpBe')
    ));
  };

  // Xác thực sau khi điền (Post-Fill Verification với retry chờ commit)
  let isVerified = (targetControl.isConnected !== false && isControlChecked(targetControl)) || isExpectedOptionCheckedOnCurrentCard();
  if (!isVerified) {
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const startedAt = now();
    const deadline = startedAt + (verificationDoc?.hidden ? 5000 : 1500);
    const pollInterval = verificationDoc?.hidden ? 50 : (clickDelay === 0 ? 10 : 100);
    let retried = false;
    while (now() < deadline && !isVerified) {
      await abortableSleep(pollInterval, signal);
      isVerified = (targetControl.isConnected !== false && isControlChecked(targetControl)) || isExpectedOptionCheckedOnCurrentCard();
      if (!isVerified && !retried && !verificationDoc?.hidden && targetControl.isConnected !== false && now() - startedAt > 300) {
        retried = true;
        await triggerClick(targetControl, 0, signal);
      }
    }
  }
  return {
    success: isVerified,
    verified: isVerified,
    questionFingerprint: fp,
    adapter: "radio",
    expected: target.text,
    observed: isVerified ? target.text : "Chưa chọn hoặc chưa commit"
  };
}

/**
 * Adapter điền câu hỏi Checkbox (Multiple Selections) với Differential Clicks
 */
export async function fillCheckbox(liveQ, answerItem, clickDelay = 40, signal) {
  const fp = liveQ ? `${liveQ.id || "0"}:${liveQ.type || "checkbox"}:${(liveQ.title || "").slice(0, 40)}` : "unknown";
  if (!liveQ || !answerItem) {
    return {
      success: false,
      verified: false,
      error: "Dữ liệu câu hỏi hoặc câu trả lời không hợp lệ",
      questionFingerprint: fp,
      adapter: "checkbox",
      expected: "Dữ liệu hợp lệ",
      observed: "liveQ hoặc answerItem null"
    };
  }

  const targetSet = new Set((answerItem.targetOptions || []).map((o) => norm(o.text)));
  const targetIndices = new Set((answerItem.targetOptions || []).map((o) => o.index).filter((idx) => typeof idx === "number"));
  const targetHasOther = answerItem.targetOptions?.some((o) => o.isOther);

  for (let i = 0; i < liveQ.controls.length; i++) {
    const ctrl = liveQ.controls[i];
    const opt = liveQ.options[i];
    const isChecked = isControlChecked(ctrl);

    const shouldBeChecked = (opt && targetSet.has(norm(opt.text))) ||
      targetIndices.has(i) ||
      (opt?.isOther && targetHasOther);

    if (isChecked !== shouldBeChecked) {
      await triggerClick(ctrl, clickDelay, signal);
    }
  }

  if (targetHasOther && answerItem.otherText) {
    const textEl = liveQ.otherInput || liveQ.box?.querySelector('input[type="text"], textarea');
    if (textEl) {
      setNativeValue(textEl, answerItem.otherText);
    }
  }

  // Xác thực tập hợp checkbox với retry chờ commit
  const checkMatch = () => {
    for (let i = 0; i < liveQ.controls.length; i++) {
      const ctrl = liveQ.controls[i];
      const opt = liveQ.options[i];
      const isChecked = isControlChecked(ctrl);
      const shouldBeChecked = (opt && targetSet.has(norm(opt.text))) ||
        targetIndices.has(i) ||
        (opt?.isOther && targetHasOther);
      if (isChecked !== shouldBeChecked) return false;
    }
    return true;
  };

  let allVerified = false;
  if (targetSet.size > 0 && liveQ.controls.length === 0) {
    allVerified = false;
  } else {
    allVerified = checkMatch();
    if (!allVerified) {
      const deadline = Date.now() + 1500;
      const pollInterval = clickDelay === 0 ? 10 : 100;
      while (Date.now() < deadline && !allVerified) {
        await abortableSleep(pollInterval, signal);
        allVerified = checkMatch();
      }
    }
  }

  return {
    success: allVerified,
    verified: allVerified,
    questionFingerprint: fp,
    adapter: "checkbox",
    expected: Array.from(targetSet).join(", "),
    observed: allVerified ? "Khớp hoàn toàn" : (liveQ.controls.length === 0 ? "Không tìm thấy controls checkbox" : "Không khớp tập hợp lựa chọn")
  };
}

/**
 * Adapter điền Dropdown / Select
 */
export async function fillSelect(liveQ, answerItem, clickDelay = 60, signal) {
  const fp = liveQ ? `${liveQ.id || "0"}:${liveQ.type || "select"}:${(liveQ.title || "").slice(0, 40)}` : "unknown";
  if (!liveQ || !answerItem) {
    return {
      success: false,
      verified: false,
      error: "Dữ liệu câu hỏi hoặc câu trả lời không hợp lệ",
      questionFingerprint: fp,
      adapter: "select",
      expected: "Dữ liệu hợp lệ",
      observed: "liveQ hoặc answerItem null"
    };
  }
  const target = answerItem.targetOptions?.[0];
  if (!target) return { success: true, verified: true, questionFingerprint: fp, adapter: "select" };

  let control = liveQ.controls?.[0];
  if (!control) {
    return {
      success: false,
      verified: false,
      error: "Không tìm thấy dropdown control",
      questionFingerprint: fp,
      adapter: "select",
      expected: target.text,
      observed: "controls rỗng"
    };
  }

  if (typeof HTMLSelectElement !== "undefined" && control instanceof HTMLSelectElement) {
    // Native <select>
    const opt = Array.from(control.options).find((o) => norm(o.textContent) === norm(target.text));
    if (opt) {
      control.value = opt.value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
      const verified = control.value === opt.value;
      return {
        success: verified,
        verified,
        questionFingerprint: fp,
        adapter: "select-native",
        expected: target.text,
        observed: opt.textContent
      };
    }
    return {
      success: false,
      verified: false,
      error: `Không tìm thấy option native "${target.text}"`,
      questionFingerprint: fp,
      adapter: "select-native",
      expected: target.text,
      observed: "Option không tồn tại trong select"
    };
  }

  // Google Wiz Dropdown [role="listbox"]
  // Chụp snapshot các portal đang mở trước khi click để phát hiện portal mới/đang mở
  const preOpenPortals = new Set();
  if (typeof document !== "undefined") {
    document.querySelectorAll('.OA0qSb[role="listbox"], .exportSelectPopup, [role="listbox"][aria-expanded="true"]').forEach((el) => {
      preOpenPortals.add(el);
    });
  }

  try { control.scrollIntoView?.({ block: "center", behavior: "instant" }); } catch {}
  await triggerClick(control, clickDelay, signal);

  // Chờ portal options xuất hiện
  const maxWait = 2500;
  const start = Date.now();
  let portalOptions = [];
  let resolvedPortalEl = null;

  while (Date.now() - start < maxWait) {
    const popupId = control.getAttribute?.("aria-controls") || control.getAttribute?.("aria-owns");
    if (popupId && typeof document !== "undefined") {
      const popupEl = document.getElementById(popupId);
      if (popupEl) {
        resolvedPortalEl = popupEl;
        portalOptions = Array.from(popupEl.querySelectorAll('[role="option"]')).filter(isElementUsable);
      }
    }
    
    // Nếu chưa thấy qua aria-controls, tìm portal trong question container
    if (portalOptions.length === 0 && liveQ.box) {
      const localPortal = liveQ.box.querySelector('.exportSelectPopup, .OA0qSb[role="listbox"]');
      if (localPortal) {
        resolvedPortalEl = localPortal;
        portalOptions = Array.from(localPortal.querySelectorAll('[role="option"]')).filter(isElementUsable);
      }
    }

    // Nếu chưa thấy, tìm options trong các container portal chuyên biệt của Google Forms
    if (portalOptions.length === 0 && typeof document !== "undefined") {
      const candidateOptions = Array.from(
        document.querySelectorAll('.exportSelectPopup [role="option"], .OA0qSb[role="listbox"] [role="option"], [role="presentation"] [role="option"]')
      ).filter(isElementUsable);
      if (candidateOptions.length > 0) {
        portalOptions = candidateOptions;
      }
    }

    if (portalOptions.length > 0) break;
    await abortableSleep(clickDelay === 0 ? 15 : 100, signal);
  }

  // Tuyệt đối không quét toàn document. Nếu không tìm thấy portal gắn kết, báo lỗi an toàn
  if (portalOptions.length === 0) {
    return {
      success: false,
      verified: false,
      errorCode: "DROPDOWN_PORTAL_AMBIGUOUS",
      error: `DROPDOWN_PORTAL_AMBIGUOUS: Không tìm thấy portal options liên kết với dropdown "${liveQ.title}"`,
      questionFingerprint: fp,
      adapter: "select-wiz",
      expected: target.text,
      observed: "0 portal options tìm thấy"
    };
  }

  let targetOptionEl = portalOptions.find((el) => {
    const text = el.innerText || el.textContent || el.getAttribute("data-value") || "";
    return norm(text) === norm(target.text);
  });

  // Fallback: Tìm theo index trong các option hợp lệ (loại bỏ option placeholder "Choose"/"Chọn")
  if (!targetOptionEl && target.index !== undefined) {
    const cleanOptions = portalOptions.filter((el) => {
      const t = norm(el.innerText || el.textContent || el.getAttribute("data-value") || "");
      return t && t !== "chon" && t !== "choose" && !t.startsWith("chon ") && !t.startsWith("choose ");
    });
    if (target.index >= 0 && target.index < cleanOptions.length) {
      targetOptionEl = cleanOptions[target.index];
    }
  }

  if (!targetOptionEl) {
    // Đóng dropdown nếu không tìm thấy
    try {
      if (typeof document !== "undefined") {
        document.activeElement?.dispatchEvent?.(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    } catch {}
    return {
      success: false,
      verified: false,
      error: `Không tìm thấy option dropdown "${target.text}" trong portal`,
      questionFingerprint: fp,
      adapter: "select-wiz",
      expected: target.text,
      observed: portalOptions.map((o) => o.textContent?.trim()).slice(0, 5).join(", ")
    };
  }

  try { targetOptionEl.scrollIntoView?.({ block: "nearest", behavior: "instant" }); } catch {}
  await triggerClick(targetOptionEl, clickDelay, signal);

  // Chờ menu nổi đóng (chỉ kiểm tra các option nổi trong resolvedPortalEl)
  const closeDeadline = Date.now() + (clickDelay === 0 ? 150 : 600);
  while (Date.now() < closeDeadline) {
    const isExpanded = control.getAttribute?.("aria-expanded") === "true";
    let stillOpen = false;
    if (resolvedPortalEl) {
      stillOpen = resolvedPortalEl.isConnected && (resolvedPortalEl.querySelectorAll?.('[role="option"]').length > 0) && isExpanded;
    }
    if (!stillOpen && !isExpanded) break;
    await abortableSleep(clickDelay === 0 ? 10 : 50, signal);
  }

  let activeControl = control;
  if (liveQ.box) {
    const fresh = liveQ.box.querySelectorAll?.('select, [role="listbox"]');
    if (fresh?.length > 0) activeControl = fresh[0];
  }

  // Chờ commit hoặc dropdown đóng
  let isVerified = false;
  const deadline = Date.now() + (clickDelay === 0 ? 250 : 800);
  while (Date.now() < deadline) {
    if (liveQ.box) {
      const fresh = liveQ.box.querySelectorAll?.('select, [role="listbox"]');
      if (fresh?.length > 0) activeControl = fresh[0];
    }
    const afterText = norm(activeControl.innerText || activeControl.textContent || activeControl.getAttribute?.("data-value") || "");
    const selectedItem = liveQ.box?.querySelector?.('[aria-selected="true"]');
    const selectedText = selectedItem ? norm(selectedItem.innerText || selectedItem.getAttribute("data-value") || "") : "";

    if ((afterText && (afterText.includes(norm(target.text)) || activeControl.getAttribute?.("data-value") === target.text)) ||
        (selectedText && selectedText.includes(norm(target.text)))) {
      isVerified = true;
      break;
    }
    await abortableSleep(clickDelay === 0 ? 15 : 60, signal);
  }

  // Keyboard fallback nếu click chưa commit giá trị (chỉ kích hoạt khi FEATURE_FLAGS.dropdownAdapterV2 bật)
  if (!isVerified && FEATURE_FLAGS.dropdownAdapterV2) {
    try {
      activeControl.focus?.();
      const sendKey = (key, code, keyCode) => {
        if (signal?.aborted) {
          const err = new Error("OPERATION_CANCELLED");
          err.name = "AbortError";
          throw err;
        }
        const evInit = { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode };
        const evDown = typeof KeyboardEvent !== "undefined" ? new KeyboardEvent("keydown", evInit) : { type: "keydown", ...evInit };
        const evUp = typeof KeyboardEvent !== "undefined" ? new KeyboardEvent("keyup", evInit) : { type: "keyup", ...evInit };
        activeControl.dispatchEvent(evDown);
        activeControl.dispatchEvent(evUp);
      };
      if (activeControl.getAttribute?.("aria-expanded") !== "true") {
        sendKey("Enter", "Enter", 13);
        await abortableSleep(80, signal);
      }
      // Về đầu danh sách
      for (let k = 0; k < 15; k++) sendKey("ArrowUp", "ArrowUp", 38);
      await abortableSleep(50, signal);
      // Di chuyển xuống đúng index
      const targetIdx = target.index !== undefined ? target.index + 1 : 1;
      for (let k = 0; k < targetIdx; k++) sendKey("ArrowDown", "ArrowDown", 40);
      await abortableSleep(50, signal);
      sendKey("Enter", "Enter", 13);
      await abortableSleep(150, signal);

      const afterText = norm(activeControl.innerText || activeControl.textContent || activeControl.getAttribute?.("data-value") || "");
      const selectedItem = liveQ.box?.querySelector?.('[aria-selected="true"]');
      const selectedText = selectedItem ? norm(selectedItem.innerText || selectedItem.getAttribute("data-value") || "") : "";

      if ((afterText && (afterText.includes(norm(target.text)) || activeControl.getAttribute?.("data-value") === target.text)) ||
          (selectedText && selectedText.includes(norm(target.text)))) {
        isVerified = true;
      }
    } catch {}
  }

  return {
    success: isVerified,
    verified: isVerified,
    questionFingerprint: fp,
    adapter: "select-wiz",
    expected: target.text,
    observed: isVerified ? target.text : "Chưa chọn hoặc chưa commit giá trị"
  };
}

/**
 * Adapter điền Text / Paragraph / Short Answer
 */
export async function fillText(liveQ, textValue, signal = null, clickDelay = 40) {
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (!liveQ) return { success: false, verified: false };
  const control = liveQ.controls?.[0] || liveQ.box?.querySelector?.("input, textarea");
  if (!control) return { success: false, verified: false, error: "Không tìm thấy text input" };

  try { control.scrollIntoView?.({ block: "nearest", behavior: "instant" }); } catch {}

  // 1. Focus
  try { control.focus?.({ preventScroll: true }); } catch {}
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (clickDelay > 0) await abortableSleep(clickDelay, signal);

  if (typeof PointerEvent !== "undefined") {
    control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  } else if (typeof MouseEvent !== "undefined") {
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  } else if (typeof Event !== "undefined") {
    control.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  }
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (clickDelay > 0) await abortableSleep(clickDelay, signal);

  // 3. Set value & Input event
  setNativeValue(control, String(textValue ?? ""), signal);
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (clickDelay > 0) await abortableSleep(clickDelay, signal);

  // 4. Change event
  if (typeof Event !== "undefined") {
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (clickDelay > 0) await abortableSleep(clickDelay, signal);

  // 5. Blur event
  if (typeof Event !== "undefined") {
    control.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (clickDelay > 0) await abortableSleep(clickDelay, signal);

  // 6. Verification
  const verified = control.value === String(textValue ?? "");
  return { success: true, verified, adapter: "text", observed: control.value };
}

/**
 * Adapter điền Date / Time
 */
export async function fillDateTime(liveQ, dateTimeValue, signal = null) {
  if (signal?.aborted) {
    const err = new Error("OPERATION_CANCELLED");
    err.name = "AbortError";
    throw err;
  }
  if (!liveQ) return { success: false, verified: false };
  const text = String(dateTimeValue ?? "").trim();
  if (!text) return { success: true, verified: true };

  const controls = liveQ.controls;
  if (controls.length === 1) {
    return fillText(liveQ, text, signal);
  }

  if (liveQ.type === "date" && controls.length > 1) {
    // Phân giải ngày YYYY-MM-DD hoặc DD/MM/YYYY
    const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/) || text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) {
      const parts = m[1].length === 4 ? { y: m[1], m: m[2], d: m[3] } : { d: m[1], m: m[2], y: m[3] };
      controls.forEach((el, idx) => {
        if (signal?.aborted) {
          const err = new Error("OPERATION_CANCELLED");
          err.name = "AbortError";
          throw err;
        }
        const label = norm(el.getAttribute("aria-label") || el.placeholder || "");
        let val = [parts.d, parts.m, parts.y][idx];
        if (label.includes("ngay") || label.includes("day")) val = parts.d;
        else if (label.includes("thang") || label.includes("month")) val = parts.m;
        else if (label.includes("nam") || label.includes("year")) val = parts.y;
        setNativeValue(el, val, signal);
      });
      return { success: true, verified: controls.every((c) => Boolean(c.value)) };
    }
  }

  if (liveQ.type === "time" && controls.length > 1) {
    const m = text.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      if (signal?.aborted) {
        const err = new Error("OPERATION_CANCELLED");
        err.name = "AbortError";
        throw err;
      }
      setNativeValue(controls[0], m[1], signal);
      setNativeValue(controls[1], m[2], signal);
      return { success: true, verified: controls.every((c) => Boolean(c.value)) };
    }
  }

  controls.forEach((c) => setNativeValue(c, text));
  return { success: true, verified: true };
}

// --- 5. SECTION RUNNER, VALIDATION & NAVIGATION ---

/**
 * Trích xuất chữ ký nhận diện của Section hiện tại
 */
export function getCurrentSectionSignature(container = (typeof document !== "undefined" ? document : null)) {
  if (!container) return "";
  const header = container.querySelector?.(".freebirdFormviewerViewHeaderHeader, .F9iKBc, [role='heading']");
  const headerText = clean(header?.innerText || header?.textContent || "");
  const entryInputs = extractEntryIds(container);
  const itemIds = Array.from(container.querySelectorAll?.('div[data-item-id], [data-entry-id], [data-params]') || [])
    .map((el) => el.getAttribute("data-item-id") || el.getAttribute("data-entry-id") || "")
    .filter(Boolean);
  const combinedIds = Array.from(new Set([...entryInputs, ...itemIds])).sort().join(",");
  return `${headerText}|${combinedIds}`;
}

/**
 * Xác minh tính hợp lệ của trang hiện tại trước khi bấm Next hoặc Submit.
 * Nếu thiếu câu hỏi bắt buộc, trả về { valid: false, error, missingQuestion }.
 */
export function validateCurrentPage(liveQuestionsOnPage = [], canonicalQuestions = []) {
  for (const liveQ of liveQuestionsOnPage) {
    if (!liveQ.required) continue;

    // Kiểm tra câu radio/checkbox
    if (liveQ.type === "radio" || liveQ.type === "checkbox") {
      let anyChecked = liveQ.controls?.some(isControlChecked);
      if (!anyChecked && liveQ.box) {
        const liveChecked = liveQ.box.querySelector?.('[aria-checked="true"], [role="radio"].isChecked, [role="radio"].N2RpBe, [role="checkbox"].isChecked, [role="checkbox"].N2RpBe, input[type="radio"]:checked, input[type="checkbox"]:checked');
        if (liveChecked) anyChecked = true;
        else {
          const freshControls = Array.from(liveQ.box.querySelectorAll?.(liveQ.type === "radio" ? '[role="radio"], input[type="radio"]' : '[role="checkbox"], input[type="checkbox"]') || []).filter(isElementUsable);
          if (freshControls.some(isControlChecked)) anyChecked = true;
        }
      }
      if (!anyChecked) {
        return {
          valid: false,
          error: `Câu hỏi bắt buộc "${liveQ.title}" chưa được chọn đáp án.`,
          missingQuestion: liveQ
        };
      }
    } else if (liveQ.type === "select") {
      let ctrl = liveQ.controls?.[0];
      if ((!ctrl || !ctrl.isConnected) && liveQ.box) {
        ctrl = liveQ.box.querySelector?.('select, [role="listbox"]') || ctrl;
      }
      const dataVal = ctrl?.getAttribute?.("data-value") || "";
      const textVal = ctrl?.innerText || ctrl?.textContent || ctrl?.value || "";
      const val = dataVal || textVal;
      const normVal = norm(val);
      if (!val || normVal === "chon" || normVal === "choose" || normVal.startsWith("chon ") || normVal.startsWith("choose ")) {
        return {
          valid: false,
          error: `Câu hỏi bắt buộc "${liveQ.title}" chưa được chọn giá trị.`,
          missingQuestion: liveQ
        };
      }
    } else if (["text", "paragraph", "short_answer", "short_text", "email", "url", "number", "tel"].includes(liveQ.type)) {
      let ctrl = liveQ.controls?.[0];
      if ((!ctrl || !ctrl.isConnected) && liveQ.box) {
        ctrl = liveQ.box.querySelector?.('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])') || ctrl;
      }
      const val = ctrl?.value?.trim?.() || "";
      if (!val) {
        return {
          valid: false,
          error: `Câu hỏi bắt buộc "${liveQ.title}" chưa được điền nội dung.`,
          missingQuestion: liveQ
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Chờ trang biểu mẫu Google ổn định (DOM MutationObserver kèm Quiet Window)
 */
export async function waitForFormStable(targetDocument = (typeof document !== "undefined" ? document : null), timeoutMs = 8000) {
  if (!targetDocument) return true;

  return new Promise((resolve) => {
    let quietTimer = null;
    let observer = null;
    const quietWindow = 250; // 250ms không có biến động DOM mới
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (observer) observer.disconnect();
    };

    const resetQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (Date.now() >= deadline) {
        cleanup();
        resolve(true);
        return;
      }
      quietTimer = setTimeout(() => {
        cleanup();
        resolve(true);
      }, quietWindow);
    };

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => resetQuiet());
      observer.observe(targetDocument.body || targetDocument.documentElement, {
        childList: true,
        subtree: true,
        attributes: true
      });
    }

    resetQuiet();
  });
}

// --- 6. FORM PAGE CLASSIFICATION & ANSWER PLAN SERIALIZATION ---

export const FORM_PAGE_TYPES = {
  QUESTION_PAGE: "QUESTION_PAGE",
  FINAL_SUBMIT_PAGE: "FINAL_SUBMIT_PAGE",
  CONFIRMATION_PAGE: "CONFIRMATION_PAGE",
  NAVIGATION_ONLY_PAGE: "NAVIGATION_ONLY_PAGE",
  UNKNOWN: "UNKNOWN"
};

/**
 * Tìm nút Tiếp (Next / Tiếp tục / Continue) thật sự hiển thị, tương tác được trên DOM.
 */
export function findNextButton(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return null;
  const candidates = Array.from(doc.querySelectorAll?.('div[role="button"], span[role="button"], button, input[type="submit"], input[type="button"]') || []).filter(isElementUsable);
  const nextWords = ["tiep", "tiep theo", "tiep tuc", "next", "continue"];

  for (const el of candidates) {
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") continue;
    const text = norm(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
    // Loại trừ nút xóa, quay lại, gửi, và link gửi phản hồi khác
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

/**
 * Tìm nút Gửi (Submit) thật sự hiển thị, tương tác được trên DOM.
 * Không dựa vào input[type=submit] ẩn (hidden submit controls).
 */
export function findSubmitButton(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return null;
  const candidates = Array.from(doc.querySelectorAll?.('div[role="button"], button, input[type="submit"]') || []).filter(isElementUsable);
  const submitWords = ["gui", "gui di", "submit"];

  for (const el of candidates) {
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") continue;
    const text = norm(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
    // Loại trừ nút xóa, nút quay lại, và tuyệt đối không nhận nhầm link/nút "Gửi phản hồi khác"
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

/**
 * Tìm link hoặc nút "Gửi phản hồi khác" / "Submit another response" trên trang xác nhận.
 */
export function findSubmitAnotherResponseLink(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return null;
  const candidates = Array.from(
    doc.querySelectorAll?.('a, button, div[role="button"], span[role="button"], input[type="button"]') || []
  ).filter(isElementUsable);
  const phrases = [
    "submit another response",
    "gui phan hoi khac",
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

/**
 * Kiểm tra xem trên trang hiện tại có bất kỳ control nhập liệu câu hỏi nào có thể thao tác được không.
 * Không tính các wrapper chung như role="listitem" hay div[data-params] nếu không chứa input control.
 */
export function hasActionableQuestions(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return false;
  // 1. Khối câu hỏi Google Forms
  const questionBoxSelector = 'div[role="listitem"], .freebirdFormviewerViewItemsItemItem, div[data-params], .geS5n, .Qr7Oae';
  const questionBoxes = Array.from(doc.querySelectorAll?.(questionBoxSelector) || []).filter(isElementUsable);
  if (questionBoxes.length > 0) {
    const hasControlsInBox = questionBoxes.some((box) => {
      const ctrls = box.querySelectorAll?.('input[name*="entry."], [role="radio"], [role="checkbox"], textarea, select, [role="listbox"], input[type="file"], input[type="text"], input[type="number"], input[type="date"], input[type="time"], input[type="url"], input[type="email"], input[type="tel"]');
      return Array.from(ctrls || []).some(isElementUsable);
    });
    if (hasControlsInBox) return true;
  }

  // 2. Control có name chứa entry.
  const entryInputs = Array.from(doc.querySelectorAll?.('input[name*="entry."], textarea[name*="entry."]') || [])
    .filter((el) => {
      const name = el.getAttribute?.("name") || el.name || "";
      return name.includes("entry.") && isElementUsable(el);
    });
  if (entryInputs.length > 0) return true;

  // 3. Choice controls: [role="radio"], [role="checkbox"], [role="listbox"], loại trừ banner/header của Google Account
  const choiceControls = Array.from(doc.querySelectorAll?.('[role="radio"], [role="checkbox"], select, [role="listbox"]') || []).filter(isElementUsable);
  if (choiceControls.length > 0) {
    const validChoices = choiceControls.filter((el) => {
      const inBanner = el.closest?.('header, [role="banner"], .I301vd, .m2');
      return !inBanner;
    });
    if (validChoices.length > 0) return true;
  }

  return false;
}

/**
 * Phân loại chính xác trang hiện tại:
 * - CONFIRMATION_PAGE: Có bằng chứng xác nhận nộp và không có controls câu hỏi
 * - QUESTION_PAGE: Còn câu hỏi / controls nhập liệu thực tế
 * - FINAL_SUBMIT_PAGE: 0 câu hỏi nhập liệu, có nút Submit visible/usable
 * - UNKNOWN: Chưa tải xong hoặc không xác định
 */
export function classifyFormPage(doc = (typeof document !== "undefined" ? document : null), url = "") {
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

  // Kiểm tra controls câu hỏi đang hoạt động (dựa trên control thực tế, không dựa trên wrapper role="listitem")
  const hasQuestions = hasActionableQuestions(doc);

  // 1. CONFIRMATION_PAGE: 0 câu hỏi, có bằng chứng xác nhận nộp (text, element hoặc link Gửi phản hồi khác)
  if (!hasQuestions && (hasConfirmText || hasConfirmEl || Boolean(anotherLink))) {
    return FORM_PAGE_TYPES.CONFIRMATION_PAGE;
  }

  // 2. QUESTION_PAGE: Nếu còn controls câu hỏi cần điền
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

/**
 * Chuyển đổi Map AnswerPlan sang mảng [key, item] tuần tự hóa để lưu vào storage/IPC
 */
export function serializeAnswerPlan(planMap) {
  if (!planMap) return [];
  if (Array.isArray(planMap)) return planMap;
  if (planMap instanceof Map) {
    return Array.from(planMap.entries());
  }
  return Object.entries(planMap);
}

/**
 * Khôi phục Map AnswerPlan từ mảng đã tuần tự hóa
 */
export function deserializeAnswerPlan(serialized) {
  if (!serialized) return new Map();
  if (serialized instanceof Map) return serialized;
  if (Array.isArray(serialized)) {
    return new Map(serialized);
  }
  return new Map(Object.entries(serialized));
}

export const STEP_TYPES = {
  INSPECT_PAGE: "INSPECT_PAGE",
  FILL_ONE_QUESTION: "FILL_ONE_QUESTION",
  VERIFY_ONE_QUESTION: "VERIFY_ONE_QUESTION",
  VERIFY_PAGE: "VERIFY_PAGE",
  PREPARE_NAVIGATION: "PREPARE_NAVIGATION",
  CLICK_NEXT: "CLICK_NEXT",
  CONFIRM_NAVIGATION: "CONFIRM_NAVIGATION",
  PREPARE_SUBMIT: "PREPARE_SUBMIT",
  CLICK_SUBMIT: "CLICK_SUBMIT",
  RECONCILE_CONFIRMATION: "RECONCILE_CONFIRMATION",
  FILL_VISIBLE_PAGE: "FILL_VISIBLE_PAGE",
  VERIFY_VISIBLE_PAGE: "VERIFY_PAGE",
  NAVIGATE_NEXT_RESPONSE: "NAVIGATE_NEXT_RESPONSE"
};

export function isElementTrulyVisible(el, targetDoc = typeof document !== "undefined" ? document : null) {
  if (!el) return false;
  if (el.isConnected !== undefined && !el.isConnected) return false;
  if (el.closest?.("[hidden]") || el.closest?.("[aria-hidden='true']")) return false;
  if (typeof el.checkVisibility === "function") {
    try {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch {}
  }
  if (el.getBoundingClientRect) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect && (rect.width <= 0 || rect.height <= 0)) {
        if (typeof window !== "undefined" && window.name !== "nodejs") {
          return false;
        }
      }
    } catch {}
  }
  const win = targetDoc?.defaultView || (typeof window !== "undefined" ? window : null);
  if (win && typeof win.getComputedStyle === "function") {
    try {
      const style = win.getComputedStyle(el);
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
        return false;
      }
    } catch {}
  }
  return true;
}

export function canonicalizeQuestionId(rawId) {
  if (rawId === null || rawId === undefined) return "";
  const s = String(rawId).trim();
  if (!s) return "";
  return s.replace(/^entry[._]/i, "");
}

export const LEDGER_QUESTION_STATE = Object.freeze({
  PLANNED: "PLANNED",
  FILL_ATTEMPTED: "FILL_ATTEMPTED",
  LOCALLY_OBSERVED: "LOCALLY_OBSERVED",
  SECTION_ACCEPTED_BY_GOOGLE: "SECTION_ACCEPTED_BY_GOOGLE",
  BRANCH_SKIPPED: "BRANCH_SKIPPED",
  NATIVE_REJECTED: "NATIVE_REJECTED"
});

export function verifyFormLedger(answerPlan = new Map(), verifiedQuestionIds = new Set(), canonicalQuestions = [], options = {}) {
  const verifiedSet = verifiedQuestionIds instanceof Set ? verifiedQuestionIds : new Set(Array.isArray(verifiedQuestionIds) ? verifiedQuestionIds : []);
  
  // Build lookup of all verified tokens (canonical, raw, entry-prefixed)
  const canonicalVerifiedSet = new Set();
  for (const v of verifiedSet) {
    if (v !== undefined && v !== null) {
      const raw = String(v).trim();
      if (raw) {
        canonicalVerifiedSet.add(raw);
        const canon = canonicalizeQuestionId(raw);
        if (canon) {
          canonicalVerifiedSet.add(canon);
          canonicalVerifiedSet.add(`entry.${canon}`);
        }
      }
    }
  }

  const ledger = options.ledger || options.activeResponse?.ledger || {};
  const navigationOccurred = Boolean(
    options.navigationOccurred ||
    options.activeResponse?.navigationOccurred ||
    (Array.isArray(options.activeResponse?.navigationHistory) && options.activeResponse.navigationHistory.length > 0) ||
    options.hasSectionChanged
  );
  const isGoogleRejectionPresent = Boolean(options.isGoogleRejectionPresent);

  if (isGoogleRejectionPresent) {
    return {
      valid: false,
      error: "Google Forms hiển thị thông báo lỗi bắt buộc/không hợp lệ trên trang. Không thể gửi biểu mẫu."
    };
  }

  // Branching / Screen-out to Submit detection
  let isBranchedToSubmit = Boolean(options.isBranchedToSubmit || options.activeResponse?.isBranchedToSubmit);
  if (!isBranchedToSubmit && answerPlan instanceof Map) {
    for (const [qId, planItem] of answerPlan.entries()) {
      if (canonicalVerifiedSet.has(String(qId)) || canonicalVerifiedSet.has(canonicalizeQuestionId(qId))) {
        if (planItem?.targetSectionId === -1 || planItem?.targetSectionId === -3) {
          isBranchedToSubmit = true;
          break;
        }
        if (Array.isArray(planItem?.targetOptions)) {
          for (const to of planItem.targetOptions) {
            if (to.targetSectionId === -1 || to.targetSectionId === -3) {
              isBranchedToSubmit = true;
              break;
            }
          }
        }
        if (isBranchedToSubmit) break;
      }
    }
  }

  const reconciledQuestions = [];

  const activeResp = options.activeResponse || null;
  const currentRespId = activeResp?.responseId || null;
  const currentRespIdx = activeResp?.responseIndex !== undefined ? activeResp.responseIndex : null;

  for (const q of canonicalQuestions) {
    if (!q || !q.required) continue;
    const rawId = String(q.id || q.sourceId || "").trim();
    const canonId = canonicalizeQuestionId(rawId);

    let isVerified = (
      (rawId && canonicalVerifiedSet.has(rawId)) ||
      (canonId && canonicalVerifiedSet.has(canonId)) ||
      (canonId && canonicalVerifiedSet.has(`entry.${canonId}`))
    );

    const ledgerEntry = (canonId && ledger[canonId]) || (rawId && ledger[rawId]);
    if (ledgerEntry) {
      if (ledgerEntry.state === LEDGER_QUESTION_STATE.NATIVE_REJECTED) {
        return {
          valid: false,
          missingQuestion: q,
          error: `Câu hỏi bắt buộc "${q.title}" (ID: ${q.id || "N/A"}) bị Google Forms từ chối native error.`
        };
      }

      // Response Isolation: Check that ledger entry belongs to current response
      const belongsToCurrent = (
        (!currentRespId || !ledgerEntry.responseId || ledgerEntry.responseId === currentRespId) &&
        (currentRespIdx === null || ledgerEntry.responseIndex === undefined || ledgerEntry.responseIndex === currentRespIdx)
      );

      if (belongsToCurrent) {
        if (
          ledgerEntry.state === LEDGER_QUESTION_STATE.LOCALLY_OBSERVED ||
          ledgerEntry.state === LEDGER_QUESTION_STATE.SECTION_ACCEPTED_BY_GOOGLE
        ) {
          isVerified = true;
          reconciledQuestions.push(canonId || rawId);
        }
      }
    }

    if (!isVerified) {
      // If Google Forms branched to submit early (Screen-out / Branching logic):
      // Question belongs to a section that Google Forms deliberately skipped.
      if (isBranchedToSubmit && canonicalVerifiedSet.size > 0 && navigationOccurred && !isGoogleRejectionPresent) {
        reconciledQuestions.push(`${canonId || rawId}:BRANCH_SKIPPED`);
        continue;
      }
      return {
        valid: false,
        missingQuestion: q,
        error: `Sổ cái xác minh chưa ghi nhận đáp án cho câu hỏi bắt buộc "${q.title}" (ID: ${q.id || "N/A"}). Không thể gửi biểu mẫu.`
      };
    }
  }

  return { valid: true, reconciledQuestions };
}

export function classifyNativeValidation(targetDoc = typeof document !== "undefined" ? document : null) {
  if (!targetDoc) return { hasVisibleError: false, errors: [] };
  const errorElements = Array.from(
    targetDoc.querySelectorAll?.(".RVPQ0c, [role='alert'], .freebirdFormviewerViewItemsItemErrorMessage") || []
  );

  const errors = [];
  const seenCards = new Set();

  for (const el of errorElements) {
    if (!isElementTrulyVisible(el, targetDoc)) continue;

    let rawText = (el.innerText || el.textContent || "").trim();
    if (!rawText && typeof el.querySelector === "function") {
      const errChild = el.querySelector(".freebirdFormviewerViewItemsItemErrorMessage, .RVPQ0c, [role='alert']");
      if (errChild) {
        rawText = (errChild.innerText || errChild.textContent || "").trim();
      }
    }
    const normText = norm(rawText);

    // Parent card identification - card itself or ancestor question card
    const card = (el.getAttribute?.("data-item-id") || el.getAttribute?.("data-entry-id"))
      ? el
      : (typeof el.closest === "function"
        ? el.closest("[data-item-id], [data-entry-id], [role='listitem'], .freebirdFormviewerViewItemsItemItem, .Qr7Oae")
        : null);
    const qId = card?.getAttribute?.("data-item-id") || card?.getAttribute?.("data-entry-id") || "";

    const cardHasInvalidState = Boolean(card && (
      card.getAttribute?.("aria-invalid") === "true" ||
      card.classList?.contains?.("hasError") ||
      card.classList?.contains?.("jfk-form-error") ||
      card.classList?.contains?.("freebirdFormviewerViewItemsItemHasError") ||
      card.classList?.contains?.("i30kJ")
    ));

    // Exclude informational alerts / banners (draft autosave "Đã lưu bản nháp", preview mode, account switch, tips)
    const isInformationalAlert = normText.includes("da luu ban nhap") ||
                                 normText.includes("draft saved") ||
                                 normText.includes("borrador guardado") ||
                                 normText.includes("brouillon enregistre") ||
                                 normText.includes("che do xem truoc") ||
                                 normText.includes("preview mode") ||
                                 normText.includes("switch account") ||
                                 normText.includes("chuyen doi tai khoan");
    if (isInformationalAlert) continue;

    const hasExplicitErrorKeyword = normText.length > 0 && (
      normText.includes("bat buoc") || normText.includes("required") ||
      normText.includes("khong hop le") || normText.includes("invalid") ||
      normText.includes("chua tra loi") || normText.includes("chon it nhat") ||
      normText.includes("phai nhap") || normText.includes("vui long") ||
      normText.includes("must match")
    );

    // A node is a true native validation error only when:
    // 1. It belongs to an actual question card AND has an explicit validation error message or the card is invalid, OR
    // 2. It has an explicit Google Forms validation error message and is an error container class (.RVPQ0c)
    const isRealError = (card && (hasExplicitErrorKeyword || (cardHasInvalidState && normText.length > 0))) ||
                        (hasExplicitErrorKeyword && el.classList?.contains?.("RVPQ0c"));

    if (isRealError) {
      const cardKey = qId || (card ? (card.className || rawText) : rawText);
      if (!seenCards.has(cardKey)) {
        seenCards.add(cardKey);
        errors.push({
          questionId: qId ? canonicalizeQuestionId(qId) : "",
          rawQuestionId: qId,
          text: rawText || "Google Forms: Câu hỏi chưa hợp lệ.",
          locatorEvidence: card ? (card.getAttribute?.("data-item-id") ? `[data-item-id="${card.getAttribute("data-item-id")}"]` : (card.className || "")) : (el.className || "")
        });
      }
    }
  }

  return {
    hasVisibleError: errors.length > 0,
    errors
  };
}

export function isGoogleNativeErrorPresent(targetDoc = typeof document !== "undefined" ? document : null) {
  return classifyNativeValidation(targetDoc).hasVisibleError;
}

export function extractNativeErrorCardIds(targetDoc = typeof document !== "undefined" ? document : null) {
  const result = classifyNativeValidation(targetDoc);
  return result.errors.map((e) => e.rawQuestionId || e.questionId).filter(Boolean);
}

export function evaluateGoogleRejection(targetDoc = typeof document !== "undefined" ? document : null) {
  const res = classifyNativeValidation(targetDoc);
  return {
    hasError: res.hasVisibleError,
    errorCount: res.errors.length,
    errorCards: res.errors.map((e) => e.rawQuestionId || e.questionId).filter(Boolean),
    errorMessage: res.errors[0]?.text || (res.hasVisibleError ? "Google Forms từ chối do câu hỏi chưa hợp lệ." : ""),
    errors: res.errors
  };
}



