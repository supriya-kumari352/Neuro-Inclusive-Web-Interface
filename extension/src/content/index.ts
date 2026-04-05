/**
 * Content script: DOM extraction, theme injection, distraction reduction, focus overlay, simplified panel.
 * Guard: skip if already injected (prevents duplicate listeners on re-injection).
 */
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
  DomStats,
  PageAnalysis,
  PageSettings,
} from "../shared/messages.js";
import { estimateMainElement } from "./extract.js";
import {
  analyzePageDom,
  applyDifficultHighlights,
  applyImportanceHeatmap,
  clearImportanceHeatmap,
  clearDifficultHighlights,
  getClassifiedElements,
} from "./domPipeline.js";
import {
  BASE_ATTR,
  buildThemeCss,
  DISTRACTION_CSS,
} from "./stylesInjected.js";

const GUARD_ATTR = "data-neuro-inclusive-injected";
const READY_ATTR = "data-neuro-inclusive-ready";

function initContentScript(): void {
const OVERLAY_ID = "neuro-inclusive-simplified-panel";
const FOCUS_ID = "neuro-inclusive-focus-layer";
const QUICK_LAUNCHER_ID = "neuro-inclusive-quick-launcher";
const QUICK_PANEL_ID = "neuro-inclusive-quick-panel";
const PAUSED_BY_EXTENSION_ATTR = "data-neuro-inclusive-paused";
const HIDDEN_BY_EXTENSION_ATTR = "data-neuro-inclusive-hidden";
const DIMMED_BY_EXTENSION_ATTR = "data-neuro-inclusive-dimmed";
const ANALYSIS_TTL_MS = 1200;
const MAX_TEXT_FOR_REMOTE = 6000;
const MAX_TEXT_FOR_LOCAL = 12000;
const MAX_EXPLAIN_SELECTION = 300;
const FOCUS_SPOTLIGHT_RADIUS = 220;
const FOCUS_EDGE_SOFTNESS = 78;
const FOCUS_DIM_ALPHA = 0.42;
const FLOW_PROGRESS_ID = "neuro-inclusive-flow-progress";
const FLOW_PROGRESS_FILL_ID = "neuro-inclusive-flow-progress-fill";
const FLOW_MARKER_ID = "neuro-inclusive-flow-marker";
const FLOW_CURRENT_ATTR = "data-neuro-inclusive-flow-current";
const FLOW_RESUME_ATTR = "data-neuro-inclusive-flow-resume";
const FLOW_MIN_CHARS = 90;
const FLOW_SYNC_MS = 900;
const FLOW_UPDATE_MIN_MS = 140;
const FLOW_STORAGE_KEY = "neuro-inclusive-reading-flow-v1";
const MAX_STRUCTURED_SECTIONS = 8;
const DISTRACTION_REFRESH_MIN_MS = 850;
const CLUTTER_RE =
  /\b(nav|menu|toolbar|header|footer|sidebar|rail|recommend|related|promo|advert|sponsor|cookie|consent|subscribe|newsletter|share|social|widget|trending|upsell|floating|sticky)\b/i;

function localDefineFallback(term: string): string {
  const t = term.trim().slice(0, 200);
  if (!t) return "Select a word or short phrase to explain.";
  return `(Offline) "${t}": short explanation unavailable without the API - try a dictionary or enable the server.`;
}

function localSimplifyFallback(text: string): string {
  const clipped = text.slice(0, MAX_TEXT_FOR_LOCAL);
  const sentences = clipped.split(/(?<=[.!?])\s+/);
  return sentences
    .map((s) => {
      const words = s.trim().split(/\s+/).filter(Boolean);
      if (words.length > 22) return `${words.slice(0, 18).join(" ")}.`;
      return s;
    })
    .join(" ")
    .trim();
}

function localSummarizeFallback(text: string, mode: "tldr" | "bullets"): string {
  const clipped = text.slice(0, MAX_TEXT_FOR_LOCAL);
  const trimmed = clipped.trim();
  const sentences = clipped
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (mode === "tldr") {
    return sentences[0] || trimmed.slice(0, 180) || "No content to summarize.";
  }
  return sentences
    .slice(0, 6)
    .map((s) => `- ${s}`)
    .join("\n");
}

function normalizeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e || "Unknown error");
}

async function bgRequest(message: BackgroundRequest): Promise<BackgroundResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as BackgroundResponse;
    return response;
  } catch (e) {
    return { ok: false, error: normalizeError(e) };
  }
}

const DISTRACTION_HIDE_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[class*="modal"]',
  '[id*="modal"]',
  '[class*="popup"]',
  '[id*="popup"]',
  '[class*="overlay"]',
  '[class*="interstitial"]',
  '[class*="paywall"]',
  '[class*="consent"]',
  '[class*="gdpr"]',
  '[id*="cookie"]',
  '[id*="consent"]',
  '[aria-label*="cookie"]',
  '[aria-label*="consent"]',
  '[class*="cookie"]',
  '[class*="newsletter"]',
  '[class*="subscribe"]',
  '[data-testid*="modal"]',
  '[data-testid*="popup"]',
].join(",");

const DISTRACTION_DIM_SELECTOR = [
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  '[class*="advert"]',
  '[id*="ad-"]',
  '[id*="ad_"]',
  '[class*="sponsor"]',
  '[class*="promo"]',
  '[class*="recommend"]',
  '[class*="suggest"]',
  '[class*="related"]',
  '[class*="sticky"]',
  '[class*="floating"]',
  '[id*="sidebar"]',
  '[class*="sidebar"]',
  'nav',
  'header[role="banner"]',
  'aside',
  '[role="complementary"]',
  'video[autoplay]',
  'audio[autoplay]',
].join(",");

let styleEl: HTMLStyleElement | null = null;
let distractionEl: HTMLStyleElement | null = null;
let focusListenersAttached = false;
let focusRaf = 0;
let focusPointerX = Math.round(window.innerWidth * 0.5);
let focusPointerY = Math.round(window.innerHeight * 0.5);
let cachedAnalysis: PageAnalysis | null = null;
let cachedAnalysisAt = 0;
const modifiedDistractionElements = new Set<HTMLElement>();
const previousStyleByElement = new WeakMap<HTMLElement, string | null>();
let distractionObserver: MutationObserver | null = null;
let distractionRefreshRaf = 0;
let distractionDelayedTimer: number | null = null;
let distractionLastAppliedAt = 0;
let currentSettings: PageSettings = {
  theme: "default",
  fontSizePx: 16,
  lineHeight: 1.5,
  letterSpacingEm: 0,
  readabilityMode: false,
  distractionReduction: false,
  focusMode: false,
  bionicReading: false,
  readingRuler: false,
};
let quickLauncherEl: HTMLButtonElement | null = null;
let quickPanelEl: HTMLDivElement | null = null;
let quickStatusEl: HTMLDivElement | null = null;
let quickResultWrapEl: HTMLDivElement | null = null;
let quickResultTextEl: HTMLPreElement | null = null;
let quickReadabilityInput: HTMLInputElement | null = null;
let quickDistractionInput: HTMLInputElement | null = null;
let quickFocusInput: HTMLInputElement | null = null;
let quickImportanceInput: HTMLInputElement | null = null;
let simplifiedPanelTextEl: HTMLPreElement | null = null;
let quickMenuBusy = false;
const quickActionButtons = new Set<HTMLButtonElement>();
let quickDismissHandlersAttached = false;
let readingFlowEnabled = false;
let flowParagraphs: HTMLElement[] = [];
let flowCurrentParagraph: HTMLElement | null = null;
let flowResumeParagraph: HTMLElement | null = null;
let flowUpdateRaf = 0;
let flowUpdateTimer: number | null = null;
let flowLastUpdatedAt = 0;
let flowLastSavedAt = 0;
let importanceHeatmapEnabled = false;

function ensureStyleEl(): HTMLStyleElement {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-neuro-inclusive", "theme");
    document.documentElement.appendChild(styleEl);
  }
  return styleEl;
}

function ensureDistractionEl(): HTMLStyleElement {
  if (!distractionEl) {
    distractionEl = document.createElement("style");
    distractionEl.setAttribute("data-neuro-inclusive", "distraction");
    document.documentElement.appendChild(distractionEl);
  }
  return distractionEl;
}

function invalidateAnalysisCache(): void {
  cachedAnalysis = null;
  cachedAnalysisAt = 0;
}

