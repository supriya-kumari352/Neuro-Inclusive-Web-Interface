import { Router } from "express";
import { getModel, isGeminiConfigured } from "../lib/gemini.js";
import { defineSystem, defineUser } from "../lib/prompts.js";

const router = Router();
const MAX_IN = 2000;

function mockDefine(text: string): string {
  const term = text.slice(0, 80).trim();
  if (!term) {
    return "(Offline) Select a word or short phrase to explain.";
  }
  return `(Offline) ${term}: short explanation unavailable right now. Enable the API for a richer definition.`;
}

router.post("/", async (req, res) => {
  let clipped = "";
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    clipped = text.slice(0, MAX_IN).trim();
    if (!clipped) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (!isGeminiConfigured()) {
      return res.json({
        definition: mockDefine(clipped),
        mock: true,
        reason: "GEMINI_API_KEY not set — using local fallback",
      });
    }

    try {
      const model = getModel();
      const result = await model.generateContent(`${defineSystem}\n\n${defineUser(clipped)}`);
      const out = result.response.text().trim();
      if (!out) {
        return res.json({
          definition: mockDefine(clipped),
          mock: true,
          reason: "Gemini returned empty output — using local fallback",
        });
      }
      return res.json({ definition: out });
    } catch (apiErr) {
      console.warn("define: Gemini failed, using fallback");
      return res.json({
        definition: mockDefine(clipped),
        mock: true,
        reason: "Gemini unavailable — using local fallback",
      });
    }
  } catch (e) {
    console.error("define", e);
    return res.json({
      definition: mockDefine(clipped),
      mock: true,
      reason: "Server error — using local fallback",
    });
  }
});

export default router;
