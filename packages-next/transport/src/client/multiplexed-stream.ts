/**
 * `MultiplexedStream<T>` — the AsyncIterable shared between subscription
 * and progress streams across every transport.
 *
 * A single WebSocket / HTTP connection multiplexes N concurrent
 * subscription streams + M progress streams; each gets its own
 * `MultiplexedStream<EventFrame>` keyed by `subscriptionId` /
 * `progressToken`. The transport pushes frames in; consumers iterate.
 *
 * Unbounded queue today — backpressure (bounded queue + drop-oldest /
 * close-subscription / unbounded policy per ADR 33 rev-3) lands in
 * the 33.C hardening pass alongside transport-wide backpressure
 * design.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

interface PendingNext<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (e: unknown) => void;
}

export class MultiplexedStream<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: PendingNext<T>[] = [];
  private terminated = false;
  private error: unknown = null;

  constructor(
    public id: string,
    private readonly onClose: () => Promise<void>,
  ) {}

  rekey(newId: string): void {
    this.id = newId;
  }

  push(value: T): void {
    if (this.terminated) return;
    const r = this.resolvers.shift();
    if (r) {
      r.resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
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
        if (this.error !== null) return Promise.reject(this.error);
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
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