function fallbackAnalysis(): PageAnalysis {
  const text = (document.body?.innerText || "").trim().slice(0, 12000);
  return {
    text,
    prioritizedText: text,
    difficultTerms: [],
    blocks: [],
    domStats: {
      images: document.images.length,
      iframes: document.querySelectorAll("iframe").length,
      videos: document.querySelectorAll("video").length,
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a").length,
      headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      popups: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
      sidebars: document.querySelectorAll("aside, [role='complementary']").length,
      denseTextBlocks: 0,
      textDensity: 0,
      difficultTerms: 0,
      maxDepthSample: 0,
    },
  };
}

function getPageAnalysis(force = false): PageAnalysis {
  if (!force && cachedAnalysis && Date.now() - cachedAnalysisAt < ANALYSIS_TTL_MS) {
    return cachedAnalysis;
  }

  try {
    const analysis = analyzePageDom(document);
    cachedAnalysis = analysis;
    cachedAnalysisAt = Date.now();
    if (analysis.difficultTerms.length > 0) {
      applyDifficultHighlights();
    } else {
      clearDifficultHighlights();
    }
    return analysis;
  } catch {
    const safeFallback = fallbackAnalysis();
    cachedAnalysis = safeFallback;
    cachedAnalysisAt = Date.now();
    clearDifficultHighlights();
    return safeFallback;
  }
}

function readingFlowPageKey(): string {
  return `${location.hostname}${location.pathname}`;
}

function ensureFlowProgressBar(): HTMLDivElement {
  let bar = document.getElementById(FLOW_PROGRESS_ID) as HTMLDivElement | null;
  if (!bar) {
    bar = document.createElement("div");
    bar.id = FLOW_PROGRESS_ID;
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Reading progress");
    bar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 4px;
      z-index: 2147483644;
      background: rgba(25, 39, 48, 0.16);
      pointer-events: none;
      display: none;
    `;

    const fill = document.createElement("div");
    fill.id = FLOW_PROGRESS_FILL_ID;
    fill.style.cssText = `
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #1f8a70, #61cbb0);
      transition: width 0.16s ease;
    `;
    bar.appendChild(fill);
    document.documentElement.appendChild(bar);
  }
  return bar;
}

function ensureFlowMarkerButton(): HTMLButtonElement {
  let marker = document.getElementById(FLOW_MARKER_ID) as HTMLButtonElement | null;
  if (!marker) {
    marker = document.createElement("button");
    marker.id = FLOW_MARKER_ID;
    marker.type = "button";
    marker.textContent = "Continue where you left";
    marker.style.cssText = `
      position: fixed;
      top: 10px;
      right: 12px;
      z-index: 2147483644;
      border: 1px solid #9ec9ba;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 600;
      color: #0f4f40;
      background: #e2f5ee;
      cursor: pointer;
      display: none;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
    `;
    marker.addEventListener("click", () => {
      if (!flowResumeParagraph || !flowResumeParagraph.isConnected) return;
      flowResumeParagraph.scrollIntoView({ behavior: "smooth", block: "center" });
      setQuickStatus("Returned to your last reading position.");
    });
    document.documentElement.appendChild(marker);
  }
  return marker;
}

function hideFlowUi(): void {
  const progress = document.getElementById(FLOW_PROGRESS_ID);
  if (progress) progress.style.display = "none";
  const marker = document.getElementById(FLOW_MARKER_ID);
  if (marker) marker.style.display = "none";
}

function collectFlowParagraphs(): HTMLElement[] {
  const main = estimateMainElement() ?? document.body;
  if (!main) return [];

  const nodes = Array.from(main.querySelectorAll("p, li, blockquote")) as HTMLElement[];
  const out: HTMLElement[] = [];

  for (const el of nodes) {
    if (el.closest("nav,aside,header,footer,[role='navigation'],[role='complementary']")) {
      continue;
    }
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < FLOW_MIN_CHARS) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    out.push(el);
  }

  return out;
}

async function saveFlowPosition(index: number): Promise<void> {
  if (index < 0 || index >= flowParagraphs.length) return;
  const now = Date.now();
  if (now - flowLastSavedAt < FLOW_SYNC_MS) return;
  flowLastSavedAt = now;

  try {
    await chrome.storage.local.set({
      [FLOW_STORAGE_KEY]: {
        key: readingFlowPageKey(),
        index,
        scrollY: window.scrollY,
        at: now,
      },
    });
  } catch {
    // Ignore storage failures.
  }
}

async function restoreFlowPosition(): Promise<void> {
  try {
    const raw = await chrome.storage.local.get(FLOW_STORAGE_KEY);
    const stored = raw[FLOW_STORAGE_KEY] as
      | { key?: string; index?: number; scrollY?: number; at?: number }
      | undefined;

    if (!stored || stored.key !== readingFlowPageKey()) return;
    if (typeof stored.index !== "number") return;

    const idx = Math.max(0, Math.min(flowParagraphs.length - 1, Math.round(stored.index)));
    const target = flowParagraphs[idx];
    if (!target) return;

    if (flowResumeParagraph && flowResumeParagraph !== target) {
      flowResumeParagraph.removeAttribute(FLOW_RESUME_ATTR);
    }

    flowResumeParagraph = target;
    target.setAttribute(FLOW_RESUME_ATTR, "1");

    const marker = ensureFlowMarkerButton();
    marker.style.display = "block";
  } catch {
    // Ignore storage failures.
  }
}

function clearFlowHighlights(): void {
  if (flowCurrentParagraph) {
    flowCurrentParagraph.removeAttribute(FLOW_CURRENT_ATTR);
    flowCurrentParagraph = null;
  }
  if (flowResumeParagraph) {
    flowResumeParagraph.removeAttribute(FLOW_RESUME_ATTR);
    flowResumeParagraph = null;
  }
}

function nearestFlowIndex(): number {
  if (!flowParagraphs.length) return -1;
  const anchorY = window.innerHeight * 0.35;

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < flowParagraphs.length; i++) {
    const rect = flowParagraphs[i].getBoundingClientRect();
    const center = rect.top + rect.height * 0.5;
    const dist = Math.abs(center - anchorY);
    if (dist < bestDistance) {
      bestDistance = dist;
      best = i;
    }
  }
  return best;
}

function updateFlowProgressVisual(index: number): void {
  const bar = ensureFlowProgressBar();
  bar.style.display = flowParagraphs.length > 0 ? "block" : "none";
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(Math.max(1, flowParagraphs.length)));
  bar.setAttribute("aria-valuenow", String(Math.max(0, index + 1)));

  const fill = document.getElementById(FLOW_PROGRESS_FILL_ID) as HTMLDivElement | null;
  if (!fill) return;
  const ratio = flowParagraphs.length ? (index + 1) / flowParagraphs.length : 0;
  fill.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(2)}%`;
}

function updateReadingFlowNow(): void {
  if (!readingFlowEnabled) return;
  if (!flowParagraphs.length) {
    hideFlowUi();
    return;
  }

  const index = nearestFlowIndex();
  if (index < 0) return;

  const next = flowParagraphs[index];
  if (flowCurrentParagraph !== next) {
    if (flowCurrentParagraph) {
      flowCurrentParagraph.removeAttribute(FLOW_CURRENT_ATTR);
    }
    flowCurrentParagraph = next;
    flowCurrentParagraph.setAttribute(FLOW_CURRENT_ATTR, "1");
  }

  updateFlowProgressVisual(index);
  void saveFlowPosition(index);
}

function scheduleReadingFlowUpdate(): void {
  const now = Date.now();
  const elapsed = now - flowLastUpdatedAt;

  if (elapsed < FLOW_UPDATE_MIN_MS) {
    if (flowUpdateTimer != null) return;
    flowUpdateTimer = window.setTimeout(() => {
      flowUpdateTimer = null;
      scheduleReadingFlowUpdate();
    }, FLOW_UPDATE_MIN_MS - elapsed);
    return;
  }

  if (flowUpdateRaf) return;
  flowUpdateRaf = window.requestAnimationFrame(() => {
    flowUpdateRaf = 0;
    flowLastUpdatedAt = Date.now();
    updateReadingFlowNow();
  });
}

function enableReadingFlowAssistant(): void {
  if (readingFlowEnabled) {
    scheduleReadingFlowUpdate();
    return;
  }

  readingFlowEnabled = true;
  flowParagraphs = collectFlowParagraphs();
  ensureFlowProgressBar();
  ensureFlowMarkerButton();
  void restoreFlowPosition();

  window.addEventListener("scroll", scheduleReadingFlowUpdate, true);
  window.addEventListener("resize", scheduleReadingFlowUpdate);
  scheduleReadingFlowUpdate();
}

function disableReadingFlowAssistant(): void {
  if (!readingFlowEnabled) return;

  readingFlowEnabled = false;
  window.removeEventListener("scroll", scheduleReadingFlowUpdate, true);
  window.removeEventListener("resize", scheduleReadingFlowUpdate);

  if (flowUpdateRaf) {
    window.cancelAnimationFrame(flowUpdateRaf);
    flowUpdateRaf = 0;
  }

  if (flowUpdateTimer != null) {
    window.clearTimeout(flowUpdateTimer);
    flowUpdateTimer = null;
  }

  clearFlowHighlights();
  flowParagraphs = [];
  hideFlowUi();
}

function cleanSummaryLines(summary: string): string[] {
  return summary
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 20)
    .slice(0, 3);
}

