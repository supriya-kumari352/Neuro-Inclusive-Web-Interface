import { Router } from "express";
import { getModel, isGeminiConfigured } from "../lib/gemini.js";
import {
  summarizeSystem,
  summarizeUserBullets,
  summarizeUserTldr,
} from "../lib/prompts.js";

const router = Router();

const MAX_IN = 12000;

/** Naive mock: pick first N sentences as a summary */
function mockSummarize(text: string, mode: "tldr" | "bullets"): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (mode === "tldr") {
    return sentences.slice(0, 3).join(" ") || "No content to summarize.";
  }
  // bullets
  return sentences
    .slice(0, 6)
    .map((s) => `- ${s}`)
    .join("\n");
}

router.post("/", async (req, res) => {
  let clipped = "";
  let mode: "tldr" | "bullets" = "tldr";
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    mode = req.body?.mode === "bullets" ? "bullets" : "tldr";
    clipped = text.slice(0, MAX_IN).trim();
    if (!clipped) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (!isGeminiConfigured()) {
      return res.json({
        summary: mockSummarize(clipped, mode),
        mode,
        mock: true,
        reason: "GEMINI_API_KEY not set — using local fallback",
      });
    }

    try {
      const user =
        mode === "bullets" ? summarizeUserBullets(clipped) : summarizeUserTldr(clipped);
      const model = getModel();
      const result = await model.generateContent(`${summarizeSystem}\n\n${user}`);
      const out = result.response.text().trim();
      if (!out) {
        return res.json({
          summary: mockSummarize(clipped, mode),
          mode,
          mock: true,
          reason: "Gemini returned empty output — using local fallback",
        });
      }
      return res.json({ summary: out, mode });
    } catch (apiErr) {
      console.warn("summarize: Gemini failed, using fallback");
      return res.json({
        summary: mockSummarize(clipped, mode),
        mode,
        mock: true,
        reason: "Gemini unavailable — using local fallback",
      });
    }
  } catch (e) {
    console.error("summarize", e);
    return res.json({
      summary: mockSummarize(clipped, mode),
      mode,
      mock: true,
      reason: "Server error — using local fallback",
    });
  }
});

export default router;
