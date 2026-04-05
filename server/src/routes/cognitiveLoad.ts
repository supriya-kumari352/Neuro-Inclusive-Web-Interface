import { Router } from "express";
import { getModel, isGeminiConfigured } from "../lib/gemini.js";
import { cognitiveLoadSystem, cognitiveLoadUser } from "../lib/prompts.js";

const router = Router();
const MAX_IN = 12000;

/**
 * Optional Gemini-assisted cognitive load — returns JSON { score, reason }.
 * Used to blend with client heuristics when enabled.
 * Falls back to a heuristic score when Gemini is unavailable.
 */

function heuristicScore(text: string): { score: number; reason: string } {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const avgWps = words.length / Math.max(sentences.length, 1);
  const score = Math.min(100, Math.max(0, Math.round(avgWps * 3.5)));
  return { score, reason: `Heuristic: avg ${avgWps.toFixed(1)} words/sentence` };
}

router.post("/", async (req, res) => {
  let clipped = "";
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    clipped = text.slice(0, MAX_IN).trim();
    const domStats = req.body?.domStats;
    const domHint =
      domStats && typeof domStats === "object"
        ? JSON.stringify(domStats)
        : "unknown";
    if (!clipped) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (!isGeminiConfigured()) {
      const h = heuristicScore(clipped);
      return res.json({ ...h, mock: true });
    }

    try {
      const model = getModel();
      const result = await model.generateContent(
        `${cognitiveLoadSystem}\n\n${cognitiveLoadUser(clipped, domHint)}`
      );
      const raw = result.response.text().trim();
      let parsed: { score?: number; reason?: string };
      try {
        parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
      } catch {
        return res.json({
          score: 50,
          reason: "Model output was not valid JSON — using safe default",
          mock: true,
        });
      }
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 50));
      return res.json({
        score,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      });
    } catch (apiErr) {
      console.warn("cognitiveLoad: Gemini failed, using fallback");
      const h = heuristicScore(clipped);
      return res.json({ ...h, mock: true });
    }
  } catch (e) {
    console.error("cognitiveLoad", e);
    const h = heuristicScore(clipped);
    return res.json({ ...h, mock: true, reason: "Server error — using heuristic fallback" });
  }
});

export default router;