function summarySentenceList(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSmartTldr(sourceText: string, tldrText: string, bulletsText: string): string {
  const raw = sourceText.slice(0, MAX_TEXT_FOR_LOCAL).replace(/\s+/g, " ").trim();
  if (!raw) return "No content to summarize.";

  const sourceSentences = summarySentenceList(raw);
  const tldrSentences = summarySentenceList(tldrText);
  const bulletLines = cleanSummaryLines(bulletsText);

  const oneLine = tldrSentences[0] || sourceSentences[0] || raw.slice(0, 160);
  const bullets = (bulletLines.length ? bulletLines : sourceSentences).slice(0, 3);
  const takeaway = tldrSentences[1] || bullets[0] || oneLine;

  const bulletOutput = (bullets.length ? bullets : [oneLine])
    .slice(0, 3)
    .map((line) => `- ${line}`)
    .join("\n");

  return [
    `1-line summary: ${oneLine}`,
    "",
    "3 key bullet points:",
    bulletOutput || "- No key points available.",
    "",
    `Key takeaway: ${takeaway}`,
  ].join("\n");
}

function buildKeyPointsSummary(sourceText: string, bulletsText: string): string {
  const sourceSentences = summarySentenceList(sourceText);
  const bullets = (cleanSummaryLines(bulletsText).length
    ? cleanSummaryLines(bulletsText)
    : sourceSentences
  )
    .slice(0, 3)
    .map((line) => `- ${line}`)
    .join("\n");

  const takeaway = cleanSummaryLines(bulletsText)[0] || sourceSentences[0] || "No key points available.";

  return [
    "3 key bullet points:",
    bullets || "- No key points available.",
    "",
    `Key takeaway: ${takeaway}`,
  ].join("\n");
}

function buildStructuredLayoutText(analysis: PageAnalysis): string {
  const title =
    document.querySelector("h1")?.textContent?.trim() ||
    document.title ||
    "Untitled page";

  const ranked = (analysis.blocks || [])
    .filter((b) => b.category === "main-content" || b.category === "dense-text" || b.category === "other")
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_STRUCTURED_SECTIONS);

  const sections = ranked.map((block, idx) => {
    const sentences = block.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    const bullets = (sentences.length ? sentences : [block.text.slice(0, 180)])
      .map((s) => `- ${s}`)
      .join("\n");
    return `Section ${idx + 1}\n${bullets}`;
  });

  return [
    `Title: ${title}`,
    "",
    "Structured sections:",
    sections.join("\n\n") || "No main sections found.",
  ].join("\n");
}

function setImportanceHeatmapEnabled(enabled: boolean): void {
  importanceHeatmapEnabled = enabled;
  if (enabled) {
    void getPageAnalysis(true);
    const count = applyImportanceHeatmap(10);
    setQuickStatus(count > 0 ? `Highlighted ${count} important blocks.` : "No important blocks found.");
  } else {
    clearImportanceHeatmap();
    setQuickStatus("Importance highlights cleared.");
  }
}

function shouldIgnoreDistractionTarget(el: HTMLElement): boolean {
  if (el === document.body || el === document.documentElement) return true;
  if (el.id === OVERLAY_ID || el.id === FOCUS_ID || el.id === RULER_ID) return true;
  if (el.id === FLOW_PROGRESS_ID || el.id === FLOW_MARKER_ID) return true;
  if (el.id === QUICK_LAUNCHER_ID || el.id === QUICK_PANEL_ID) return true;
  if (el.id === TOOLTIP_BTN_ID || el.id === TOOLTIP_BUBBLE_ID) return true;
  if (el.matches("[data-neuro-inclusive]")) return true;
  if (el.closest(`[data-neuro-inclusive="theme"]`)) return true;
  return false;
}

function elementSignature(el: HTMLElement): string {
  const id = el.id || "";
  const cls = typeof el.className === "string" ? el.className : "";
  return `${id} ${cls}`.toLowerCase();
}

function visibleTextLength(el: HTMLElement): number {
  return (el.innerText || "").replace(/\s+/g, " ").trim().length;
}

function isLikelyPrimaryContent(el: HTMLElement): boolean {
  if (el.matches("main, article, [role='main']")) return true;
  if (el.querySelector("main, article, [role='main']")) return true;

  const textLen = visibleTextLength(el);
  const paragraphs = el.querySelectorAll("p").length;
  const headings = el.querySelectorAll("h1,h2,h3").length;

  if (textLen >= 2200) return true;
  if (paragraphs >= 4 && textLen >= 900) return true;
  if (paragraphs >= 2 && headings >= 2 && textLen >= 700) return true;
  return false;
}

function collectMainContentAnchors(): HTMLElement[] {
  const fromTraversal = getClassifiedElements(["main-content", "dense-text"]);
  const main = estimateMainElement();
  const semanticMain = Array.from(
    document.querySelectorAll("main, article, [role='main']")
  ) as HTMLElement[];

  const out = new Set<HTMLElement>();
  for (const el of [...fromTraversal, ...semanticMain, ...(main ? [main] : [])]) {
    if (el && el.isConnected) out.add(el);
  }

  const ranked = Array.from(out)
    .filter((el) => {
      if (isLikelyPrimaryContent(el)) return true;
      return visibleTextLength(el) >= 320;
    })
    .sort((a, b) => visibleTextLength(b) - visibleTextLength(a));

  const top = ranked.slice(0, 3);
  if (top.length) return top;
  return main && main.isConnected ? [main] : [];
}

function buildKeepSet(anchors: HTMLElement[]): Set<HTMLElement> {
  const keep = new Set<HTMLElement>();
  for (const anchor of anchors) {
    let cur: HTMLElement | null = anchor;
    let depth = 0;
    while (cur && depth < 14) {
      keep.add(cur);
      if (cur === document.body || cur === document.documentElement) break;
      cur = cur.parentElement as HTMLElement | null;
      depth++;
    }
  }
  return keep;
}

function containsAnyKeep(el: HTMLElement, keep: Set<HTMLElement>): boolean {
  for (const node of keep) {
    if (el === node || el.contains(node)) return true;
  }
  return false;
}

function classifyClutterAction(
  el: HTMLElement,
  aggressive: boolean
): "hide" | "dim" | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const area = rect.width * rect.height;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const tag = el.tagName;
  const signature = elementSignature(el);

  const links = el.querySelectorAll("a").length;
  const controls = el.querySelectorAll("button,input,select,textarea,[role='button']").length;
  const textLen = visibleTextLength(el);

  if (isLikelyPrimaryContent(el)) return null;

  const structural =
    tag === "NAV" ||
    tag === "ASIDE" ||
    tag === "HEADER" ||
    tag === "FOOTER" ||
    role === "navigation" ||
    role === "complementary" ||
    role === "banner" ||
    role === "contentinfo" ||
    CLUTTER_RE.test(signature);

  const touchesCenter =
    rect.left < window.innerWidth * 0.78 &&
    rect.right > window.innerWidth * 0.22 &&
    rect.top < window.innerHeight * 0.78 &&
    rect.bottom > window.innerHeight * 0.22;

  if (structural && (links >= 4 || controls >= 3 || area > viewportArea * 0.01)) {
    return aggressive ? "hide" : "dim";
  }

  if (touchesCenter && textLen < (aggressive ? 1200 : 900) && (links >= 10 || controls >= 6)) {
    return "hide";
  }

  if (links >= (aggressive ? 8 : 10) && textLen < 1400) {
    return aggressive ? "hide" : "dim";
  }

  if (area < viewportArea * 0.012 && textLen < 140 && (links > 1 || controls > 1)) {
    return "hide";
  }

  if (area > viewportArea * 0.24 && textLen < 900) {
    return "dim";
  }

  return null;
}

function storeStyleOnce(el: HTMLElement): void {
  if (!previousStyleByElement.has(el)) {
    previousStyleByElement.set(el, el.getAttribute("style"));
  }
}

