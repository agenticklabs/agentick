/**
 * `OfflineStore` — the durable outbound queue backend.
 *
 * Default impl is in-memory; adopters wire IndexedDB / SQLite / Redis
 * for cross-restart durability.
 *
 * Operations:
 *   - `enqueue(req)` — append; assigns a monotonic `seq` for FIFO order
 *   - `drain()` — atomic move: returns + removes all current entries
 *   - `peek()` — read-only snapshot
 *   - `size()` / `clear()` — bookkeeping
 */

export interface QueuedRequest {
  readonly seq: number;
  readonly method: string;
  readonly params: unknown;
  readonly enqueuedAt: number;
}

export interface OfflineStore {
  enqueue(method: string, params: unknown): Promise<QueuedRequest>;
  drain(): Promise<readonly QueuedRequest[]>;
  peek(): Promise<readonly QueuedRequest[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryOfflineStore implements OfflineStore {
  private queue: QueuedRequest[] = [];
  private nextSeq = 1;

  constructor(private readonly maxSize: number = 10_000) {}

  async enqueue(method: string, params: unknown): Promise<QueuedRequest> {
    if (this.queue.length >= this.maxSize) {
      throw {
        kind: "backpressure",
        message: `offline queue full (max=${this.maxSize})`,
      };
    }
    const entry: QueuedRequest = {
      seq: this.nextSeq++,
      method,
      params,
      enqueuedAt: Date.now(),
    };
    this.queue.push(entry);
    return entry;
  }

  async drain(): Promise<readonly QueuedRequest[]> {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  async peek(): Promise<readonly QueuedRequest[]> {
    return this.queue.slice();
  }

  async size(): Promise<number> {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    this.queue = [];
  }
}
