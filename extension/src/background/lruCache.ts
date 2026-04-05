type CacheNode<V> = {
  key: string;
  value: V;
  expiresAt: number;
  prev: CacheNode<V> | null;
  next: CacheNode<V> | null;
};

export class LruCache<V> {
  private readonly map = new Map<string, CacheNode<V>>();
  private head: CacheNode<V> | null = null;
  private tail: CacheNode<V> | null = null;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;

    if (node.expiresAt > 0 && Date.now() > node.expiresAt) {
      this.deleteNode(node);
      this.map.delete(key);
      return undefined;
    }

    this.moveToHead(node);
    return node.value;
  }

  set(key: string, value: V, ttlMs = 0): void {
    const existing = this.map.get(key);
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;

    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.moveToHead(existing);
      return;
    }

    const node: CacheNode<V> = {
      key,
      value,
      expiresAt,
      prev: null,
      next: null,
    };

    this.map.set(key, node);
    this.insertAtHead(node);
    this.evictIfNeeded();
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.capacity && this.tail) {
      const doomed = this.tail;
      this.deleteNode(doomed);
      this.map.delete(doomed.key);
    }
  }

  private moveToHead(node: CacheNode<V>): void {
    if (this.head === node) return;
    this.deleteNode(node);
    this.insertAtHead(node);
  }

  private insertAtHead(node: CacheNode<V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private deleteNode(node: CacheNode<V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
    if (this.head === node) {
      this.head = node.next;
    }
    if (this.tail === node) {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }
}

export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