function dimDistractionElement(el: HTMLElement): void {
  if (shouldIgnoreDistractionTarget(el) || el.closest("form")) return;
  if (isLikelyPrimaryContent(el)) return;
  storeStyleOnce(el);
  modifiedDistractionElements.add(el);
  el.style.setProperty("opacity", "0.28", "important");
  el.style.setProperty("filter", "blur(2px) grayscale(0.35)", "important");
  el.style.setProperty("pointer-events", "none", "important");
  el.setAttribute(DIMMED_BY_EXTENSION_ATTR, "1");
}

function hideDistractionElement(el: HTMLElement): void {
  if (shouldIgnoreDistractionTarget(el) || el.closest("form")) return;
  if (isLikelyPrimaryContent(el)) return;
  storeStyleOnce(el);
  modifiedDistractionElements.add(el);
  el.style.setProperty("display", "none", "important");
  el.setAttribute(HIDDEN_BY_EXTENSION_ATTR, "1");
}

function stopDistractionObserver(): void {
  distractionObserver?.disconnect();
  distractionObserver = null;
  if (distractionRefreshRaf) {
    window.cancelAnimationFrame(distractionRefreshRaf);
    distractionRefreshRaf = 0;
  }
  if (distractionDelayedTimer != null) {
    window.clearTimeout(distractionDelayedTimer);
    distractionDelayedTimer = null;
  }
  distractionLastAppliedAt = 0;
}

function scheduleDistractionRefresh(forceAnalysis: boolean): void {
  const run = () => {
    if (!document.documentElement.hasAttribute("data-neuro-inclusive-distract")) return;
    if (forceAnalysis) {
      invalidateAnalysisCache();
    }
    applyDistractionReductionNow(forceAnalysis);
    distractionLastAppliedAt = Date.now();
  };

  const now = Date.now();
  const elapsed = now - distractionLastAppliedAt;
  if (elapsed >= DISTRACTION_REFRESH_MIN_MS) {
    run();
    return;
  }

  if (distractionDelayedTimer != null) return;
  distractionDelayedTimer = window.setTimeout(() => {
    distractionDelayedTimer = null;
    run();
  }, DISTRACTION_REFRESH_MIN_MS - elapsed);
}

function restoreDistractionElements(): void {
  stopDistractionObserver();

  for (const el of modifiedDistractionElements) {
    const prev = previousStyleByElement.get(el);
    if (prev == null || prev === "") {
      el.removeAttribute("style");
    } else {
      el.setAttribute("style", prev);
    }
    el.removeAttribute(HIDDEN_BY_EXTENSION_ATTR);
    el.removeAttribute(DIMMED_BY_EXTENSION_ATTR);
  }
  modifiedDistractionElements.clear();

  document
    .querySelectorAll(`video[${PAUSED_BY_EXTENSION_ATTR}="1"],audio[${PAUSED_BY_EXTENSION_ATTR}="1"]`)
    .forEach((media) => {
      try {
        const playable = media as HTMLMediaElement;
        playable.removeAttribute(PAUSED_BY_EXTENSION_ATTR);
        void playable.play().catch(() => {
          /* ignore autoplay policy errors */
        });
      } catch {
        /* ignore */
      }
    });
}

function applyFloatingClutterHeuristic(aggressive: boolean): void {
  const selector = [
    '[style*="position:fixed"]',
    '[style*="position: fixed"]',
    '[style*="position:sticky"]',
    '[style*="position: sticky"]',
    '[class*="sticky"]',
    '[class*="floating"]',
    '[id*="sticky"]',
    '[id*="floating"]',
  ].join(",");

  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];

  for (const el of candidates) {
    if (shouldIgnoreDistractionTarget(el) || el.closest("form")) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const area = rect.width * rect.height;
    if (area < viewportArea * 0.015) continue;

    const touchesCenter =
      rect.left < window.innerWidth * 0.75 &&
      rect.right > window.innerWidth * 0.25 &&
      rect.top < window.innerHeight * 0.75 &&
      rect.bottom > window.innerHeight * 0.25;

    if (touchesCenter || area > viewportArea * 0.22) {
      aggressive ? hideDistractionElement(el) : dimDistractionElement(el);
    } else {
      const action = classifyClutterAction(el, aggressive);
      if (action === "hide") hideDistractionElement(el);
      else if (action === "dim") dimDistractionElement(el);
    }
  }
}

function applyMainContentIsolation(aggressive: boolean): void {
  if (!document.body) return;

  const anchors = collectMainContentAnchors();
  if (!anchors.length) return;

  const keep = buildKeepSet(anchors);
  const visited = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];

  for (const child of Array.from(document.body.children) as HTMLElement[]) {
    candidates.push(child);
  }

  for (const anchor of anchors) {
    let cur: HTMLElement | null = anchor;
    let depth = 0;
    while (cur?.parentElement && depth < 8) {
      const parent = cur.parentElement as HTMLElement;
      for (const sibling of Array.from(parent.children) as HTMLElement[]) {
        if (sibling !== cur) candidates.push(sibling);
      }
      if (parent === document.body) break;
      cur = parent;
      depth++;
    }
  }

  for (const el of candidates) {
    if (visited.has(el)) continue;
    visited.add(el);

    if (shouldIgnoreDistractionTarget(el) || el.closest("form")) continue;
    if (containsAnyKeep(el, keep)) continue;

    const action = classifyClutterAction(el, aggressive);
    if (action === "hide") hideDistractionElement(el);
    else if (action === "dim") dimDistractionElement(el);
  }
}

function applyDistractionReductionNow(forceAnalysis = false): void {
  void getPageAnalysis(forceAnalysis);
  const aggressive = currentSettings.focusMode || currentSettings.theme === "autism";

  const hideBySelectors = Array.from(
    document.querySelectorAll(DISTRACTION_HIDE_SELECTOR)
  ) as HTMLElement[];
  const dimBySelectors = Array.from(
    document.querySelectorAll(DISTRACTION_DIM_SELECTOR)
  ) as HTMLElement[];

  const hideByTraversal = getClassifiedElements(["popup"]);
  const dimByTraversal = getClassifiedElements(["ads", "sidebar", "navigation"]);

  for (const el of hideBySelectors) hideDistractionElement(el);
  for (const el of hideByTraversal) hideDistractionElement(el);
  for (const el of dimBySelectors) dimDistractionElement(el);
  for (const el of dimByTraversal) dimDistractionElement(el);
  applyFloatingClutterHeuristic(aggressive);
  applyMainContentIsolation(aggressive);

  document.querySelectorAll("video[autoplay],audio[autoplay]").forEach((media) => {
    try {
      const playable = media as HTMLMediaElement;
      if (!playable.paused) {
        playable.pause();
        playable.setAttribute(PAUSED_BY_EXTENSION_ATTR, "1");
      }
      dimDistractionElement(playable as HTMLElement);
    } catch {
      /* ignore */
    }
  });
}

function applyCalmModeMediaControl(theme: PageSettings["theme"]): void {
  if (theme !== "autism") return;

  document.querySelectorAll("video[autoplay],audio[autoplay]").forEach((media) => {
    try {
      const playable = media as HTMLMediaElement;
      if (!playable.paused) {
        playable.pause();
      }
      playable.setAttribute(PAUSED_BY_EXTENSION_ATTR, "1");
      playable.controls = true;
      playable.muted = true;
    } catch {
      // Ignore media errors.
    }
  });
}

function ensureDistractionObserver(): void {
  if (distractionObserver) return;

  distractionObserver = new MutationObserver(() => {
    if (!document.documentElement.hasAttribute("data-neuro-inclusive-distract")) {
      return;
    }
    if (distractionRefreshRaf) return;
    distractionRefreshRaf = window.requestAnimationFrame(() => {
      distractionRefreshRaf = 0;
      scheduleDistractionRefresh(false);
    });
  });

  distractionObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: false,
  });
}

function isNeutralSettings(settings: PageSettings): boolean {
  const eps = 0.001;
  return (
    settings.theme === "default" &&
    Math.abs(settings.fontSizePx - 16) <= eps &&
    Math.abs(settings.lineHeight - 1.5) <= eps &&
    Math.abs(settings.letterSpacingEm) <= eps &&
    !settings.readabilityMode &&
    !settings.distractionReduction &&
    !settings.focusMode &&
    !settings.bionicReading &&
    !settings.readingRuler
  );
}

