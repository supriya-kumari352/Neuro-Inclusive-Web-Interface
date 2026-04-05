import type {
  AnalysisBlock,
  DomStats,
  NodeCategory,
  PageAnalysis,
} from "../shared/messages.js";
import {
  createDefaultComplexWordTrie,
  tokenizeText,
} from "../shared/complexWordTrie.js";
import { PriorityQueue } from "../shared/priorityQueue.js";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "SVG",
  "TEMPLATE",
  "CODE",
  "PRE",
  "CANVAS",
]);

const SENSITIVE_SELECTOR =
  "input, textarea, select, [contenteditable='true'], [contenteditable=''], [type='password']";

const MAX_TEXT_CHARS = 12000;
const MAX_TRAVERSAL_NODES = 5000;
const MAX_BLOCKS = 260;

const MAIN_RE = /\b(main|article|content|post|story|read|document)\b/i;
const NAV_RE = /\b(nav|menu|breadcrumb|toolbar|masthead|tabs?)\b/i;
const AD_RE = /\b(ad|ads|advert|sponsor|sponsored|promo|banner|outbrain|taboola|doubleclick)\b/i;
const POPUP_RE = /\b(modal|popup|overlay|dialog|consent|cookie|subscribe|newsletter)\b/i;
const SIDEBAR_RE = /\b(sidebar|aside|rail|drawer|toc|table-of-contents)\b/i;

type TraversalFrame = {
  el: Element;
  depth: number;
  inheritedCategory: NodeCategory;
};

type MutableBlock = {
  id: string;
  element: HTMLElement;
  category: NodeCategory;
  text: string;
  depth: number;
  screenTop: number;
  relevance: number;
  terms: Set<string>;
};

const trie = createDefaultComplexWordTrie();
let blockSeq = 0;
const highlightedElements = new Set<HTMLElement>();
let lastBlocks: MutableBlock[] = [];

function normalizeTextChunk(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function elementSignature(el: Element): string {
  const id = (el as HTMLElement).id || "";
  const classes =
    typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className
      : "";
  return `${id} ${classes}`.toLowerCase();
}

function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity || "1") === 0) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return true;
}

function isSensitiveElement(el: Element): boolean {
  return Boolean(el.closest(SENSITIVE_SELECTOR));
}

function isDenseTextElement(el: Element): boolean {
  const tag = el.tagName;
  if (!["DIV", "SECTION", "ARTICLE", "MAIN"].includes(tag)) return false;

  const raw = normalizeTextChunk(el.textContent || "");
  if (!raw) return false;

  const words = tokenizeText(raw);
  if (words.length < 90) return false;

  const controls = el.querySelectorAll("a,button,input,select,textarea").length;
  return words.length / Math.max(1, controls + 1) > 20;
}

function classifyNode(el: Element, inherited: NodeCategory): NodeCategory {
  const tag = el.tagName;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const signature = elementSignature(el);

  if (
    tag === "NAV" ||
    role === "navigation" ||
    NAV_RE.test(signature)
  ) {
    return "navigation";
  }

  if (
    role === "dialog" ||
    el.getAttribute("aria-modal") === "true" ||
    POPUP_RE.test(signature)
  ) {
    return "popup";
  }

  if (
    tag === "ASIDE" ||
    role === "complementary" ||
    SIDEBAR_RE.test(signature)
  ) {
    return "sidebar";
  }

  if (
    AD_RE.test(signature) ||
    (tag === "IFRAME" && /ads|doubleclick|sponsor/i.test((el as HTMLIFrameElement).src || ""))
  ) {
    return "ads";
  }

  if (
    tag === "MAIN" ||
    tag === "ARTICLE" ||
    role === "main" ||
    MAIN_RE.test(signature)
  ) {
    return "main-content";
  }

  if (isDenseTextElement(el)) {
    return "dense-text";
  }

  if (inherited === "main-content" || inherited === "dense-text") {
    return "main-content";
  }

  return "other";
}

function shouldSkipBranch(category: NodeCategory, el: Element): boolean {
  if (category === "ads" || category === "popup") return true;
  if (category === "navigation" && el.querySelectorAll("a").length > 5) return true;
  return false;
}

function estimateVisibility(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return 0;

  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  );
  return Math.max(0, Math.min(1, visibleHeight / Math.max(1, rect.height)));
}

class ViewportPriorityManager {
  private observer: IntersectionObserver | null = null;
  private readonly ratios = new Map<string, number>();
  private readonly blocks = new Map<string, MutableBlock>();
  private readonly queue = new PriorityQueue<MutableBlock>();
  private readonly elementToId = new WeakMap<Element, string>();

