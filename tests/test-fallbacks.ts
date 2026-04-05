/**
 * Tests for offline fallback helpers used when API/model is unavailable.
 * Run: node --import tsx tests/test-fallbacks.ts
 */

import {
  localDefine,
  localSimplify,
  localSummarize,
} from "../extension/src/shared/localAiFallback.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("\n=== Fallback Tests ===\n");

// Simplify should shorten very long sentences.
{
  const longSentence =
    "This sentence contains many words intended to exceed the simplifier threshold so it should be shortened by the fallback logic for better readability and demo stability.";
  const simplified = localSimplify(longSentence);
  assert(typeof simplified === "string", "localSimplify returns string");
  assert(simplified.length > 0, "localSimplify returns non-empty text");
  assert(
    simplified.split(/\s+/).length < longSentence.split(/\s+/).length,
    "localSimplify shortens long sentences"
  );
}

// TL;DR summary should provide fallback text for empty content.
{
  const summary = localSummarize("   ", "tldr");
  assert(summary === "No content to summarize.", "TL;DR handles empty text safely");
}

// Bullet summary should emit bullet lines.
{
  const text = "One point here. Another point there. Third point now.";
  const summary = localSummarize(text, "bullets");
  const lines = summary.split("\n").filter(Boolean);
  assert(lines.length > 0, "Bullet summary produces at least one line");
  assert(lines.every((line) => line.startsWith("- ")), "Bullet summary lines start with '- '");
}

// localDefine should handle empty and normal terms.
{
  const empty = localDefine("   ");
  assert(
    empty.includes("Select a word or short phrase"),
    "localDefine handles empty selection"
  );

  const defined = localDefine("metacognition");
  assert(defined.includes("Offline"), "localDefine labels offline mode");
  assert(defined.includes("metacognition"), "localDefine includes selected term");
}

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