function resetPageToOriginalView(): void {
  const html = document.documentElement;

  html.removeAttribute(BASE_ATTR);
  html.removeAttribute("data-neuro-inclusive-distract");
  html.classList.remove(
    "theme-default",
    "theme-dark",
    "theme-sepia",
    "theme-dyslexia",
    "theme-autism"
  );

  if (styleEl) styleEl.textContent = "";
  if (distractionEl) distractionEl.textContent = "";

  restoreDistractionElements();
  removeFocusOverlay();
  disableReadingFlowAssistant();

  document.querySelectorAll(".neuro-inclusive-main").forEach((n) => {
    n.classList.remove("neuro-inclusive-main");
  });

  applyReadingRuler(false);
  applyBionicReading(false);
  clearDifficultHighlights();
  if (importanceHeatmapEnabled) {
    setImportanceHeatmapEnabled(false);
  }
  showSimplifiedPanel("", false);
}

function applySettings(settings: PageSettings): void {
  currentSettings = { ...settings };
  syncQuickToggleState();

  if (isNeutralSettings(settings)) {
    invalidateAnalysisCache();
    resetPageToOriginalView();
    setQuickStatus("Restored site defaults.");
    return;
  }

  const html = document.documentElement;
  invalidateAnalysisCache();

  html.setAttribute(BASE_ATTR, "true");
  html.classList.remove(
    "theme-default",
    "theme-dark",
    "theme-sepia",
    "theme-dyslexia",
    "theme-autism"
  );
  html.classList.add(`theme-${settings.theme}`);

  const shouldReduceClutter =
    settings.distractionReduction || settings.focusMode || settings.theme === "autism";

  if (shouldReduceClutter) {
    html.setAttribute("data-neuro-inclusive-distract", "true");
    ensureDistractionEl().textContent = DISTRACTION_CSS;
    scheduleDistractionRefresh(true);
    ensureDistractionObserver();
  } else {
    html.removeAttribute("data-neuro-inclusive-distract");
    if (distractionEl) distractionEl.textContent = "";
    restoreDistractionElements();

  }

  applyCalmModeMediaControl(settings.theme);

  ensureStyleEl().textContent = buildThemeCss(
    settings.fontSizePx,
    settings.lineHeight,
    settings.letterSpacingEm,
    settings.theme,
    settings.readabilityMode
  );

  if (settings.focusMode) {
    showFocusOverlay();
  } else {
    removeFocusOverlay();
  }

  if (settings.focusMode || settings.readabilityMode) {
    enableReadingFlowAssistant();
  } else {
    disableReadingFlowAssistant();
  }

  document.querySelectorAll(".neuro-inclusive-main").forEach((n) => {
    n.classList.remove("neuro-inclusive-main");
  });
  if (settings.readabilityMode) {
    const m = estimateMainElement();
    m?.classList.add("neuro-inclusive-main");
  }

  applyReadingRuler(settings.readingRuler);
  applyBionicReading(settings.bionicReading);

  if (settings.theme === "autism") {
    if (!importanceHeatmapEnabled) {
      setImportanceHeatmapEnabled(true);
    }
  } else if (importanceHeatmapEnabled) {
    setImportanceHeatmapEnabled(false);
  }

  if (settings.readabilityMode || settings.distractionReduction) {
    void getPageAnalysis(true);
  }
}

// BIONIC READING
let bionicApplied = false;
function applyBionicReading(enabled: boolean) {
  if (!document.body) return;
  if (enabled && !bionicApplied) {
    bionicApplied = true;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (parent && ["SCRIPT", "STYLE", "NOSCRIPT", "B", "STRONG"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent!);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode as Text);
    }
    for (const node of nodes) {
      const text = node.nodeValue || "";
      const words = text.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const w of words) {
        if (!w.trim() || w.length < 2) {
          frag.appendChild(document.createTextNode(w));
        } else {
          const mid = Math.ceil(w.length / 2);
          const b = document.createElement("b");
          b.className = "neuro-bionic";
          b.style.fontWeight = "bold";
          b.textContent = w.slice(0, mid);
          frag.appendChild(b);
          frag.appendChild(document.createTextNode(w.slice(mid)));
        }
      }
      node.replaceWith(frag);
    }
  } else if (!enabled && bionicApplied) {
    bionicApplied = false;
    document.querySelectorAll(".neuro-bionic").forEach(b => {
      const txt = b.textContent || "";
      const next = b.nextSibling;
      if (next?.nodeType === Node.TEXT_NODE) {
        next.nodeValue = txt + (next.nodeValue || "");
        b.remove();
      } else {
        b.replaceWith(document.createTextNode(txt));
      }
    });
  }
}

// READING RULER
const RULER_ID = "neuro-inclusive-ruler";
let rulerListener: ((e: MouseEvent) => void) | null = null;
function ensureRuler(): HTMLDivElement {
  let el = document.getElementById(RULER_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = RULER_ID;
    el.setAttribute("role", "presentation");
    el.style.cssText = `
      position: fixed;
      left: 0;
      right: 0;
      height: 4px;
      background: rgba(255, 204, 0, 0.45);
      z-index: 2147483647;
      pointer-events: none;
      display: none;
      transition: top 0.05s linear;
    `;
    document.documentElement.appendChild(el);
  }
  return el;
}
function applyReadingRuler(enabled: boolean) {
  const ruler = ensureRuler();
  if (enabled) {
    ruler.style.display = "block";
    if (!rulerListener) {
      rulerListener = (e: MouseEvent) => {
        ruler.style.top = `${e.clientY + 12}px`;
      };
      document.addEventListener("mousemove", rulerListener);
    }
  } else {
    ruler.style.display = "none";
    if (rulerListener) {
      document.removeEventListener("mousemove", rulerListener);
      rulerListener = null;
    }
  }
}

function ensureFocusOverlay(): HTMLDivElement {
  let hole = document.getElementById(FOCUS_ID) as HTMLDivElement | null;
  if (!hole) {
    hole = document.createElement("div");
    hole.id = FOCUS_ID;
    hole.setAttribute("role", "presentation");
    hole.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483640;
      pointer-events: none;
      display: none;
      background: radial-gradient(circle 300px at 50% 50%, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 220px, rgba(8,12,16,0.42) 300px);
      will-change: background;
    `;
    document.documentElement.appendChild(hole);
  }
  return hole;
}

function paintFocusOverlay(): void {
  const safeX = Math.max(24, Math.min(window.innerWidth - 24, focusPointerX));
  const safeY = Math.max(24, Math.min(window.innerHeight - 24, focusPointerY));
  const hole = ensureFocusOverlay();
  const inner = Math.max(24, FOCUS_SPOTLIGHT_RADIUS - FOCUS_EDGE_SOFTNESS);
  const outer = FOCUS_SPOTLIGHT_RADIUS + FOCUS_EDGE_SOFTNESS;
  hole.style.background = `radial-gradient(circle ${outer}px at ${safeX}px ${safeY}px, rgba(0,0,0,0) 0px, rgba(0,0,0,0) ${inner}px, rgba(8,12,16,${FOCUS_DIM_ALPHA}) ${outer}px)`;
}

function scheduleFocusOverlayPaint(): void {
  if (focusRaf) return;
  focusRaf = window.requestAnimationFrame(() => {
    focusRaf = 0;
    paintFocusOverlay();
  });
}

function onFocusPointerMove(e: MouseEvent): void {
  if (Math.abs(e.clientX - focusPointerX) < 2 && Math.abs(e.clientY - focusPointerY) < 2) {
    return;
  }
  focusPointerX = e.clientX;
  focusPointerY = e.clientY;
  scheduleFocusOverlayPaint();
}

function onFocusTouchMove(e: TouchEvent): void {
  const t = e.touches[0];
  if (!t) return;
  if (Math.abs(t.clientX - focusPointerX) < 2 && Math.abs(t.clientY - focusPointerY) < 2) {
    return;
  }
  focusPointerX = t.clientX;
  focusPointerY = t.clientY;
  scheduleFocusOverlayPaint();
}

function onFocusViewportChange() {
  scheduleFocusOverlayPaint();
}

function attachFocusListeners(): void {
  if (focusListenersAttached) return;
  focusListenersAttached = true;
  window.addEventListener("mousemove", onFocusPointerMove, true);
  window.addEventListener("touchmove", onFocusTouchMove, { passive: true });
  window.addEventListener("scroll", onFocusViewportChange, true);
  window.addEventListener("resize", onFocusViewportChange);
}

function detachFocusListeners(): void {
  if (!focusListenersAttached) return;
  focusListenersAttached = false;
  window.removeEventListener("mousemove", onFocusPointerMove, true);
  window.removeEventListener("touchmove", onFocusTouchMove);
  window.removeEventListener("scroll", onFocusViewportChange, true);
  window.removeEventListener("resize", onFocusViewportChange);
  if (focusRaf) {
    window.cancelAnimationFrame(focusRaf);
    focusRaf = 0;
  }
}

function removeFocusOverlay(): void {
  detachFocusListeners();
  document.getElementById(FOCUS_ID)?.remove();
}

function showFocusOverlay(): void {
  const main = estimateMainElement();
  if (main) {
    const rect = main.getBoundingClientRect();
    const centerX = rect.left + rect.width * 0.5;
    const preferredY = Math.max(rect.top + Math.min(180, rect.height * 0.25), window.innerHeight * 0.45);
    focusPointerX = Math.max(24, Math.min(window.innerWidth - 24, centerX));
    focusPointerY = Math.max(24, Math.min(window.innerHeight - 24, preferredY));
  } else {
    focusPointerX = Math.round(window.innerWidth * 0.5);
    focusPointerY = Math.round(window.innerHeight * 0.5);
  }
  const hole = ensureFocusOverlay();
  hole.style.display = "block";
  scheduleFocusOverlayPaint();
  attachFocusListeners();
}

function ensureSimplifiedPanel(): HTMLDivElement {
  let el = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Simplified text");
    el.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: min(420px, 92vw);
      max-height: 55vh;
      overflow: auto;
      z-index: 2147483646;
      padding: 10px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25);
      font-family: system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      background: #1e1e1e;
      color: #f0f0f0;
      border: 1px solid rgba(255,255,255,0.12);
    `;

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;";
    const title = document.createElement("strong");
    title.textContent = "Neuro output";
    title.style.cssText = "font-size:12px;color:#d6e4ec;";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.style.cssText =
      "border:1px solid rgba(255,255,255,0.35);background:transparent;color:#f0f0f0;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;";
    closeBtn.addEventListener("click", () => {
      if (!el) return;
      el.style.display = "none";
    });
    header.append(title, closeBtn);

    simplifiedPanelTextEl = document.createElement("pre");
    simplifiedPanelTextEl.style.cssText = `
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.55;
      font-family: inherit;
      color: inherit;
    `;

    el.append(header, simplifiedPanelTextEl);
    document.documentElement.appendChild(el);
  }

  if (!simplifiedPanelTextEl) {
    simplifiedPanelTextEl = el.querySelector("pre") as HTMLPreElement | null;
  }

  return el;
}

