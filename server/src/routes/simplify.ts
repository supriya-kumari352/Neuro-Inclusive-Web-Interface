import { Router } from "express";
import { getModel, isGeminiConfigured } from "../lib/gemini.js";
import { simplifySystem, simplifyUser } from "../lib/prompts.js";

const router = Router();

const MAX_IN = 12000;

/** Naive client-side fallback: split into sentences, keep only shorter ones, reduce jargon */
function mockSimplify(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences
    .map((s) => {
      // Shorten very long sentences by keeping first 18 words
      const words = s.split(/\s+/);
      if (words.length > 22) return words.slice(0, 18).join(" ") + ".";
      return s;
    })
    .join(" ");
}

router.post("/", async (req, res) => {
  let clipped = "";
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    clipped = text.slice(0, MAX_IN).trim();
    if (!clipped) {
      return res.status(400).json({ error: "Missing text" });
    }

    // Fallback when Gemini is not configured or unavailable
    if (!isGeminiConfigured()) {
      return res.json({
        simplified: mockSimplify(clipped),
        mock: true,
        reason: "GEMINI_API_KEY not set — using local fallback",
      });
    }

    try {
      const model = getModel();
      const result = await model.generateContent(
        `${simplifySystem}\n\n${simplifyUser(clipped)}`
      );
      const out = result.response.text();
      const simplified = out.trim();
      if (!simplified) {
        return res.json({
          simplified: mockSimplify(clipped),
          mock: true,
          reason: "Gemini returned empty output — using local fallback",
        });
      }
      return res.json({ simplified });
    } catch (apiErr) {
      // Gemini call failed (quota, network, etc.) — return mock instead of 500
      console.warn("simplify: Gemini failed, using fallback");
      return res.json({
        simplified: mockSimplify(clipped),
        mock: true,
        reason: "Gemini unavailable — using local fallback",
      });
    }
  } catch (e) {
    console.error("simplify", e);
    return res.json({
      simplified: mockSimplify(clipped),
      mock: true,
      reason: "Server error — using local fallback",
    });
  }
});

export default router;
