/**
 * `MultiplexedStream<T>` — the AsyncIterable shared between subscription
 * and progress streams across every transport.
 *
 * A single WebSocket / HTTP connection multiplexes N concurrent
 * subscription streams + M progress streams; each gets its own
 * `MultiplexedStream<EventFrame>` keyed by `subscriptionId` /
 * `progressToken`. The transport pushes frames in; consumers iterate.
 *
 * Backpressure policy applies when a slow consumer falls behind a
 * fast producer. The default is `"unbounded"` — preserves prior
 * behavior. Adopters override per-stream:
 *
 *   - `"unbounded"` (default) — never drops; risk of OOM for hostile producers
 *   - `"drop-oldest"`         — bounded buffer; oldest values evicted on overflow
 *   - `"drop-newest"`         — bounded buffer; new values dropped on overflow
 *   - `"close-on-overflow"`   — bounded buffer; stream terminates with
 *                               `{ kind: "backpressure" }` on overflow
 *
 * Drop callbacks (`onDrop`) fire on each evicted value so adopters can
 * observe loss; `onOverflow` fires once when the stream terminates
 * under `"close-on-overflow"`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy src/__tests__/multiplexed-stream-backpressure.spec.ts
 */

interface PendingNext<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (e: unknown) => void;
}

export type BackpressurePolicy = "unbounded" | "drop-oldest" | "drop-newest" | "close-on-overflow";

export interface BackpressureOptions<T> {
  policy?: BackpressurePolicy;
  /**
   * Maximum buffered values. Required when `policy !== "unbounded"`.
   * Counts values held in the internal queue — values delivered
   * straight to a pending `next()` don't count against capacity.
   */
  capacity?: number;
  /** Called for each value dropped (drop-oldest / drop-newest). */
  onDrop?: (value: T) => void;
  /**
   * Called once when the stream terminates under `close-on-overflow`,
   * with the value that triggered the overflow.
   */
  onOverflow?: (value: T) => void;
}

export interface BackpressureError {
  readonly kind: "backpressure";
  readonly message: string;
  readonly streamId: string;
}

export class MultiplexedStream<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: PendingNext<T>[] = [];
  private terminated = false;
  private error: unknown = null;
  private readonly policy: BackpressurePolicy;
  private readonly capacity: number;
  private readonly onDrop: ((value: T) => void) | undefined;
  private readonly onOverflow: ((value: T) => void) | undefined;
  private droppedCount = 0;

  constructor(
    public readonly id: string,
    private readonly onClose: () => Promise<void>,
    backpressure: BackpressureOptions<T> = {},
  ) {
    this.policy = backpressure.policy ?? "unbounded";
    if (this.policy !== "unbounded") {
      if (
        backpressure.capacity === undefined ||
        backpressure.capacity <= 0 ||
        !Number.isFinite(backpressure.capacity)
      ) {
        throw new Error(
          `MultiplexedStream(${id}): policy "${this.policy}" requires a finite positive capacity`,
        );
      }
      this.capacity = backpressure.capacity;
    } else {
      this.capacity = Number.POSITIVE_INFINITY;
    }
    this.onDrop = backpressure.onDrop;
    this.onOverflow = backpressure.onOverflow;
  }

  /** Number of values dropped under `drop-oldest` / `drop-newest`. */
  get dropped(): number {
    return this.droppedCount;
  }

  push(value: T): void {
    if (this.terminated) return;
    const r = this.resolvers.shift();
    if (r) {
      r.resolve({ value, done: false });
      return;
    }
    if (this.policy === "unbounded" || this.buffer.length < this.capacity) {
      this.buffer.push(value);
      return;
    }
    // Capacity reached. Apply policy.
    switch (this.policy) {
      case "drop-oldest": {
        const evicted = this.buffer.shift()!;
        this.droppedCount++;
        this.onDrop?.(evicted);
        this.buffer.push(value);
        return;
      }
      case "drop-newest": {
        this.droppedCount++;
        this.onDrop?.(value);
        return;
      }
      case "close-on-overflow": {
        this.onOverflow?.(value);
        const err: BackpressureError = {
          kind: "backpressure",
          message: `MultiplexedStream(${this.id}) overflowed capacity ${this.capacity}`,
          streamId: this.id,
        };
        void this.end(err);
        return;
      }
    }
  }

  /**
   * Terminate the stream. When `error` is non-null, pending `next()`
   * calls reject with `error` and subsequent `next()` calls re-throw
   * `error`. When `error` is null, pending and subsequent `next()`
   * calls resolve to `{ done: true }` cleanly.
   */
  async end(error: unknown): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.error = error;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      if (error !== null) {
        r.reject(error);
      } else {
        r.resolve({ value: undefined as unknown as T, done: true });
      }
    }
  }

  async close(): Promise<void> {
    if (this.terminated) return;
    await this.end(null);
    await this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        // Drain buffered values first — applies even after termination so
        // a close-on-overflow consumer sees the values held before the
        // overflow triggered. The error / done signal surfaces only once
        // the buffer is empty.
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.error !== null) return Promise.reject(this.error);
        if (this.terminated) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
      },
      return: async () => {
        await this.close();
        return { value: undefined as unknown as T, done: true };
      },
    };
  }
}