function normalizePanelText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/```(?:\w+)?\n?/g, "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isQuickPanelOpen(): boolean {
  return Boolean(quickPanelEl && quickPanelEl.style.display === "block");
}

function showSimplifiedPanel(text: string, visible: boolean): void {
  if (visible && isQuickPanelOpen()) {
    showQuickResult(text);
    const existing = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
    if (existing) {
      existing.style.display = "none";
    }
    return;
  }

  if (!visible) {
    const existing = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
    if (existing) {
      existing.style.display = "none";
    }
    return;
  }

  const el = ensureSimplifiedPanel();
  const normalized = normalizePanelText(text);
  if (simplifiedPanelTextEl) {
    simplifiedPanelTextEl.textContent = normalized;
  }
  el.style.display = "block";
}

function setQuickStatus(text: string): void {
  if (!quickStatusEl) return;
  quickStatusEl.textContent = text;
}

function ensureQuickResultElements(): void {
  if (!quickPanelEl) return;

  if (!quickResultWrapEl) {
    quickResultWrapEl = quickPanelEl.querySelector(
      '[data-neuro-result-wrap="true"]'
    ) as HTMLDivElement | null;
  }
  if (!quickResultTextEl) {
    quickResultTextEl = quickPanelEl.querySelector(
      '[data-neuro-result-text="true"]'
    ) as HTMLPreElement | null;
  }
  if (quickResultWrapEl && quickResultTextEl) {
    return;
  }

  quickResultWrapEl = document.createElement("div");
  quickResultWrapEl.setAttribute("data-neuro-result-wrap", "true");
  quickResultWrapEl.style.cssText =
    "display:none;margin-top:8px;border:1px solid #c9d9e5;border-radius:8px;background:#ffffff;";

  const resultHeader = document.createElement("div");
  resultHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid #dce7ef;font-size:11px;font-weight:700;color:#355062;";
  const resultTitle = document.createElement("span");
  resultTitle.textContent = "Result";
  const resultCloseBtn = document.createElement("button");
  resultCloseBtn.type = "button";
  resultCloseBtn.textContent = "Close";
  resultCloseBtn.style.cssText =
    "border:1px solid #bfd0de;border-radius:7px;background:#ffffff;color:#1f2f3a;padding:3px 7px;font-size:10px;cursor:pointer;";
  resultCloseBtn.addEventListener("click", () => {
    hideQuickResult();
  });
  resultHeader.append(resultTitle, resultCloseBtn);

  quickResultTextEl = document.createElement("pre");
  quickResultTextEl.setAttribute("data-neuro-result-text", "true");
  quickResultTextEl.style.cssText = `
    margin: 0;
    padding: 8px;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.45;
    color: #1f2f3a;
    background: #ffffff;
    border-radius: 0 0 8px 8px;
  `;

  quickResultWrapEl.append(resultHeader, quickResultTextEl);
  quickPanelEl.appendChild(quickResultWrapEl);
}

function showQuickResult(text: string): void {
  if (!quickPanelEl) {
    ensureQuickPanel();
  }
  ensureQuickResultElements();
  const normalized = normalizePanelText(text);
  if (quickResultTextEl) {
    quickResultTextEl.textContent = normalized;
  }
  if (quickResultWrapEl) {
    quickResultWrapEl.style.display = "block";
  }
}

function hideQuickResult(): void {
  ensureQuickResultElements();
  if (quickResultTextEl) {
    quickResultTextEl.textContent = "";
  }
  if (quickResultWrapEl) {
    quickResultWrapEl.style.display = "none";
  }
}

function registerQuickActionButton(btn: HTMLButtonElement): HTMLButtonElement {
  quickActionButtons.add(btn);
  return btn;
}

function setQuickMenuBusy(busy: boolean): void {
  quickMenuBusy = busy;
  if (quickPanelEl) {
    quickPanelEl.setAttribute("aria-busy", busy ? "true" : "false");
  }
  for (const btn of quickActionButtons) {
    btn.disabled = busy;
  }
}

function syncQuickToggleState(): void {
  if (quickReadabilityInput) quickReadabilityInput.checked = currentSettings.readabilityMode;
  if (quickDistractionInput) quickDistractionInput.checked = currentSettings.distractionReduction;
  if (quickFocusInput) quickFocusInput.checked = currentSettings.focusMode;
  if (quickImportanceInput) quickImportanceInput.checked = importanceHeatmapEnabled;
}

function setQuickPanelOpen(open: boolean): void {
  if (!quickPanelEl || !quickLauncherEl) return;
  quickPanelEl.style.display = open ? "block" : "none";
  quickLauncherEl.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    showSimplifiedPanel("", false);
  }
  if (!open) {
    setQuickMenuBusy(false);
  }
}

function ensureQuickDismissHandlers(): void {
  if (quickDismissHandlersAttached) return;
  quickDismissHandlersAttached = true;

  document.addEventListener("mousedown", (event) => {
    if (!quickPanelEl || quickPanelEl.style.display !== "block") return;
    const target = event.target as Node | null;
    if (!target) return;
    if (quickPanelEl.contains(target)) return;
    if (quickLauncherEl && quickLauncherEl.contains(target)) return;
    setQuickPanelOpen(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!quickPanelEl || quickPanelEl.style.display !== "block") return;
    setQuickPanelOpen(false);
  });
}

function ensureQuickLauncher(): HTMLButtonElement {
  if (quickLauncherEl) return quickLauncherEl;

  quickLauncherEl = document.createElement("button");
  quickLauncherEl.id = QUICK_LAUNCHER_ID;
  quickLauncherEl.type = "button";
  quickLauncherEl.setAttribute("aria-label", "Open Neuro menu");
  quickLauncherEl.setAttribute("aria-expanded", "false");
  quickLauncherEl.textContent = "Neuro";
  quickLauncherEl.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483645;
    border: 0;
    border-radius: 999px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    color: #ffffff;
    background: linear-gradient(135deg, #1f8a70, #15604f);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
  `;
  quickLauncherEl.addEventListener("click", () => {
    if (!quickPanelEl) {
      ensureQuickPanel();
    }
    const open = quickPanelEl?.style.display === "block";
    setQuickPanelOpen(!open);
  });

  document.documentElement.appendChild(quickLauncherEl);
  return quickLauncherEl;
}

