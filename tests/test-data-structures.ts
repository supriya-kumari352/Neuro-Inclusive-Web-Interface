/**
 * Tests for newly added data structures used by the extension pipeline.
 * Run: node --import tsx tests/test-data-structures.ts
 */

import {
  ComplexWordTrie,
  detectComplexTerms,
} from "../extension/src/shared/complexWordTrie.js";
import { PriorityQueue } from "../extension/src/shared/priorityQueue.js";
import { LruCache } from "../extension/src/background/lruCache.js";

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

console.log("\n=== Data Structure Tests ===\n");

// Trie tests
{
  const trie = new ComplexWordTrie();
  trie.insertMany(["cognitive load", "executive function", "idempotency"]);

  const matches = trie.findTerms(
    "High cognitive load and executive function fatigue make dense pages hard to parse."
  );
  assert(matches.includes("cognitive load"), "Trie matches multi-word phrase");
  assert(matches.includes("executive function"), "Trie matches second phrase");

  const direct = detectComplexTerms(
    "Implementation details around idempotency and concurrency matter in distributed systems."
  );
  assert(direct.includes("idempotency"), "Default trie contains complex technical words");
}

// Priority queue tests
{
  const pq = new PriorityQueue<string>();
  pq.push({ id: "low", priority: 1, payload: "low" });
  pq.push({ id: "high", priority: 10, payload: "high" });
  pq.push({ id: "mid", priority: 5, payload: "mid" });

  const first = pq.pop();
  const second = pq.pop();
  const third = pq.pop();

  assert(first?.payload === "high", "Priority queue pops highest first");
  assert(second?.payload === "mid", "Priority queue pops second highest second");
  assert(third?.payload === "low", "Priority queue pops lowest last");
}

// LRU cache tests
{
  const cache = new LruCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert(cache.get("a") === 1, "Cache returns stored value");

  // Touch "a" so "b" becomes least recently used.
  cache.get("a");
  cache.set("c", 3);

  assert(cache.get("b") == null, "Cache evicts least recently used key");
  assert(cache.get("a") === 1, "Cache keeps recently used key");
  assert(cache.get("c") === 3, "Cache stores new key after eviction");
}

// TTL test
{
  const cache = new LruCache<string>(2);
  cache.set("ttl", "value", 1);
  const before = cache.get("ttl");
  assert(before === "value", "Cache value available before expiry");

  setTimeout(() => {
    const after = cache.get("ttl");
    assert(after == null, "Cache expires value after TTL");

    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
  }, 5);
}
