// scan.mjs — Google Forms Public Model Parser & Section Graph Integrator
// Combines Model-First parsing, section graphs, and dual-output compatibility.

import { buildSectionGraph, extractQuestionsFromGraph, getReachableSections } from "./section-graph.mjs";
import { toLegacyScanOutput, CANONICAL_TYPES, clean, extractJsonArray, extractScaleOptions } from "./normalize-question.mjs";

const TYPES = {
  0: "text",
  1: "paragraph",
  2: "radio",
  3: "select",
  4: "checkbox",
  5: "radio",
  7: "radio",
  9: "date",
  10: "time",
  13: "file",
  14: "checkbox"
};

function choices(entry) {
  return (Array.isArray(entry?.[1]) ? entry[1] : []).map((raw) => {
    const value = Array.isArray(raw) ? raw : [raw];
    const other = value[4] === 1 || value[0] === "__other_option__";
    return { text: other ? "Khác" : clean(value[0]), other };
  }).filter((option) => Boolean(option.text));
}

function rowNames(item, entries) {
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
  const options = new Set(entries.flatMap(choices).map((option) => option.text));
  return lists.find((list) => list.some((name) => !options.has(name))) || [];
}

/**
 * Parse Google Form public model into structured detailed results.
 * Returns canonical questions, legacy questions, graph info, and unsupported items.
 * 
 * @param {string|any[]} source
 * @returns {{
 *   questions: Array<{id: string, title: string, type: string, required: boolean, options: Array<{text: string, other: boolean}>}>,
 *   legacyQuestions: Array<any>,
 *   canonicalQuestions: Array<any>,
 *   graph: any,
 *   sectionsTotal: number,
 *   sectionsResolved: number,
 *   formTitle: string,
 *   unsupported: Array<any>
 * }}
 */
export function parsePublicFormDetailed(source) {
  try {
    let data = source;
    if (typeof source === "string") {
      const anchor = source.indexOf("FB_PUBLIC_LOAD_DATA_");
      if (anchor >= 0) {
        const jsonStr = extractJsonArray(source, anchor);
        if (!jsonStr) return emptyResult();
        data = JSON.parse(jsonStr);
      } else {
        const jsonStr = extractJsonArray(source, 0);
        data = jsonStr ? JSON.parse(jsonStr) : JSON.parse(source);
      }
    }

    const items = data?.[1]?.[1];
    if (!Array.isArray(items)) return emptyResult();

    // 1. Build Section Graph
    const graph = buildSectionGraph(data);
    const reachableSections = graph ? getReachableSections(graph) : new Set();

    // 2. Extract Canonical Questions from reachable sections
    const canonicalQuestions = graph ? extractQuestionsFromGraph(graph, true) : [];

    // 3. Generate Legacy Compatible Output for storage / golden contract
    const legacyQuestions = toLegacyScanOutput(canonicalQuestions);

    // 4. Generate questions matching V5 / unit-test schema
    const questions = [];
    const unsupported = [];

    for (const item of items) {
      if (!Array.isArray(item)) continue;
      if (item[3] === 8) continue; // Section break

      const type = TYPES[item[3]];
      const entries = Array.isArray(item[4]) ? item[4].filter(Array.isArray) : [];
      if (!entries.length) continue;

      if (!type) {
        unsupported.push({
          itemId: String(item[0] ?? ""),
          title: clean(item[1]),
          typeCode: item[3],
          entryIds: entries.map((entry) => String(entry[0] ?? ""))
        });
        continue;
      }

      const rows = entries.length > 1 ? rowNames(item, entries) : [];
      entries.forEach((entry, index) => {
        let opts = ["radio", "checkbox", "select"].includes(type) ? choices(entry) : [];
        if (item[3] === 5 && !opts.length) {
          opts = extractScaleOptions(item, entry).map((o) => ({ text: o.text, other: false }));
        }
        questions.push({
          id: String(entry[0] ?? `${item[0]}:${index}`),
          title: `${clean(item[1]) || `Câu hỏi ${questions.length + 1}`}${entries.length > 1 ? ` [${rows[index] || `Hàng ${index + 1}`}]` : ""}`,
          type,
          required: entry[2] === 1,
          options: opts
        });
      });
    }

    // Number duplicate titles gracefully for V5 questions
    const seen = new Map();
    const normalizedQuestions = questions.map((question) => {
      const count = (seen.get(question.title) || 0) + 1;
      seen.set(question.title, count);
      return count === 1 ? question : { ...question, title: `${question.title} [${count}]` };
    });

    return {
      questions: normalizedQuestions,
      legacyQuestions,
      canonicalQuestions,
      graph,
      sectionsTotal: graph ? graph.sections.size : 1,
      sectionsResolved: reachableSections.size || 1,
      formTitle: graph?.formTitle || clean(data?.[1]?.[8]) || "Google Form",
      rawItemCount: Array.isArray(items) ? items.length : 0,
      unsupported
    };
  } catch {
    return emptyResult();
  }
}

function emptyResult() {
  return {
    questions: [],
    legacyQuestions: [],
    canonicalQuestions: [],
    graph: null,
    sectionsTotal: 0,
    sectionsResolved: 0,
    formTitle: "",
    rawItemCount: 0,
    unsupported: []
  };
}

export const parsePublicForm = (source) => parsePublicFormDetailed(source).questions;

export { buildSectionGraph, extractQuestionsFromGraph, getReachableSections } from "./section-graph.mjs";
export { toLegacyScanOutput, CANONICAL_TYPES, extractJsonArray } from "./normalize-question.mjs";