async function simplifyFromQuickMenu(): Promise<void> {
  if (quickMenuBusy) return;
  setQuickMenuBusy(true);
  setQuickStatus("Simplifying...");
  try {
    const analysis = getPageAnalysis(true);
    const sourceText = (analysis.prioritizedText || analysis.text).trim();
    if (!sourceText) {
      setQuickStatus("No visible text found on this page.");
      return;
    }

    const needsAi =
      sourceText.length > 1400 ||
      analysis.difficultTerms.length >= 4 ||
      (analysis.domStats.denseTextBlocks ?? 0) >= 2;

    const aiInput = sourceText.slice(0, MAX_TEXT_FOR_REMOTE);
    let simplified = "";
    let statusSuffix = "";

    if (needsAi) {
      const res = await bgRequest({
        type: "API_SIMPLIFY",
        text: aiInput,
        apiBase: currentApiBase,
      });
      if (res.ok && typeof res.simplified === "string" && res.simplified.trim()) {
        simplified = res.simplified.trim();
        statusSuffix = "AI";
      } else {
        simplified = localSimplifyFallback(sourceText);
        statusSuffix = "fallback";
      }
    } else {
      simplified = localSimplifyFallback(sourceText);
      statusSuffix = "local";
    }

    showQuickResult(simplified);
    showSimplifiedPanel("", false);
    setQuickStatus(`Simplified (${statusSuffix}).`);
  } finally {
    setQuickMenuBusy(false);
  }
}

async function summarizeFromQuickMenu(mode: "tldr" | "bullets"): Promise<void> {
  if (quickMenuBusy) return;
  setQuickMenuBusy(true);
  setQuickStatus(mode === "tldr" ? "Creating TL;DR..." : "Creating key points...");
  try {
    const analysis = getPageAnalysis(true);
    const sourceText = (analysis.prioritizedText || analysis.text).trim();
    if (!sourceText) {
      setQuickStatus("No visible text found on this page.");
      return;
    }

    if (mode === "tldr") {
      const [tldrRes, bulletsRes] = await Promise.all([
        bgRequest({
          type: "API_SUMMARIZE",
          text: sourceText.slice(0, MAX_TEXT_FOR_REMOTE),
          mode: "tldr",
          apiBase: currentApiBase,
        }),
        bgRequest({
          type: "API_SUMMARIZE",
          text: sourceText.slice(0, MAX_TEXT_FOR_REMOTE),
          mode: "bullets",
          apiBase: currentApiBase,
        }),
      ]);

      const tldrText =
        tldrRes.ok && typeof tldrRes.summary === "string" && tldrRes.summary.trim()
          ? tldrRes.summary.trim()
          : localSummarizeFallback(sourceText, "tldr");

      const bulletText =
        bulletsRes.ok && typeof bulletsRes.summary === "string" && bulletsRes.summary.trim()
          ? bulletsRes.summary.trim()
          : localSummarizeFallback(sourceText, "bullets");

      const smart = buildSmartTldr(sourceText, tldrText, bulletText);
      showQuickResult(smart);
      showSimplifiedPanel("", false);
      setQuickStatus(tldrRes.ok || bulletsRes.ok ? "Smart TL;DR ready." : "Smart TL;DR fallback used.");
      return;
    }

    const res = await bgRequest({
      type: "API_SUMMARIZE",
      text: sourceText.slice(0, MAX_TEXT_FOR_REMOTE),
      mode: "bullets",
      apiBase: currentApiBase,
    });

    const summary =
      res.ok && typeof res.summary === "string" && res.summary.trim()
        ? res.summary.trim()
        : localSummarizeFallback(sourceText, "bullets");

    showQuickResult(buildKeyPointsSummary(sourceText, summary));
    showSimplifiedPanel("", false);
    setQuickStatus(res.ok ? "Key points ready." : "Key points fallback used.");
  } finally {
    setQuickMenuBusy(false);
  }
}

function showStructuredLayoutFromQuickMenu(): void {
  if (quickMenuBusy) return;
  const analysis = getPageAnalysis(true);
  const structured = buildStructuredLayoutText(analysis);
  showQuickResult(structured);
  showSimplifiedPanel("", false);
  setQuickStatus("Structured layout ready.");
}

function continueReadingFromMarker(): void {
  if (!flowResumeParagraph || !flowResumeParagraph.isConnected) {
    setQuickStatus("No saved reading position yet.");
    return;
  }
  flowResumeParagraph.scrollIntoView({ behavior: "smooth", block: "center" });
  setQuickStatus("Continued from your last reading point.");
}