  constructor() {
    if (typeof IntersectionObserver === "undefined") return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = this.elementToId.get(entry.target);
          if (!id) continue;
          this.ratios.set(id, entry.intersectionRatio);
        }
      },
      {
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );
  }

  track(nextBlocks: MutableBlock[]): void {
    if (this.observer) {
      this.observer.disconnect();
    }

    this.blocks.clear();
    this.queue.clear();

    for (const block of nextBlocks) {
      this.blocks.set(block.id, block);
      this.elementToId.set(block.element, block.id);
      const knownRatio = this.ratios.get(block.id);
      this.ratios.set(
        block.id,
        knownRatio == null ? estimateVisibility(block.element) : knownRatio
      );
      if (this.observer) {
        this.observer.observe(block.element);
      }
    }
  }

  prioritized(limit: number): Array<{ block: MutableBlock; priority: number; visibility: number }> {
    this.rebuildQueue();
    return this.queue.snapshot(limit).map((item) => ({
      block: item.payload,
      priority: item.priority,
      visibility: this.ratios.get(item.id) ?? 0,
    }));
  }

  private rebuildQueue(): void {
    this.queue.clear();

    for (const block of this.blocks.values()) {
      block.screenTop = block.element.getBoundingClientRect().top + window.scrollY;
      const visibility = this.ratios.get(block.id) ?? estimateVisibility(block.element);
      this.ratios.set(block.id, visibility);

      const viewportAnchor = window.scrollY + window.innerHeight * 0.25;
      const distance = Math.abs(block.screenTop - viewportAnchor);
      const proximity = Math.max(0, 1 - distance / Math.max(1200, window.innerHeight * 2));

      const categoryBoost =
        block.category === "main-content"
          ? 130
          : block.category === "dense-text"
            ? 100
            : block.category === "other"
              ? 40
              : block.category === "sidebar"
                ? -80
                : -300;

      const priority =
        visibility * 1000 +
        proximity * 240 +
        block.relevance * 3 +
        Math.min(70, block.terms.size * 12) +
        categoryBoost;

      this.queue.push({
        id: block.id,
        priority,
        payload: block,
      });
    }
  }
}

const viewportPriority = new ViewportPriorityManager();

function scoreBlock(block: MutableBlock): number {
  const words = tokenizeText(block.text).length;
  let score = Math.min(90, words);

  if (block.category === "main-content") score += 50;
  if (block.category === "dense-text") score += 35;
  if (block.category === "sidebar") score -= 20;
  if (block.category === "navigation" || block.category === "ads" || block.category === "popup") {
    score -= 60;
  }

  score += Math.min(50, block.terms.size * 8);
  return Math.max(0, score);
}

