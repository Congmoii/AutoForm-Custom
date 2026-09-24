export const KEYS = { store: "aksStoreV5", session: "aksSession", scan: "aksScan" };

export const formId = (url = "") => String(url).match(/\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]+)/)?.[1] || "";
export const viewUrl = (url = "") => String(url).replace(/\/forms\/u\/\d+\//, "/forms/").replace(/\/(?:viewform|formResponse)(?=\?|$)/i, "/viewform");
export const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted && c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "," || c === "\n")) { row.push(cell.replace(/\r$/, "")); cell = ""; if (c === "\n") { rows.push(row); row = []; } }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  if (!headers.length || headers.some((header) => !header)) throw new Error("CSV có tiêu đề cột trống.");
  const unique = new Set(headers.map(normalize));
  if (unique.size !== headers.length) throw new Error("CSV có tiêu đề cột bị trùng.");
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

const csvCell = (value) => /[",\r\n]/.test(String(value ?? "")) ? `"${String(value ?? "").replace(/"/g, '""')}"` : String(value ?? "");
export const stringifyCsv = (headers, rows) => [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

export function allocate(items, csvLength = Infinity) {
  let cursor = 0;
  const result = items.map((item) => {
    const count = Math.max(1, Math.floor(Number(item.count) || 0));
    const next = { ...item, count, csvStart: cursor };
    cursor += count;
    return next;
  });
  if (cursor > csvLength) throw new Error(`Lịch cần ${cursor} dòng CSV nhưng chỉ có ${csvLength} dòng.`);
  return { items: result, used: cursor };
}

export function randomPercentages(count) {
  if (count < 1) return [];
  const raw = Array.from({ length: count }, () => Math.random() + 0.05);
  const sum = raw.reduce((a, b) => a + b, 0);
  const exact = raw.map((value) => value / sum * 100), values = exact.map(Math.floor);
  let left = 100 - values.reduce((a, b) => a + b, 0);
  exact.map((value, index) => ({ index, fraction: value - values[index] })).sort((a, b) => b.fraction - a.fraction).slice(0, left).forEach(({ index }) => values[index]++);
  return values;
}

const tokens = (value) => {
  const result = []; let part = "", depth = 0;
  for (const char of String(value ?? "")) {
    if ("[{".includes(char)) depth++;
    if ("]}".includes(char)) depth--;
    if (!depth && ",;|".includes(char)) { if (part.trim()) result.push(part.trim()); part = ""; } else part += char;
  }
  if (part.trim()) result.push(part.trim()); return result;
};

export function validateCsvRows(questions = [], rows = []) {
  if (!rows.length) throw new Error("CSV không có dòng dữ liệu.");
  const headers = Object.keys(rows[0]), byName = new Map(headers.map((header) => [normalize(header), header]));
  for (const question of questions) {
    const header = byName.get(normalize(question.title));
    if (question.required && !header) throw new Error(`CSV thiếu cột bắt buộc: ${question.title}.`);
    if (!header) continue;
    rows.forEach((row, rowIndex) => {
      const value = String(row[header] ?? "").trim();
      if (!value) { if (question.required) throw new Error(`Dòng ${rowIndex + 2} thiếu “${question.title}”.`); return; }
      if (!["radio", "checkbox", "select"].includes(question.type)) return;
      const choices = question.options || [], parts = question.type === "checkbox" ? tokens(value) : [value];
      for (const part of parts) {
        const index = part.match(/^\[(\d+)]$/), other = part.match(/^\{[\s\S]+}$/);
        const valid = index ? Number(index[1]) >= 1 && Number(index[1]) <= choices.length : other ? choices.some((choice) => choice.other) : choices.filter((choice) => normalize(choice.text) === normalize(part)).length === 1;
        if (!valid) throw new Error(`Dòng ${rowIndex + 2}: đáp án “${part}” không hợp lệ cho “${question.title}”.`);
      }
    });
  }
  return true;
}
