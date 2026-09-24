// normalize-question.mjs — Canonical Question Normalization & Legacy Output Adapter
// Strict backward compatibility with golden-reference-20260813

export const CANONICAL_TYPES = Object.freeze({
  RADIO: "radio",
  CHECKBOX: "checkbox",
  SELECT: "select",
  SHORT_TEXT: "short_text",
  PARAGRAPH: "paragraph",
  LINEAR_SCALE: "linear_scale",
  RADIO_GRID: "radio_grid",
  CHECKBOX_GRID: "checkbox_grid",
  DATE: "date",
  TIME: "time",
  FILE: "file",
  UNKNOWN: "unknown"
});

export const GOOGLE_CODE_TO_CANONICAL = Object.freeze({
  0: CANONICAL_TYPES.SHORT_TEXT,
  1: CANONICAL_TYPES.PARAGRAPH,
  2: CANONICAL_TYPES.RADIO,
  3: CANONICAL_TYPES.SELECT,
  4: CANONICAL_TYPES.CHECKBOX,
  5: CANONICAL_TYPES.LINEAR_SCALE,
  7: CANONICAL_TYPES.RADIO_GRID,
  9: CANONICAL_TYPES.DATE,
  10: CANONICAL_TYPES.TIME,
  13: CANONICAL_TYPES.FILE,
  14: CANONICAL_TYPES.CHECKBOX_GRID
});

export const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * Safely extracts the first balanced JSON array substring [...] from text starting at startIndex.
 * Ignores brackets inside string literals and properly handles escape sequences.
 * 
 * @param {string} text 
 * @param {number} startIndex 
 * @returns {string|null}
 */