function ensureQuickPanel(): HTMLDivElement {
  if (quickPanelEl) return quickPanelEl;

  const panel = document.createElement("div");
  panel.id = QUICK_PANEL_ID;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Neuro menu");
  panel.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 64px;
    width: min(320px, 88vw);
    z-index: 2147483645;
    border-radius: 12px;
    background: #f7fbff;
    color: #1f2f3a;
    border: 1px solid #c9d9e5;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24);
    padding: 10px;
    display: none;
    font-family: "Segoe UI", Arial, sans-serif;
  `;

  const titleRow = document.createElement("div");
  titleRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;";
  const title = document.createElement("strong");
  title.textContent = "Neuro menu";
  title.style.cssText = "font-size:13px;";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = "border:1px solid #bfd0de;border-radius:8px;background:#ffffff;color:#1f2f3a;padding:5px 8px;font-size:11px;cursor:pointer;";
  closeBtn.addEventListener("click", () => setQuickPanelOpen(false));
  titleRow.append(title, closeBtn);

  const makeToggle = (
    labelText: string,
    onChange: (checked: boolean) => void
  ): HTMLInputElement => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => onChange(input.checked));
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(input, span);
    panel.appendChild(label);
    return input;
  };

  const togglesTitle = document.createElement("div");
  togglesTitle.textContent = "Quick settings";
  togglesTitle.style.cssText = "font-size:11px;font-weight:600;color:#547087;margin:6px 0 2px;";

  panel.appendChild(titleRow);
  panel.appendChild(togglesTitle);

  quickReadabilityInput = makeToggle("Readability mode", (checked) => {
    currentSettings = { ...currentSettings, readabilityMode: checked };
    applySettings(currentSettings);
    setQuickStatus("Readability updated.");
  });

  quickDistractionInput = makeToggle("Reduce distractions", (checked) => {
    currentSettings = { ...currentSettings, distractionReduction: checked };
    applySettings(currentSettings);
    setQuickStatus("Distraction setting updated.");
  });

  quickFocusInput = makeToggle("Cursor spotlight (dim rest)", (checked) => {
    currentSettings = { ...currentSettings, focusMode: checked };
    applySettings(currentSettings);
    setQuickStatus("Cursor spotlight updated.");
  });

  quickImportanceInput = makeToggle("Importance heatmap", (checked) => {
    setImportanceHeatmapEnabled(checked);
    syncQuickToggleState();
  });

  const actions = document.createElement("div");
  actions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;";

  const simplifyBtn = registerQuickActionButton(document.createElement("button"));
  simplifyBtn.type = "button";
  simplifyBtn.textContent = "Simplify";
  simplifyBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#1f8a70;color:#ffffff;font-size:12px;cursor:pointer;";
  simplifyBtn.addEventListener("click", () => {
    void simplifyFromQuickMenu();
  });

  const tldrBtn = registerQuickActionButton(document.createElement("button"));
  tldrBtn.type = "button";
  tldrBtn.textContent = "TL;DR";
  tldrBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#dbe9f3;color:#1f2f3a;font-size:12px;cursor:pointer;";
  tldrBtn.addEventListener("click", () => {
    void summarizeFromQuickMenu("tldr");
  });

  const bulletsBtn = registerQuickActionButton(document.createElement("button"));
  bulletsBtn.type = "button";
  bulletsBtn.textContent = "Key points";
  bulletsBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#dbe9f3;color:#1f2f3a;font-size:12px;cursor:pointer;";
  bulletsBtn.addEventListener("click", () => {
    void summarizeFromQuickMenu("bullets");
  });

  const structuredBtn = registerQuickActionButton(document.createElement("button"));
  structuredBtn.type = "button";
  structuredBtn.textContent = "Structured view";
  structuredBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#e4eef7;color:#1f2f3a;font-size:12px;cursor:pointer;";
  structuredBtn.addEventListener("click", () => {
    showStructuredLayoutFromQuickMenu();
  });

  const continueBtn = registerQuickActionButton(document.createElement("button"));
  continueBtn.type = "button";
  continueBtn.textContent = "Continue reading";
  continueBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#e4eef7;color:#1f2f3a;font-size:12px;cursor:pointer;";
  continueBtn.addEventListener("click", () => {
    continueReadingFromMarker();
  });

  const hideTextBtn = registerQuickActionButton(document.createElement("button"));
  hideTextBtn.type = "button";
  hideTextBtn.textContent = "Hide text panel";
  hideTextBtn.style.cssText = "border:0;border-radius:8px;padding:7px 8px;background:#ffffff;color:#3a4f60;font-size:12px;cursor:pointer;border:1px solid #c9d9e5;";
  hideTextBtn.addEventListener("click", () => {
    showSimplifiedPanel("", false);
    hideQuickResult();
    setQuickStatus("Text panel hidden.");
  });

  actions.append(
    simplifyBtn,
    tldrBtn,
    bulletsBtn,
    structuredBtn,
    continueBtn,
    hideTextBtn
  );
  panel.appendChild(actions);

  quickStatusEl = document.createElement("div");
  quickStatusEl.style.cssText = "margin-top:8px;padding:6px 8px;border-radius:8px;background:#ecf4fa;color:#375164;font-size:11px;line-height:1.3;";
  quickStatusEl.textContent = "Ready.";
  panel.appendChild(quickStatusEl);

  quickResultWrapEl = document.createElement("div");
  quickResultWrapEl.setAttribute("data-neuro-result-wrap", "true");
  quickResultWrapEl.style.cssText =
    "display:none;margin-top:8px;border:1px solid #c9d9e5;border-radius:8px;background:#ffffff;";

  const resultHeader = document.createElement("div");
  resultHeader.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid #dce7ef;font-size:11px;font-weight:700;color:#355062;";
  const resultTitle = document.createElement("span");
  resultTitle.textContent = "Result";
  const resultCloseBtn = document.createElement("button");
  resultCloseBtn.type = "button";
  resultCloseBtn.textContent = "Close";
  resultCloseBtn.style.cssText =
    "border:1px solid #bfd0de;border-radius:7px;background:#ffffff;color:#1f2f3a;padding:3px 7px;font-size:10px;cursor:pointer;";
  resultCloseBtn.addEventListener("click", () => {
    hideQuickResult();
  });
  resultHeader.append(resultTitle, resultCloseBtn);

  quickResultTextEl = document.createElement("pre");
  quickResultTextEl.setAttribute("data-neuro-result-text", "true");
  quickResultTextEl.style.cssText = `
    margin: 0;
    padding: 8px;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.45;
    color: #1f2f3a;
    background: #ffffff;
    border-radius: 0 0 8px 8px;
  `;

  quickResultWrapEl.append(resultHeader, quickResultTextEl);
  panel.appendChild(quickResultWrapEl);

  document.documentElement.appendChild(panel);
  quickPanelEl = panel;
  syncQuickToggleState();
  return panel;
}

function ensureQuickMenu(): void {
  ensureQuickLauncher();
  ensureQuickPanel();
  ensureQuickDismissHandlers();
}

// HOVER-TO-EXPLAIN TOOLTIP
const TOOLTIP_BTN_ID = "neuro-explain-btn";
const TOOLTIP_BUBBLE_ID = "neuro-explain-bubble";

let currentApiBase = "http://localhost:3000";
let explainRequestId = 0;
let explainHideTimer: number | null = null;

function ensureExplainBtn() {
  let el = document.getElementById(TOOLTIP_BTN_ID) as HTMLButtonElement | null;
  if (!el) {
    el = document.createElement("button");
    el.id = TOOLTIP_BTN_ID;
    el.textContent = "🧠 Explain";
    el.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      background: #8b5cf6;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      display: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;
    
    el.addEventListener("mousedown", (e) => e.preventDefault()); // Prevent losing selection
    el.addEventListener("click", async () => {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) return;
      const text = sel.toString().trim();
      const requestId = ++explainRequestId;
      el!.textContent = "🤔 Thinking...";
      el!.disabled = true;
      
      try {
        const res = (await chrome.runtime.sendMessage({
          type: "API_DEFINE",
          text,
          apiBase: currentApiBase,
        })) as BackgroundResponse;
        if (requestId !== explainRequestId) return;

        if (res.ok && res.definition?.trim()) {
          showExplainBubble(res.definition, el!.style.left, el!.style.top);
        } else {
          const hint =
            !res.ok && res.error
              ? `${localDefineFallback(text)} (${res.error})`
              : localDefineFallback(text);
          showExplainBubble(hint, el!.style.left, el!.style.top);
        }
      } catch (e) {
        if (requestId !== explainRequestId) return;
        const err = e instanceof Error ? e.message : "Network error";
        showExplainBubble(
          `${localDefineFallback(text)} (${err})`,
          el!.style.left,
          el!.style.top
        );
      } finally {
        if (requestId === explainRequestId) {
          el!.style.display = "none";
          el!.textContent = "🧠 Explain";
          el!.disabled = false;
        }
      }
    });
    
    document.documentElement.appendChild(el);
  }
  return el;
}

function showExplainBubble(text: string, left: string, top: string) {
  let el = document.getElementById(TOOLTIP_BUBBLE_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = TOOLTIP_BUBBLE_ID;
    el.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      background: #1e1e1e;
      color: #f0f0f0;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
      max-width: 320px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      pointer-events: none;
    `;
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
  el.style.left = left;
  el.style.top = `calc(${top} + 30px)`;
  el.style.display = "block";

  if (explainHideTimer) {
    window.clearTimeout(explainHideTimer);
  }
  explainHideTimer = window.setTimeout(() => {
    el!.style.display = "none";
    explainHideTimer = null;
  }, 5000);
}

document.addEventListener("mouseup", () => {
  const btn = ensureExplainBtn();
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      btn.style.display = "none";
      return;
    }

    const selected = sel.toString().trim();
    if (selected.length === 0 || selected.length > MAX_EXPLAIN_SELECTION) {
      btn.style.display = "none";
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.right)) {
      btn.style.display = "none";
      return;
    }

    btn.style.left = `${rect.right + window.scrollX + 5}px`;
    btn.style.top = `${rect.top + window.scrollY - 20}px`;
    btn.style.display = "block";
  } catch {
    btn.style.display = "none";
  }
});

function collectDomStats(): DomStats {
  try {
    return getPageAnalysis().domStats;
  } catch {
    return {
      images: 0,
      iframes: 0,
      videos: 0,
      buttons: 0,
      links: 0,
      headings: 0,
      popups: 0,
      sidebars: 0,
      denseTextBlocks: 0,
      textDensity: 0,
      difficultTerms: 0,
      maxDepthSample: 0,
    };
  }
}

try {
  ensureQuickMenu();
} catch (e) {
  console.warn("[Neuro-Inclusive] quick menu init failed:", normalizeError(e));
}

chrome.runtime.onMessage.addListener(
  (
    msg: ContentRequest,
    _sender,
    sendResponse: (r: ContentResponse) => void
  ) => {
    try {
      if (msg.type === "GET_PAGE_TEXT") {
        const analysis = getPageAnalysis(true);
        const text = analysis.prioritizedText || analysis.text;
        return sendResponse({ ok: true, text });
      }
      if (msg.type === "GET_DOM_STATS") {
        return sendResponse({ ok: true, domStats: collectDomStats() });
      }
      if (msg.type === "GET_PAGE_ANALYSIS") {
        const analysis = getPageAnalysis(true);
        return sendResponse({ ok: true, analysis });
      }
      if (msg.type === "APPLY_SETTINGS") {
        currentApiBase = (msg.apiBase?.trim() || "http://localhost:3000").replace(/\/$/, "");
        applySettings(msg.settings);
        return sendResponse({ ok: true });
      }
      if (msg.type === "SHOW_SIMPLIFIED") {
        showSimplifiedPanel(msg.simplified, msg.show);
        return sendResponse({ ok: true });
      }
      if (msg.type === "SET_FOCUS_MODE") {
        if (msg.on) showFocusOverlay();
        else removeFocusOverlay();
        return sendResponse({ ok: true });
      }
      if (msg.type === "PING") {
        return sendResponse({ ok: true });
      }
    } catch (e) {
      return sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : "Content error",
      });
    }
    return sendResponse({ ok: false, error: "Unknown message" });
  }
);

try {
  document.documentElement.setAttribute(READY_ATTR, "1");
} catch {
  // Ignore readiness marker failures on unusual documents.
}
}

const docEl = document.documentElement;
const hasGuard = docEl?.getAttribute(GUARD_ATTR) === "1";
const isReady = docEl?.getAttribute(READY_ATTR) === "1";

if (docEl && (!hasGuard || !isReady)) {
  if (hasGuard && !isReady) {
    docEl.removeAttribute(GUARD_ATTR);
  }

  docEl.setAttribute(GUARD_ATTR, "1");
  try {
    initContentScript();
  } catch (e) {
    console.error("[Neuro-Inclusive] content init failed:", e);
    docEl.removeAttribute(GUARD_ATTR);
    docEl.removeAttribute(READY_ATTR);
  }
}
