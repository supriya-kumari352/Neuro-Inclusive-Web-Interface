/**
 * Client-side Cognitive Load Score (0–100, higher = harder).
 * Combines text complexity heuristics with optional DOM "clutter" stats from the page.
 */

import type { DomStats } from "./messages.js";

export type CognitiveLoadResult = {
  /** Overall score 0–100 */
  score: number;
  /** Human-readable factors for UI */
  factors: {
    sentenceComplexity: number;
    paragraphLength: number;
    syllableLoad: number;
    clutter: number;
    headingDensity: number;
    jargonLoad: number;
  };
};

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 2) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let syl = groups ? groups.length : 1;
  if (w.endsWith("e")) syl = Math.max(1, syl - 1);
  return Math.max(1, syl);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Approximate grade level using average words per sentence and syllables per word.
 * Returns a mid-range score contribution (0–40 mapped internally).
 */
function textComplexityScore(text: string): {
  scorePart: number;
  avgWordsPerSentence: number;
  avgSyllablesPerWord: number;
  avgParagraphLen: number;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      scorePart: 0,
      avgWordsPerSentence: 0,
      avgSyllablesPerWord: 0,
      avgParagraphLen: 0,
    };
  }
  const paras = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  const paraLens = paras.map((p) => words(p).length);
  const avgParagraphLen =
    paraLens.length > 0 ? paraLens.reduce((a, b) => a + b, 0) / paraLens.length : words(trimmed).length;

  const sents = sentences(trimmed.replace(/\n+/g, " "));
  const allWords = words(trimmed.replace(/\n+/g, " "));
  const avgWordsPerSentence =
    sents.length > 0 ? allWords.length / Math.max(1, sents.length) : allWords.length;
  const syllables = allWords.reduce((acc, w) => acc + countSyllables(w), 0);
  const avgSyllablesPerWord = allWords.length > 0 ? syllables / allWords.length : 0;

  // Map rough difficulty to 0–40 each sub-metric, then combine
  const sentScore = Math.min(40, Math.max(0, (avgWordsPerSentence - 10) * 2));
  const sylScore = Math.min(40, Math.max(0, (avgSyllablesPerWord - 1.4) * 35));
  const paraScore = Math.min(40, Math.max(0, (avgParagraphLen - 80) * 0.15));

  const scorePart = Math.min(100, (sentScore + sylScore + paraScore) / 3);
  return { scorePart, avgWordsPerSentence, avgSyllablesPerWord, avgParagraphLen };
}

function clutterScore(stats: DomStats | undefined): number {
  if (!stats) return 20;
  const {
    images,
    iframes,
    videos,
    buttons,
    links,
    maxDepthSample,
    popups = 0,
    sidebars = 0,
    denseTextBlocks = 0,
    textDensity = 0,
    difficultTerms = 0,
  } = stats;
  const raw =
    images * 0.35 +
    iframes * 3 +
    videos * 2 +
    buttons * 0.12 +
    links * 0.06 +
    maxDepthSample * 1.2 +
    popups * 8 +
    sidebars * 4 +
    denseTextBlocks * 3 +
    Math.max(0, (textDensity - 18) * 1.2) +
    difficultTerms * 2;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Compute holistic cognitive load. Text contributes ~70%, clutter ~30% by default.
 */
export function computeCognitiveLoad(
  text: string,
  domStats?: DomStats
): CognitiveLoadResult {
  const t = textComplexityScore(text);
  const c = clutterScore(domStats);

  const sentenceComplexity = Math.min(100, t.avgWordsPerSentence * 4);
  const paragraphLength = Math.min(100, t.avgParagraphLen / 3);
  const syllableLoad = Math.min(100, t.avgSyllablesPerWord * 40);
  const headingDensity = Math.min(100, (domStats?.headings ?? 0) * 8);
  const jargonLoad = Math.min(100, (domStats?.difficultTerms ?? 0) * 7);

  const combined =
    t.scorePart * 0.48 +
    c * 0.32 +
    syllableLoad * 0.1 +
    headingDensity * 0.05 +
    jargonLoad * 0.05;
  const score = Math.round(Math.min(100, Math.max(0, combined)));

  return {
    score,
    factors: {
      sentenceComplexity: Math.round(sentenceComplexity),
      paragraphLength: Math.round(paragraphLength),
      syllableLoad: Math.round(syllableLoad),
      clutter: Math.round(c),
      headingDensity: Math.round(headingDensity),
      jargonLoad: Math.round(jargonLoad),
    },
  };
}