export function extractJsonArray(text, startIndex = 0) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("[", startIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extract choices from a raw Google Forms entry item
 * @param {any[]} entry
 * @returns {Array<{text: string, isOther: boolean, targetSectionId: number|string|null}>}
 */
export function extractChoices(entry) {
  const rawList = Array.isArray(entry?.[1]) ? entry[1] : [];
  return rawList.map((raw) => {
    const arr = Array.isArray(raw) ? raw : [raw];
    const rawText = clean(arr[0]);
    const isOther = arr[4] === 1 || rawText === "__other_option__" || rawText.toLowerCase().startsWith("khác");
    let targetSectionId = null;
    if (typeof arr[2] === "number") {
      targetSectionId = arr[2];
    } else if (typeof arr[2] === "string" && arr[2].trim() !== "") {
      const num = Number(arr[2].trim());
      targetSectionId = Number.isFinite(num) ? num : arr[2].trim();
    }
    return {
      text: isOther && rawText === "__other_option__" ? "Mục khác" : rawText,
      isOther,
      targetSectionId
    };
  }).filter((opt) => Boolean(opt.text));
}

/**
 * Extract grid row names from item[5] or sub-arrays
 * @param {any[]} item
 * @param {number} entryCount
 * @returns {string[]}
 */
export function extractGridRows(item, entryCount) {
  const candidates = [];
  const walk = (value, depth = 0) => {
    if (!Array.isArray(value) || depth > 4) return;
    const names = value.map((part) =>
      typeof part === "string" ? clean(part)
        : Array.isArray(part) && typeof part[0] === "string" ? clean(part[0]) : "");
    if (names.length === entryCount && names.every(Boolean)) {
      candidates.push(names);
    }
    value.forEach((part) => walk(part, depth + 1));
  };
  item.slice(5).forEach((part) => walk(part));
  return candidates[0] || Array.from({ length: entryCount }, (_, i) => `Hàng ${i + 1}`);
}

/**
 * Extract column options for a grid item
 * @param {any[]} entries
 * @returns {Array<{text: string, isOther: boolean}>}
 */
export function extractGridColumns(entries) {
  if (!entries.length) return [];
  const first = entries[0];
  return extractChoices(first).map(({ text, isOther }) => ({ text, isOther }));
}

/**
 * Extract choices for Linear Scale (type 5).
 * If explicit choices exist, extract them; otherwise synthesize options from bounds (min..max).
 * @param {any[]} item
 * @param {any[]} primaryEntry
 * @returns {Array<{text: string, isOther: boolean, targetSectionId: any}>}
 */
export function extractScaleOptions(item, primaryEntry) {
  const extracted = extractChoices(primaryEntry);
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

  walk(primaryEntry);
  if (!foundBounds) walk(item);

  return Array.from({ length: max - min + 1 }, (_, i) => ({
    text: String(min + i),
    isOther: false,
    targetSectionId: null
  }));
}

/**
 * Convert a raw Google Forms item into a CanonicalQuestion
 * @param {any[]} item
 * @param {string} sectionId
 * @param {number} order
 * @returns {CanonicalQuestion|null}
 */
export function fromGoogleItem(item, sectionId = "section_0", order = 0) {
  if (!Array.isArray(item) || item[3] === 8) return null; // type 8 is Section Break
  const typeCode = item[3];
  const canonicalType = GOOGLE_CODE_TO_CANONICAL[typeCode] || CANONICAL_TYPES.UNKNOWN;
  const entries = Array.isArray(item[4]) ? item[4].filter(Array.isArray) : [];
  if (!entries.length) return null;

  const itemId = String(item[0] ?? "");
  const baseTitle = clean(item[1]) || `Câu hỏi ${order + 1}`;
  const description = item[2] ? clean(item[2]) : "";
  const isRequired = entries.some((e) => e[2] === 1);

  if (canonicalType === CANONICAL_TYPES.RADIO_GRID || canonicalType === CANONICAL_TYPES.CHECKBOX_GRID) {
    const rows = extractGridRows(item, entries.length);
    const columns = extractGridColumns(entries);
    const rowEntryIds = entries.map((e) => String(e[0] ?? ""));

    return {
      sourceId: String(entries[0]?.[0] ?? itemId),
      itemId,
      sectionId,
      order,
      title: baseTitle,
      description,
      type: canonicalType,
      required: isRequired,
      options: columns,
      rows,
      columns: columns.map((c) => c.text),
      rowEntryIds,
      metadata: { rawTypeCode: typeCode, entryCount: entries.length }
    };
  }

  const primaryEntry = entries[0];
  const sourceId = String(primaryEntry[0] ?? itemId);
  const choices = [CANONICAL_TYPES.RADIO, CANONICAL_TYPES.CHECKBOX, CANONICAL_TYPES.SELECT].includes(canonicalType)
    ? extractChoices(primaryEntry)
    : canonicalType === CANONICAL_TYPES.LINEAR_SCALE
    ? extractScaleOptions(item, primaryEntry)
    : [];

  return {
    sourceId,
    itemId,
    sectionId,
    order,
    title: baseTitle,
    description,
    type: canonicalType,
    required: primaryEntry[2] === 1,
    options: choices,
    rows: [],
    columns: [],
    rowEntryIds: [sourceId],
    metadata: { rawTypeCode: typeCode }
  };
}

/**
 * Adapter to transform CanonicalQuestions into the exact 6-field LegacyScannedQuestion contract
 * conforming to golden-reference-20260813.
 * 
 * @param {CanonicalQuestion[]} canonicalQuestions
 * @returns {Array<{index: number, title: string, type: string, optionsCount: number, options: Array<{text: string, isOther: boolean}>, isRequired: boolean, id?: string, sourceId?: string}>}
 */
export function toLegacyScanOutput(canonicalQuestions = []) {
  const result = [];
  let currentIndex = 0;

  for (const q of canonicalQuestions) {
    if (q.type === CANONICAL_TYPES.RADIO_GRID || q.type === CANONICAL_TYPES.CHECKBOX_GRID) {
      const isRadio = q.type === CANONICAL_TYPES.RADIO_GRID;
      const targetType = isRadio ? "radio" : "checkbox";
      const rows = q.rows && q.rows.length ? q.rows : Array.from({ length: q.rowEntryIds?.length || 1 }, (_, i) => `Hàng ${i + 1}`);
      const options = (q.options || []).map((opt) => ({
        text: typeof opt === "string" ? opt : opt.text,
        isOther: Boolean(opt.isOther)
      }));

      rows.forEach((rowName, rIdx) => {
        const rowTitle = `${q.title} [${rowName}]`;
        const rowId = q.rowEntryIds?.[rIdx] || `${q.sourceId}:${rIdx}`;
        result.push({
          index: currentIndex++,
          title: rowTitle,
          type: targetType,
          optionsCount: options.length,
          options: options.map((o) => ({ ...o })),
          isRequired: Boolean(q.required),
          // Additional stable internal metadata for V5 / downstream without breaking legacy shape
          id: rowId,
          sourceId: rowId
        });
      });
      continue;
    }

    let legacyType = q.type;
    if (q.type === CANONICAL_TYPES.SHORT_TEXT) {
      legacyType = "short_answer";
    } else if (q.type === CANONICAL_TYPES.LINEAR_SCALE) {
      legacyType = "radio";
    }

    const options = (q.options || []).map((opt) => ({
      text: typeof opt === "string" ? opt : opt.text,
      isOther: Boolean(opt.isOther)
    }));

    result.push({
      index: currentIndex++,
      title: q.title,
      type: legacyType,
      optionsCount: options.length,
      options,
      isRequired: Boolean(q.required),
      id: q.sourceId || `q_${currentIndex}`,
      sourceId: q.sourceId
    });
  }

  // Deduplicate title collisions gracefully with numbered suffix while preserving separate index & sourceId
  const titleCounts = new Map();
  return result.map((item) => {
    const count = (titleCounts.get(item.title) || 0) + 1;
    titleCounts.set(item.title, count);
    if (count > 1) {
      return { ...item, title: `${item.title} [${count}]` };
    }
    return item;
  });
}
