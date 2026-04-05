export type TrieMatch = {
  term: string;
  startIndex: number;
  endIndex: number;
};

type TrieNode = {
  children: Map<string, TrieNode>;
  terminal?: string;
};

function newNode(): TrieNode {
  return { children: new Map<string, TrieNode>() };
}

export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9'-]/g, "").trim();
}

export function tokenizeText(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/\s+/)
    .map((w) => normalizeToken(w))
    .filter(Boolean);
}

export class ComplexWordTrie {
  private readonly root: TrieNode = newNode();
  private maxDepth = 1;

  insert(term: string): void {
    const tokens = tokenizeText(term);
    if (!tokens.length) return;

    this.maxDepth = Math.max(this.maxDepth, tokens.length);
    let node = this.root;
    for (const token of tokens) {
      const next = node.children.get(token);
      if (next) {
        node = next;
        continue;
      }
      const created = newNode();
      node.children.set(token, created);
      node = created;
    }
    node.terminal = tokens.join(" ");
  }

  insertMany(terms: string[]): void {
    for (const term of terms) {
      this.insert(term);
    }
  }

  scanTokens(tokens: string[]): TrieMatch[] {
    const matches: TrieMatch[] = [];
    if (!tokens.length) return matches;

    for (let start = 0; start < tokens.length; start++) {
      let node: TrieNode | undefined = this.root;
      const maxEnd = Math.min(tokens.length, start + this.maxDepth);
      for (let end = start; end < maxEnd; end++) {
        node = node?.children.get(tokens[end]);
        if (!node) break;
        if (node.terminal) {
          matches.push({
            term: node.terminal,
            startIndex: start,
            endIndex: end,
          });
        }
      }
    }

    return matches;
  }

  findTerms(text: string): string[] {
    const seen = new Set<string>();
    const tokens = tokenizeText(text);
    for (const m of this.scanTokens(tokens)) {
      seen.add(m.term);
    }
    return Array.from(seen);
  }
}

export const DEFAULT_COMPLEX_TERMS = [
  "epistemological",
  "hermeneutic",
  "metacognition",
  "interoperability",
  "asynchronous",
  "synchronization",
  "architecture",
  "microservice",
  "deterministic",
  "probabilistic",
  "computational",
  "multidisciplinary",
  "photosynthesis",
  "mitochondria",
  "neurodivergent",
  "executive function",
  "working memory",
  "cognitive load",
  "statistical significance",
  "hypothesis testing",
  "derivative",
  "integral",
  "thermodynamics",
  "electromagnetic",
  "infrastructure",
  "authentication",
  "authorization",
  "idempotency",
  "eventual consistency",
  "fault tolerance",
  "normalization",
  "decentralized",
  "quantitative",
  "qualitative",
  "paradigm",
  "ontological",
  "methodology",
  "jurisdiction",
  "liability",
  "regulatory compliance",
  "implementation details",
  "machine learning",
  "artificial intelligence",
  "circular dependency",
  "time complexity",
  "space complexity",
  "object oriented",
  "thread safety",
  "concurrency",
  "serialization",
  "deserialization",
];

const defaultTrie = new ComplexWordTrie();
defaultTrie.insertMany(DEFAULT_COMPLEX_TERMS);

export function detectComplexTerms(text: string): string[] {
  return defaultTrie.findTerms(text);
}

export function createDefaultComplexWordTrie(): ComplexWordTrie {
  const trie = new ComplexWordTrie();
  trie.insertMany(DEFAULT_COMPLEX_TERMS);
  return trie;
}
