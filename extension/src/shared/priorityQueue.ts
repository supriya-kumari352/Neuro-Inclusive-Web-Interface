export type PriorityItem<T> = {
  id: string;
  priority: number;
  payload: T;
};

/**
 * Max-heap priority queue with lazy invalidation for cheap updates.
 */
export class PriorityQueue<T> {
  private heap: Array<PriorityItem<T>> = [];
  private latestPriority = new Map<string, number>();

  size(): number {
    return this.latestPriority.size;
  }

  push(item: PriorityItem<T>): void {
    this.latestPriority.set(item.id, item.priority);
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  peek(): PriorityItem<T> | undefined {
    this.discardStaleTop();
    return this.heap[0];
  }

  pop(): PriorityItem<T> | undefined {
    this.discardStaleTop();
    if (!this.heap.length) return undefined;

    const top = this.heap[0];
    const end = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = end;
      this.bubbleDown(0);
    }
    this.latestPriority.delete(top.id);
    return top;
  }

  clear(): void {
    this.heap = [];
    this.latestPriority.clear();
  }

  snapshot(limit: number): PriorityItem<T>[] {
    const copy = new PriorityQueue<T>();
    for (const it of this.heap) {
      const latest = this.latestPriority.get(it.id);
      if (latest == null) continue;
      copy.push({ ...it, priority: latest });
    }

    const out: PriorityItem<T>[] = [];
    while (out.length < limit) {
      const next = copy.pop();
      if (!next) break;
      out.push(next);
    }
    return out;
  }

  private discardStaleTop(): void {
    while (this.heap.length) {
      const top = this.heap[0];
      const latest = this.latestPriority.get(top.id);
      if (latest == null) {
        this.removeTopAndHeapify();
        continue;
      }
      if (latest !== top.priority) {
        this.removeTopAndHeapify();
        continue;
      }
      return;
    }
  }

  private removeTopAndHeapify(): void {
    const end = this.heap.pop();
    if (!end || this.heap.length === 0) {
      return;
    }
    this.heap[0] = end;
    this.bubbleDown(0);
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priority >= this.heap[i].priority) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private bubbleDown(index: number): void {
    let i = index;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let largest = i;

      if (left < this.heap.length && this.heap[left].priority > this.heap[largest].priority) {
        largest = left;
      }
      if (right < this.heap.length && this.heap[right].priority > this.heap[largest].priority) {
        largest = right;
      }
      if (largest === i) return;
      this.swap(i, largest);
      i = largest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmp;
  }
}
