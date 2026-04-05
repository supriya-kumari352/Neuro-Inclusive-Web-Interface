import fs from "node:fs/promises";

const API_BASE = (process.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const INPUT_FILE = "docs/evaluation/synthetic-suite.json";
const OUT_FILE = "docs/evaluation/latest-results.json";
const REQUEST_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 12000);

function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function splitSentences(text) {
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 2) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.endsWith("e")) n = Math.max(1, n - 1);
  return n;
}

function metrics(text) {
  const words = splitWords(text);
  const sents = splitSentences(text);
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const avgWps = words.length / Math.max(sents.length, 1);
  const avgSyl = syllables / Math.max(words.length, 1);
  const complexity = avgWps * 0.7 + avgSyl * 20;
  return { words: words.length, sents: sents.length, avgWps, avgSyl, complexity };
}

function percentDelta(before, after) {
  if (before === 0) return 0;
  return ((after - before) / before) * 100;
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(path, body) {
  let r;
  try {
    r = await fetchWithTimeout(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out for ${path} after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${path} failed: ${r.status} ${text || r.statusText}`);
  }
  return await r.json();
}

async function checkApiPreflight() {
  let r;
  try {
    r = await fetchWithTimeout(`${API_BASE}/health`, { method: "GET" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`API preflight timed out after ${REQUEST_TIMEOUT_MS}ms at ${API_BASE}/health`);
    }
    throw new Error(`API preflight failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!r.ok) {
    throw new Error(`API preflight failed: /health returned ${r.status}`);
  }
  const j = await r.json().catch(() => null);
  if (!j || j.ok !== true) {
    throw new Error("API preflight failed: invalid /health response");
  }
}

async function simplify(text) {
  const j = await postJson("/api/simplify", { text });
  if (typeof j?.simplified !== "string") {
    throw new Error("Invalid simplify response shape");
  }
  return j.simplified;
}

async function summarize(text, mode) {
  const j = await postJson("/api/summarize", { text, mode });
  if (typeof j?.summary !== "string") {
    throw new Error("Invalid summarize response shape");
  }
  return j.summary;
}

async function main() {
  await checkApiPreflight();

  const suite = JSON.parse(await fs.readFile(INPUT_FILE, "utf8"));
  const perCase = [];
  let passed = 0;

  for (const item of suite) {
    const before = metrics(item.input);
    const simplified = await simplify(item.input);
    const after = metrics(simplified);
    const tldr = await summarize(item.input, "tldr");

    const cDelta = percentDelta(before.complexity, after.complexity);
    const wpsDelta = percentDelta(before.avgWps, after.avgWps);
    const improved = cDelta < -8 || wpsDelta < -8;
    if (improved) passed++;

    perCase.push({
      id: item.id,
      category: item.category,
      improved,
      inputMetrics: before,
      outputMetrics: after,
      complexityDeltaPct: Number(cDelta.toFixed(2)),
      avgWordsPerSentenceDeltaPct: Number(wpsDelta.toFixed(2)),
      tldrLength: splitWords(tldr).length,
      simplifiedPreview: simplified.slice(0, 180),
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    totalCases: suite.length,
    improvedCases: passed,
    improvementRate: Number(((passed / suite.length) * 100).toFixed(2)),
    meanComplexityDeltaPct: Number(
      (perCase.reduce((a, c) => a + c.complexityDeltaPct, 0) / perCase.length).toFixed(2)
    ),
    meanAvgWordsPerSentenceDeltaPct: Number(
      (perCase.reduce((a, c) => a + c.avgWordsPerSentenceDeltaPct, 0) / perCase.length).toFixed(2)
    ),
    failureCriteria: "Case is not improved if complexity and sentence length both reduce by <8%",
  };

  await fs.writeFile(OUT_FILE, JSON.stringify({ summary, perCase }, null, 2), "utf8");
  console.log(`Saved evaluation output to ${OUT_FILE}`);
  console.log(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
