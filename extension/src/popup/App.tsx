import { useEffect, useCallback, useState } from "react";
import { useStore, getPageSettingsFromStore } from "./store.js";
import { sendToActiveTab } from "./tab.js";
import type {
  BackgroundRequest,
  BackgroundResponse,
  DomStats,
  PageAnalysis,
} from "../shared/messages.js";

import { computeCognitiveLoad } from "../shared/cognitiveLoad.js";
import { localSimplify, localSummarize } from "../shared/localAiFallback.js";
import { PROFILE_LIST } from "../shared/profiles.js";

const DEFAULT_API_BASE = "http://localhost:3000";

function cleanSummaryLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

function sentenceList(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSmartTldrText(sourceText: string, tldr: string, bullets: string): string {
  const fallbackSentences = sentenceList(sourceText);
  const tldrSentences = sentenceList(tldr);
  const bulletLines = cleanSummaryLines(bullets);

  const oneLine = tldrSentences[0] || fallbackSentences[0] || "No summary available.";
  const keyBullets = (bulletLines.length ? bulletLines : fallbackSentences)
    .slice(0, 3)
    .map((line) => `- ${line}`)
    .join("\n");
  const takeaway = tldrSentences[1] || bulletLines[0] || oneLine;

  return [
    `1-line summary: ${oneLine}`,
    "",
    "3 key bullet points:",
    keyBullets || "- No key points available.",
    "",
    `Key takeaway: ${takeaway}`,
  ].join("\n");
}

function buildKeyPointsText(sourceText: string, bullets: string): string {
  const bulletLines = cleanSummaryLines(bullets);
  const fallbackSentences = sentenceList(sourceText);
  const keyBullets = (bulletLines.length ? bulletLines : fallbackSentences)
    .slice(0, 3)
    .map((line) => `- ${line}`)
    .join("\n");
  const takeaway = bulletLines[0] || fallbackSentences[0] || "No key points available.";

  return [
    "3 key bullet points:",
    keyBullets || "- No key points available.",
    "",
    `Key takeaway: ${takeaway}`,
  ].join("\n");
}

function cognitiveBand(score: number | null): "Easy" | "Medium" | "Hard" | "—" {
  if (score == null) return "—";
  if (score < 35) return "Easy";
  if (score < 65) return "Medium";
  return "Hard";
}

function resolveApiBase(v: string): string {
  const trimmed = v.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_API_BASE;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return trimmed;
    }
  } catch {
    // Fall through to default.
  }
  return DEFAULT_API_BASE;
}

async function bgApi(msg: BackgroundRequest): Promise<BackgroundResponse> {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Background message failed",
    };
  }
}

