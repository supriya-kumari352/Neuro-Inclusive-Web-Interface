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
    const local = computeCognitiveLoad(scoreText, dom);
    let before = local.score;
    let factors =
      `Local: sentences ${local.factors.sentenceComplexity}, clutter ${local.factors.clutter}, ` +
      `headings ${dom.headings ?? 0}, difficult terms ${analysis.difficultTerms.length}`;
    const apiBase = resolveApiBase(s.apiBase);

    if (s.useServerCognitive) {
      const api = await bgApi({
        type: "API_COGNITIVE_LOAD",
        text: scoreText,
        domStats: dom ?? EMPTY_DOM_STATS,
        apiBase,
      });
      if (api.ok && api.score != null) {
        before = Math.round((before + api.score) / 2);
        factors += ` | Gemini: ${api.reason ?? ""}`;
      }
    }

    s.setCognitive(before, null, factors);
    s.setStatus("Cognitive load (before) updated.");
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

    const beforeScore = computeCognitiveLoad(sourceText, dom).score;
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

    const afterScore = computeCognitiveLoad(simplified, dom).score;
    s.setLastSimplified(sourceText, simplified);
    s.setSimplifiedView("simplified");
    s.setCognitive(
      beforeScore,
      afterScore,
      `Heuristic pipeline: score ${beforeScore}, difficult terms ${analysis.difficultTerms.length}, AI ${usedAi ? "used" : "skipped"}`
    );
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
      const api = await bgApi({
        type: "API_SUMMARIZE",
        text: sourceText.slice(0, 6000),
        mode,
        apiBase,
      });
      const apiSummary =
        api.ok && typeof api.summary === "string" ? api.summary.trim() : undefined;
      let summary = apiSummary ?? "";
      if (!api.ok || typeof api.summary !== "string" || !apiSummary) {
        summary = localSummarize(sourceText, mode);
        s.setSummaryText(summary);
        if (!api.ok) {
          s.setStatus(
            mode === "tldr"
              ? `TL;DR (offline fallback: ${api.error})`
              : `Bullets (offline fallback: ${api.error})`
          );
        } else if (typeof api.summary !== "string") {
          s.setStatus(
            mode === "tldr"
              ? "TL;DR (offline fallback: invalid API response)."
              : "Bullets (offline fallback: invalid API response)."
          );
        } else {
          s.setStatus(
            mode === "tldr"
              ? "TL;DR (offline fallback: empty API output)."
              : "Bullets (offline fallback: empty API output)."
          );
        }
        return;
      }
      s.setSummaryText(summary);
      s.setStatus(mode === "tldr" ? "TL;DR ready." : "Bullets ready.");
    },
    [s]
  );

  return (
    <div className="panel">
      <h1>Neuro-Inclusive</h1>
      <p className="muted">Hackathon prototype — keys stay on your API server.</p>

      <h2>API</h2>
      <input
        type="text"
        value={s.apiBase}
        onChange={(e) => s.setApiBase(e.target.value)}
        onBlur={() => s.setApiBase(resolveApiBase(s.apiBase))}
        placeholder="http://localhost:3000"
        aria-label="API base URL"
      />

      <h2>Profile</h2>
      <div className="row">
        {PROFILE_LIST.map((p) => (
          <button
            key={p.id}
            type="button"
            className={s.profile === p.id ? undefined : "secondary"}
            onClick={() => {
              s.setProfile(p.id);
            }}
            title={p.description}
          >
            {p.label}
          </button>
        ))}
      </div>

      <h2>Visual</h2>
      <div className="row">
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
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="muted" style={{ flex: "0 0 100%" }}>
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
        <label className="muted" style={{ flex: "0 0 100%" }}>
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
        <label className="muted" style={{ flex: "0 0 100%" }}>
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

      <label className="chk" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={s.readabilityMode}
          onChange={(e) => s.patchPage({ readabilityMode: e.target.checked })}
        />
        Readability mode (narrow column)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.distractionReduction}
          onChange={(e) =>
            s.patchPage({ distractionReduction: e.target.checked })
          }
        />
        Distraction reduction (blur common ads / autoplay)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.focusMode}
          onChange={(e) => s.patchPage({ focusMode: e.target.checked })}
        />
        Focus mode (spotlight main content)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.bionicReading}
          onChange={(e) => s.patchPage({ bionicReading: e.target.checked })}
        />
        Bionic Reading (bold first half of words)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.readingRuler}
          onChange={(e) => s.patchPage({ readingRuler: e.target.checked })}
        />
        Reading Ruler (highlights current line)
      </label>

      <div className="divider" />

      <div className="row">
        <button type="button" onClick={() => void applyToPage()} disabled={isApplying}>
          Apply to page
        </button>
        <button type="button" className="secondary" onClick={() => void scorePage()}>
          Score cognitive load
        </button>
      </div>

      <label className="chk" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={s.useServerCognitive}
          onChange={(e) => s.setUseServerCognitive(e.target.checked)}
        />
        Blend Gemini cognitive score (uses API)
      </label>

      <div style={{ marginTop: 10 }}>
        <span className="muted">Before: </span>
        <span className="score-pill before">
          {s.cognitiveBefore ?? "—"}
        </span>
        <span className="muted" style={{ marginLeft: 10 }}>
          After:{" "}
        </span>
        <span className="score-pill after">{s.cognitiveAfter ?? "—"}</span>
      </div>
      {s.cognitiveFactors ? (
        <p className="muted" style={{ marginTop: 6 }}>
          {s.cognitiveFactors}
        </p>
      ) : null}

      <div className="divider" />

      <div className="row">
        <button type="button" onClick={() => void simplifyPage()}>
          Simplify page (AI)
        </button>
        <button type="button" className="secondary" onClick={() => void toggleView()}>
          Toggle: {s.simplifiedView === "simplified" ? "Original" : "Simplified"}
        </button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => void summarize("tldr")}>
          TL;DR
        </button>
        <button type="button" className="secondary" onClick={() => void summarize("bullets")}>
          Bullet summary
        </button>
      </div>

      {s.summaryText ? (
        <>
          <h2>Summary</h2>
          <pre className="summary">{s.summaryText}</pre>
        </>
      ) : null}

      <p className="muted" style={{ marginTop: 10 }}>
        {s.status}
      </p>
    </div>
  );
}
