// section-graph.mjs — Google Forms Section Graph & Branching Traversal
// Model-First structural discovery with cycle protection and branch resolution

import { fromGoogleItem, clean, extractJsonArray } from "./normalize-question.mjs";

/**
 * @typedef {Object} SectionEdge
 * @property {string} fromSectionId
 * @property {string} questionId
 * @property {string} choiceText
 * @property {number|string|-1} toSectionId - Section ID or -1 (Submit)
 */

/**
 * @typedef {Object} SectionNode
 * @property {string} id
 * @property {number} index
 * @property {string} title
 * @property {string} description
 * @property {import('./normalize-question.mjs').CanonicalQuestion[]} questions
 * @property {number|string|-1|null} defaultNext
 * @property {SectionEdge[]} edges
 */

/**
 * @typedef {Object} FormSectionGraph
 * @property {string} formTitle
 * @property {string} formDescription
 * @property {Map<string, SectionNode>} sections
 * @property {string[]} sectionOrder
 * @property {SectionEdge[]} allEdges
 */

/**
 * Parse raw FB_PUBLIC_LOAD_DATA_ into a structured FormSectionGraph
 * @param {any[]|string} source
 * @returns {FormSectionGraph|null}
 */
export function buildSectionGraph(source) {
  let data = source;
  if (typeof source === "string") {
    try {
      const anchor = source.indexOf("FB_PUBLIC_LOAD_DATA_");
      if (anchor >= 0) {
        const jsonStr = extractJsonArray(source, anchor);
        if (!jsonStr) return null;
        data = JSON.parse(jsonStr);
      } else {
        const jsonStr = extractJsonArray(source, 0);
        data = jsonStr ? JSON.parse(jsonStr) : JSON.parse(source);
      }
    } catch {
      return null;
    }
  }

  const items = data?.[1]?.[1];
  if (!Array.isArray(items)) return null;

  const formTitle = clean(data?.[1]?.[8]) || "Google Form";
  const formDescription = clean(data?.[1]?.[0]) || "";

  const sections = new Map();
  const sectionOrder = [];
  const allEdges = [];

  // Initialize initial Section 1
  let currentSectionId = "section_0";
  let currentSectionIndex = 0;
  let currentSection = {
    id: currentSectionId,
    index: currentSectionIndex,
    title: "Phần 1",
    description: "",
    questions: [],
    defaultNext: null,
    edges: []
  };

  sections.set(currentSectionId, currentSection);
  sectionOrder.push(currentSectionId);

  let questionOrder = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!Array.isArray(item)) continue;

    const typeCode = item[3];

    // Section Break (typeCode === 8)
    if (typeCode === 8) {
      currentSectionIndex++;
      currentSectionId = String(item[0] ?? `section_${currentSectionIndex}`);
      const sectionTitle = clean(item[1]) || `Phần ${currentSectionIndex + 1}`;
      const sectionDesc = clean(item[2]) || "";
      const defaultNav = Array.isArray(item[8]) ? item[8][0] : null;

      currentSection = {
        id: currentSectionId,
        index: currentSectionIndex,
        title: sectionTitle,
        description: sectionDesc,
        questions: [],
        defaultNext: typeof defaultNav === "number" ? defaultNav : null,
        edges: []
      };

      sections.set(currentSectionId, currentSection);
      sectionOrder.push(currentSectionId);
      continue;
    }

    // Normal or Grid Question
    const canonicalQ = fromGoogleItem(item, currentSectionId, questionOrder++);
    if (!canonicalQ) continue;

    currentSection.questions.push(canonicalQ);

    // Check for choice-level branching edges
    if (Array.isArray(canonicalQ.options)) {
      for (const opt of canonicalQ.options) {
        if (opt.targetSectionId !== null && opt.targetSectionId !== undefined) {
          const edge = {
            fromSectionId: currentSectionId,
            questionId: canonicalQ.sourceId,
            choiceText: opt.text,
            toSectionId: opt.targetSectionId
          };
          currentSection.edges.push(edge);
          allEdges.push(edge);
        }
      }
    }
  }

  // Link sequential default edges if defaultNext is not explicitly set
  for (let i = 0; i < sectionOrder.length; i++) {
    const sId = sectionOrder[i];
    const sec = sections.get(sId);
    if (sec && sec.defaultNext === null) {
      if (i < sectionOrder.length - 1) {
        sec.defaultNext = sectionOrder[i + 1];
      } else {
        sec.defaultNext = -1; // Last section defaults to submit
      }
    }
  }

  return {
    formTitle,
    formDescription,
    sections,
    sectionOrder,
    allEdges
  };
}

/**
 * Traverse graph using BFS to find all reachable sections with cycle protection
 * @param {FormSectionGraph} graph
 * @param {string} startSectionId
 * @returns {Set<string>} Set of reachable section IDs
 */
export function getReachableSections(graph, startSectionId = "section_0") {
  const reachable = new Set();
  if (!graph || !graph.sections.size) return reachable;

  const startId = graph.sections.has(startSectionId)
    ? startSectionId
    : graph.sectionOrder[0];

  const queue = [startId];
  reachable.add(startId);

  while (queue.length > 0) {
    const currId = queue.shift();
    const currSection = graph.sections.get(currId);
    if (!currSection) continue;

    // Collect next potential targets:
    const candidateTargets = [];

    // 1. Default navigation target
    if (currSection.defaultNext !== null && currSection.defaultNext !== -1) {
      candidateTargets.push(String(currSection.defaultNext));
    }

    // 2. Choice-level branching edges
    for (const edge of currSection.edges) {
      let target = edge.toSectionId;
      if (target === -1 || target === -3) continue; // Submit / disqualification
      if (target === -2) target = currSection.defaultNext; // Continue to next section
      if (target !== -1 && target != null) {
        candidateTargets.push(String(target));
      }
    }

    for (const targetId of candidateTargets) {
      if (graph.sections.has(targetId) && !reachable.has(targetId)) {
        reachable.add(targetId);
        queue.push(targetId);
      }
    }
  }

  return reachable;
}

/**
 * Extract all canonical questions from graph in proper topological / form order.
 * If reachableOnly is true, only returns questions from reachable sections.
 * If reachableOnly is false, returns all questions across the entire form.
 * 
 * @param {FormSectionGraph} graph
 * @param {boolean} reachableOnly
 * @returns {import('./normalize-question.mjs').CanonicalQuestion[]}
 */
export function extractQuestionsFromGraph(graph, reachableOnly = true) {
  if (!graph || !graph.sections) return [];

  const reachableSet = reachableOnly ? getReachableSections(graph) : null;
  const result = [];

  for (const sId of graph.sectionOrder) {
    if (reachableOnly && !reachableSet.has(sId)) {
      continue;
    }
    const section = graph.sections.get(sId);
    if (section && section.questions) {
      result.push(...section.questions);
    }
  }

  return result;
}