const EMPTY_DOM_STATS: DomStats = {
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

async function getPageAnalysisFromActiveTab(): Promise<PageAnalysis | null> {
  const analysisRes = await sendToActiveTab({ type: "GET_PAGE_ANALYSIS" });
  if (analysisRes.ok && analysisRes.analysis) {
    return analysisRes.analysis;
  }

  const [textRes, domRes] = await Promise.all([
    sendToActiveTab({ type: "GET_PAGE_TEXT" }),
    sendToActiveTab({ type: "GET_DOM_STATS" }),
  ]);
  if (!textRes.ok || !textRes.text) return null;

  return {
    text: textRes.text,
    prioritizedText: textRes.text,
    blocks: [],
    difficultTerms: [],
    domStats: domRes.ok && domRes.domStats ? domRes.domStats : EMPTY_DOM_STATS,
  };
}

export default function App() {
  const s = useStore();
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    void useStore.getState().hydrate();
  }, []);

  const persist = useStore((x) => x.persist);

  useEffect(() => {
    const t = setTimeout(() => void persist(), 300);
    return () => clearTimeout(t);
  }, [
    s.apiBase,
    s.profile,
    s.theme,
    s.fontSizePx,
    s.lineHeight,
    s.letterSpacingEm,
    s.readabilityMode,
    s.distractionReduction,
    s.focusMode,
    s.bionicReading,
    s.readingRuler,
    s.useServerCognitive,
    persist,
  ]);

  const applyToPage = useCallback(async () => {
    if (isApplying) return;
    setIsApplying(true);
    s.setStatus("Applying…");
    const settings = getPageSettingsFromStore();
    const apiBase = resolveApiBase(s.apiBase);
    try {
      const r = await sendToActiveTab({
        type: "APPLY_SETTINGS",
        settings,
        apiBase,
      });
      s.setStatus(r.ok ? "Applied to page." : r.error ?? "Failed");
    } finally {
      setIsApplying(false);
    }
  }, [isApplying, s]);

  const scorePage = useCallback(async () => {
    s.setStatus("Scoring…");
    const analysis = await getPageAnalysisFromActiveTab();
    if (!analysis) {
      s.setStatus("No readable text on this page.");
      return;
    }

    const scoreText = analysis.prioritizedText || analysis.text;
    if (!scoreText.trim()) {
      s.setStatus("No visible text to score.");
      return;
    }

    const dom = analysis.domStats;
    const projectedText = localSimplify(scoreText);
    const afterInput = projectedText.trim() || scoreText;

    const localBefore = computeCognitiveLoad(scoreText, dom);
    const localAfter = computeCognitiveLoad(afterInput, dom);
    let before = localBefore.score;
    let after = localAfter.score;

    const factorParts: string[] = [
      `Local before: sentences ${localBefore.factors.sentenceComplexity}, clutter ${localBefore.factors.clutter}`,
      `Local after: sentences ${localAfter.factors.sentenceComplexity}, clutter ${localAfter.factors.clutter}`,
      `Headings ${dom.headings ?? 0}, difficult terms ${analysis.difficultTerms.length}`,
    ];

    const apiBase = resolveApiBase(s.apiBase);

    if (s.useServerCognitive) {
      const [beforeApi, afterApi] = await Promise.all([
        bgApi({
          type: "API_COGNITIVE_LOAD",
          text: scoreText,
          domStats: dom ?? EMPTY_DOM_STATS,
          apiBase,
        }),
        bgApi({
          type: "API_COGNITIVE_LOAD",
          text: afterInput,
          domStats: dom ?? EMPTY_DOM_STATS,
          apiBase,
        }),
      ]);

      if (beforeApi.ok && beforeApi.score != null) {
        before = Math.round((before + beforeApi.score) / 2);
        factorParts.push(`Gemini before: ${beforeApi.reason ?? beforeApi.score}`);
      }

      if (afterApi.ok && afterApi.score != null) {
        after = Math.round((after + afterApi.score) / 2);
        factorParts.push(`Gemini after: ${afterApi.reason ?? afterApi.score}`);
      }
    }

    s.setCognitive(before, after, factorParts.join(" | "));
    s.setStatus("Cognitive load updated (before/after).");
  }, [s]);

  const simplifyPage = useCallback(async () => {
    s.setStatus("Analyzing page…");
    const analysis = await getPageAnalysisFromActiveTab();
    if (!analysis) {
      s.setStatus("No readable text on this page.");
      return;
    }

    const dom = analysis.domStats;
    const sourceText = (analysis.prioritizedText || analysis.text).trim();
    if (!sourceText) {
      s.setStatus("No visible text to simplify.");
      return;
    }

    let beforeScore = computeCognitiveLoad(sourceText, dom).score;
    const complexitySignals = [
      beforeScore >= 48,
      analysis.difficultTerms.length >= 4,
      (dom.denseTextBlocks ?? 0) >= 2,
      (dom.popups ?? 0) + (dom.sidebars ?? 0) >= 2,
      sourceText.length >= 1400,
    ];
    const needsAi = complexitySignals.filter(Boolean).length >= 2 || beforeScore >= 58;

    s.setStatus(needsAi ? "Simplifying with AI…" : "Using deterministic simplification…");
    const apiBase = resolveApiBase(s.apiBase);
    const aiInput = sourceText.slice(0, 6000);
    let simplified = "";
    let usedAi = false;
    let statusNote = "";

    if (needsAi) {
      const api = await bgApi({
        type: "API_SIMPLIFY",
        text: aiInput,
        apiBase,
      });
      const apiSimplified =
        api.ok && typeof api.simplified === "string"
          ? api.simplified.trim()
          : undefined;

      if (apiSimplified) {
        simplified = apiSimplified;
        usedAi = true;
      } else {
        simplified = localSimplify(sourceText);
        statusNote =
          api.ok === false
            ? ` (fallback: ${api.error})`
            : typeof api.simplified !== "string"
              ? " (fallback: invalid API response)"
              : " (fallback: empty API output)";
      }
    } else {
      simplified = localSimplify(sourceText);
      statusNote = " (heuristic path: low complexity, AI skipped)";
    }

    let afterScore = computeCognitiveLoad(simplified, dom).score;

    const factorParts = [
      `Heuristic pipeline: score ${beforeScore}, difficult terms ${analysis.difficultTerms.length}, AI ${usedAi ? "used" : "skipped"}`,
    ];

    if (s.useServerCognitive) {
      const [beforeApi, afterApi] = await Promise.all([
        bgApi({
          type: "API_COGNITIVE_LOAD",
          text: sourceText,
          domStats: dom ?? EMPTY_DOM_STATS,
          apiBase,
        }),
        bgApi({
          type: "API_COGNITIVE_LOAD",
          text: simplified,
          domStats: dom ?? EMPTY_DOM_STATS,
          apiBase,
        }),
      ]);

      if (beforeApi.ok && beforeApi.score != null) {
        beforeScore = Math.round((beforeScore + beforeApi.score) / 2);
      }
      if (afterApi.ok && afterApi.score != null) {
        afterScore = Math.round((afterScore + afterApi.score) / 2);
      }

      if (beforeApi.ok || afterApi.ok) {
        factorParts.push("Gemini cognitive blend applied.");
      }
    }

    s.setLastSimplified(sourceText, simplified);
    s.setSimplifiedView("simplified");
    s.setCognitive(beforeScore, afterScore, factorParts.join(" | "));
    await sendToActiveTab({
      type: "SHOW_SIMPLIFIED",
      simplified,
      show: true,
    });
    s.setStatus(
      `${usedAi ? "Simplified with AI" : "Simplified deterministically"}. Toggle Original / Simplified below.${statusNote}`
    );
  }, [s]);

  const toggleView = useCallback(async () => {
    const cur = useStore.getState().simplifiedView;
    const next = cur === "original" ? "simplified" : "original";
    useStore.getState().setSimplifiedView(next);
    const st = useStore.getState();
    const text =
      next === "simplified" ? st.lastSimplified : st.lastOriginalSample;
    if (!text.trim()) {
      useStore.getState().setStatus("No simplified text yet. Run Simplify page first.");
      return;
    }
    await sendToActiveTab({
      type: "SHOW_SIMPLIFIED",
      simplified: text,
      show: true,
    });
  }, []);

  const summarize = useCallback(
    async (mode: "tldr" | "bullets") => {
      s.setStatus("Summarizing…");
      const analysis = await getPageAnalysisFromActiveTab();
      if (!analysis) {
        s.setStatus("No readable text on this page.");
        return;
      }
      const sourceText = (analysis.prioritizedText || analysis.text).trim();
      if (!sourceText) {
        s.setStatus("No text to summarize.");
        return;
      }
      const apiBase = resolveApiBase(s.apiBase);

      if (mode === "tldr") {
        const [apiTldr, apiBullets] = await Promise.all([
          bgApi({
            type: "API_SUMMARIZE",
            text: sourceText.slice(0, 6000),
            mode: "tldr",
            apiBase,
          }),
          bgApi({
            type: "API_SUMMARIZE",
            text: sourceText.slice(0, 6000),
            mode: "bullets",
            apiBase,
          }),
        ]);

        const tldrText =
          apiTldr.ok && typeof apiTldr.summary === "string" && apiTldr.summary.trim()
            ? apiTldr.summary.trim()
            : localSummarize(sourceText, "tldr").trim();

        const bulletsText =
          apiBullets.ok && typeof apiBullets.summary === "string" && apiBullets.summary.trim()
            ? apiBullets.summary.trim()
            : localSummarize(sourceText, "bullets").trim();

        const smartTldr = buildSmartTldrText(sourceText, tldrText, bulletsText);
        s.setSummaryText(smartTldr);
        if (apiTldr.ok || apiBullets.ok) {
          s.setStatus("Smart TL;DR ready.");
        } else {
          s.setStatus("Smart TL;DR (offline fallback).");
        }
        return;
      }

      const api = await bgApi({
        type: "API_SUMMARIZE",
        text: sourceText.slice(0, 6000),
        mode: "bullets",
        apiBase,
      });
      const apiSummary =
        api.ok && typeof api.summary === "string" ? api.summary.trim() : undefined;
      let summary = apiSummary ?? "";
      if (!api.ok || typeof api.summary !== "string" || !apiSummary) {
        summary = localSummarize(sourceText, "bullets");
        s.setSummaryText(buildKeyPointsText(sourceText, summary));
        if (!api.ok) {
          s.setStatus(`Bullets (offline fallback: ${api.error})`);
        } else if (typeof api.summary !== "string") {
          s.setStatus("Bullets (offline fallback: invalid API response).");
        } else {
          s.setStatus("Bullets (offline fallback: empty API output).");
        }
        return;
      }
      s.setSummaryText(buildKeyPointsText(sourceText, summary));
      s.setStatus("Bullets ready.");
    },
    [s]
  );

  const hasSummary = s.summaryText.trim().length > 0;
  const hasSimplifiedCompare =
    s.lastSimplified.trim().length > 0 && s.lastOriginalSample.trim().length > 0;
  const statusText = s.status.trim() || "Ready.";
  const beforeBand = cognitiveBand(s.cognitiveBefore);
  const afterBand = cognitiveBand(s.cognitiveAfter);

  return (
    <div className="panel">
      <header className="hero">
        <h1>Neuro-Inclusive</h1>
        <p className="subtitle">Make long pages calmer and easier to read.</p>
      </header>

      <section className="section">
        <h2>Profile</h2>
        <p className="hint">Choose a preset, then apply.</p>
        <div className="profile-grid">
          {PROFILE_LIST.map((p) => (
            <button
              key={p.id}
              type="button"
              className={s.profile === p.id ? "chip is-active" : "chip"}
              onClick={() => {
                s.setProfile(p.id);
              }}
              title={p.description}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <section className="section compact">
        <h2>Quick options</h2>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.readabilityMode}
            onChange={(e) => s.patchPage({ readabilityMode: e.target.checked })}
          />
          Readability mode
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.distractionReduction}
            onChange={(e) =>
              s.patchPage({ distractionReduction: e.target.checked })
            }
          />
          Reduce distractions
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={s.focusMode}
            onChange={(e) => s.patchPage({ focusMode: e.target.checked })}
          />
          Cursor spotlight (dim rest)
        </label>
      </section>

      <section className="section actions">
        <button
          type="button"
          className="primary wide"
          onClick={() => void applyToPage()}
          disabled={isApplying}
        >
          {isApplying ? "Applying..." : "Apply to page"}
        </button>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void scorePage()}>
            Analyze load
          </button>
          <button type="button" className="primary" onClick={() => void simplifyPage()}>
            Simplify text
          </button>
        </div>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void summarize("tldr")}>
            Smart TL;DR
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void summarize("bullets")}
          >
            Key points
          </button>
        </div>
        {hasSimplifiedCompare ? (
          <button type="button" className="ghost" onClick={() => void toggleView()}>
            {s.simplifiedView === "simplified"
              ? "Show original text"
              : "Show simplified text"}
          </button>
        ) : null}
      </section>

      <section className="section compact">
        <h2>Cognitive load</h2>
        <div className="score-grid">
          <div className="score-item">
            <span className="score-label">Before</span>
            <span className="score-pill before">{s.cognitiveBefore ?? "--"}</span>
            <span className="score-band">{beforeBand}</span>
          </div>
          <div className="score-item">
            <span className="score-label">After</span>
            <span className="score-pill after">{s.cognitiveAfter ?? "--"}</span>
            <span className="score-band">{afterBand}</span>
          </div>
        </div>
        {s.cognitiveFactors ? (
          <details className="details-inline">
            <summary>How this score was calculated</summary>
            <p className="hint">{s.cognitiveFactors}</p>
          </details>
        ) : null}
      </section>

      {hasSummary ? (
        <section className="section compact">
          <h2>Summary</h2>
          <pre className="summary">{s.summaryText}</pre>
        </section>
      ) : null}

      <details className="details-block">
        <summary>Advanced settings</summary>
        <div className="advanced-stack">
          <label className="field">
            API base URL
            <input
              type="text"
              value={s.apiBase}
              onChange={(e) => s.setApiBase(e.target.value)}
              onBlur={() => s.setApiBase(resolveApiBase(s.apiBase))}
              placeholder="http://localhost:3000"
              aria-label="API base URL"
            />
          </label>

          <label className="field">
            Theme
            <select
              value={s.theme}
              onChange={(e) =>
                s.patchPage({ theme: e.target.value as typeof s.theme })
              }
              aria-label="Theme"
            >
              <option value="default">Default</option>
              <option value="dark">Dark</option>
              <option value="sepia">Sepia</option>
              <option value="dyslexia">Dyslexia</option>
              <option value="autism">Autism (muted)</option>
            </select>
          </label>

          <div className="field-grid">
            <label className="field">
              Font (px)
              <input
                type="number"
                min={12}
                max={28}
                value={s.fontSizePx}
                onChange={(e) =>
                  s.patchPage({ fontSizePx: Number(e.target.value) || 16 })
                }
              />
            </label>
            <label className="field">
              Line height
              <input
                type="number"
                step={0.05}
                min={1.2}
                max={2.2}
                value={s.lineHeight}
                onChange={(e) =>
                  s.patchPage({ lineHeight: Number(e.target.value) || 1.5 })
                }
              />
            </label>
            <label className="field">
              Letter spacing (em)
              <input
                type="number"
                step={0.01}
                min={0}
                max={0.2}
                value={s.letterSpacingEm}
                onChange={(e) =>
                  s.patchPage({ letterSpacingEm: Number(e.target.value) || 0 })
                }
              />
            </label>
          </div>

          <label className="chk">
            <input
              type="checkbox"
              checked={s.bionicReading}
              onChange={(e) => s.patchPage({ bionicReading: e.target.checked })}
            />
            Bionic reading
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.readingRuler}
              onChange={(e) => s.patchPage({ readingRuler: e.target.checked })}
            />
            Reading ruler
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.useServerCognitive}
              onChange={(e) => s.setUseServerCognitive(e.target.checked)}
            />
            Blend server cognitive score
          </label>
        </div>
      </details>

      <p className="status">{statusText}</p>
    </div>
  );
}