function createEmptyStats(): DomStats {
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

function toAnalysisBlock(
  block: MutableBlock,
  visibility: number,
  relevance: number
): AnalysisBlock {
  return {
    id: block.id,
    text: block.text,
    category: block.category,
    screenTop: block.screenTop,
    relevance,
    visibility,
    difficultTerms: Array.from(block.terms),
  };
}

function appendWithLimit(chunks: string[], text: string, budget: { used: number }, maxChars: number): void {
  if (budget.used >= maxChars) return;
  const remaining = maxChars - budget.used;
  const clipped = text.slice(0, remaining).trim();
  if (!clipped) return;
  chunks.push(clipped);
  budget.used += clipped.length;
}

export function analyzePageDom(root: Element | Document = document): PageAnalysis {
  const body = root instanceof Document ? root.body : root;
  if (!body) {
    return {
      text: "",
      prioritizedText: "",
      difficultTerms: [],
      blocks: [],
      domStats: createEmptyStats(),
    };
  }

  const stats = createEmptyStats();
  const queue: TraversalFrame[] = [
    {
      el: body,
      depth: 0,
      inheritedCategory: "other",
    },
  ];

  const blockByElement = new Map<HTMLElement, MutableBlock>();
  const difficultTerms = new Set<string>();

  let visited = 0;
  let textChars = 0;
  let totalWords = 0;

  while (queue.length > 0 && visited < MAX_TRAVERSAL_NODES && textChars < MAX_TEXT_CHARS) {
    const frame = queue.shift()!;
    const { el, depth, inheritedCategory } = frame;
    visited++;

    if (SKIP_TAGS.has(el.tagName)) continue;
    if (!isElementVisible(el)) continue;
    if (isSensitiveElement(el)) continue;

    const category = classifyNode(el, inheritedCategory);

    if (/^H[1-6]$/.test(el.tagName)) stats.headings = (stats.headings ?? 0) + 1;
    if (el.tagName === "IMG") stats.images++;
    if (el.tagName === "IFRAME") stats.iframes++;
    if (el.tagName === "VIDEO") stats.videos++;
    if (el.tagName === "BUTTON") stats.buttons++;
    if (el.tagName === "A") stats.links++;
    if (category === "popup") stats.popups = (stats.popups ?? 0) + 1;
    if (category === "sidebar") stats.sidebars = (stats.sidebars ?? 0) + 1;
    if (category === "dense-text") stats.denseTextBlocks = (stats.denseTextBlocks ?? 0) + 1;

    stats.maxDepthSample = Math.max(stats.maxDepthSample, depth);

    if (shouldSkipBranch(category, el)) {
      continue;
    }

    if (el instanceof HTMLElement) {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const textNode = child as Text;
        const chunk = normalizeTextChunk(textNode.textContent || "");
        if (!chunk) continue;
        if (chunk.length < 2) continue;

        const terms = trie.findTerms(chunk);
        let block = blockByElement.get(el);
        if (!block) {
          block = {
            id: `block-${++blockSeq}`,
            element: el,
            category,
            text: "",
            depth,
            screenTop: el.getBoundingClientRect().top + window.scrollY,
            relevance: 0,
            terms: new Set<string>(),
          };
          blockByElement.set(el, block);
        }

        block.text += block.text ? ` ${chunk}` : chunk;
        for (const term of terms) {
          block.terms.add(term);
          difficultTerms.add(term);
        }

        textChars += chunk.length;
      }
    }

    if (blockByElement.size >= MAX_BLOCKS) {
      break;
    }

    const nextInherited =
      category === "main-content" || category === "dense-text"
        ? "main-content"
        : inheritedCategory;

    for (const child of Array.from(el.children)) {
      queue.push({
        el: child,
        depth: depth + 1,
        inheritedCategory: nextInherited,
      });
    }
  }

  const blocks = Array.from(blockByElement.values())
    .filter((block) => block.text.length >= 25)
    .map((block) => {
      block.relevance = scoreBlock(block);
      totalWords += tokenizeText(block.text).length;
      return block;
    })
    .sort((a, b) => a.screenTop - b.screenTop)
    .slice(0, MAX_BLOCKS);

  lastBlocks = blocks;

  stats.textDensity = blocks.length
    ? Number((totalWords / Math.max(1, blocks.length)).toFixed(2))
    : 0;
  stats.difficultTerms = difficultTerms.size;

  const fullTextChunks: string[] = [];
  const fullBudget = { used: 0 };
  for (const block of blocks) {
    appendWithLimit(fullTextChunks, block.text, fullBudget, MAX_TEXT_CHARS);
  }

  viewportPriority.track(blocks);
  const ranked = viewportPriority.prioritized(80);

  const prioritizedChunks: string[] = [];
  const prioritizedBudget = { used: 0 };
  const prioritizedBlocks: AnalysisBlock[] = [];
  for (const item of ranked) {
    const block = item.block;
    const text = block.text;
    if (!text.trim()) continue;
    appendWithLimit(prioritizedChunks, text, prioritizedBudget, MAX_TEXT_CHARS);
    prioritizedBlocks.push(toAnalysisBlock(block, item.visibility, item.priority));
  }

  const prioritizedText = prioritizedChunks.join("\n\n");

  return {
    text: fullTextChunks.join("\n\n").slice(0, MAX_TEXT_CHARS),
    prioritizedText: prioritizedText || fullTextChunks.join("\n\n").slice(0, MAX_TEXT_CHARS),
    difficultTerms: Array.from(difficultTerms),
    blocks: prioritizedBlocks,
    domStats: stats,
  };
}

export function applyDifficultHighlights(attributeName = "data-neuro-inclusive-difficult"): number {
  for (const el of highlightedElements) {
    el.removeAttribute(attributeName);
    el.removeAttribute("title");
  }
  highlightedElements.clear();

  let count = 0;
  for (const block of lastBlocks) {
    if (!block.terms.size) continue;
    block.element.setAttribute(attributeName, "1");
    block.element.setAttribute(
      "title",
      `Difficult terms: ${Array.from(block.terms).slice(0, 6).join(", ")}`
    );
    highlightedElements.add(block.element);
    count++;
  }
  return count;
}

export function clearDifficultHighlights(attributeName = "data-neuro-inclusive-difficult"): void {
  for (const el of highlightedElements) {
    el.removeAttribute(attributeName);
    el.removeAttribute("title");
  }
  highlightedElements.clear();
}

export function getClassifiedElements(categories: NodeCategory[]): HTMLElement[] {
  const wanted = new Set<NodeCategory>(categories);
  const out = new Set<HTMLElement>();
  for (const block of lastBlocks) {
    if (wanted.has(block.category)) {
      out.add(block.element);
    }
  }
  return Array.from(out);
}
