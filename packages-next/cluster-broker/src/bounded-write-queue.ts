/**
 * Per-connection bounded outbound queue. The broker's fan-out path
 * (broadcasts, unicasts, membership deltas) enqueues frames here
 * instead of `await conn.send(...)`-ing directly. A background drain
 * loop pulls one frame at a time and awaits its send.
 *
 * Why: pre-bounded-queue, the broker did `await conn.send(...)` in a
 * sequential loop across all clients during fan-out. ONE slow client
 * (whose kernel socket buffer was full + drain pending) blocked
 * delivery to every other client. Under broadcast pressure with even
 * one stuck consumer, the broker would degrade catastrophically.
 *
 * What this fixes:
 *
 *   - Slow client no longer blocks broker fan-out — each client has
 *     its own queue + drain task; one queue stalling is local.
 *   - Bounded memory: a slow client falling behind doesn't grow the
 *     broker's heap unbounded. The queue caps at `maxQueueSize`.
 *   - Overflow policy: when full, drop OLDEST frame + emit a
 *     diagnostic. Drop-oldest preserves event ordering for the
 *     surviving frames (recent state) at the cost of stale frames
 *     (which would have been most outdated anyway).
 *
 * What this does NOT do:
 *
 *   - No reconnect-on-drop. The bounded queue assumes a slow client
 *     who will catch up. Adopters needing at-least-once delivery
 *     wire it through a higher-level reliable channel
 *     (DurableJournal, ack/retry).
 *   - No fair scheduling across queues. Each queue drains
 *     independently; the broker spawns one drain task per
 *     connection.
 *
 * @see ./base-broker.ts — `ConnectedClient.writeQueue` integration
 */

import type { Connection } from "./connection.js";

export interface BoundedWriteQueueOptions<T> {
  readonly conn: Connection;
  /** Encode a queued frame into bytes for the wire. */
  readonly encode: (frame: T) => Uint8Array;
  /**
   * Maximum frames buffered before drop-oldest overflow. Default 1024;
   * tune via {@link BaseBrokerOptions.maxQueueSize}. A 1024 frame queue
   * at 500 byte avg event size = ~500KB pending per connection,
   * generous for normal operation, bounded for slow-client scenarios.
   */
  readonly maxQueueSize: number;
  /**
   * Called when a frame is dropped due to queue overflow. The broker
   * routes this to `cluster:broker:server:backpressure-drop` so
   * adopters can monitor + alert.
   */
  readonly onOverflow?: (dropped: T, queueDepthAfterDrop: number) => void;
  /**
   * Called when `conn.send` rejects during drain. Drain stops; the
   * broker's connection-level error handling takes over (usually
   * disconnect + cleanup).
   */
  readonly onSendError?: (err: unknown) => void;
}

/**
 * Bounded write queue. Synchronous enqueue, asynchronous drain.
 * Thread-safe in the sense that JS is single-threaded — the drain
 * loop's await yields between iterations so concurrent enqueues from
 * the same microtask boundary are interleaved correctly.
 */
export class BoundedWriteQueue<T> {
  private readonly queue: T[] = [];
  private draining = false;
  private closed = false;
  private readonly opts: BoundedWriteQueueOptions<T>;

  constructor(opts: BoundedWriteQueueOptions<T>) {
    this.opts = opts;
  }

  /**
   * Synchronously enqueue a frame. Returns immediately. The drain
   * task picks it up on the next tick. If the queue is full, the
   * OLDEST frame is dropped (overflow handler invoked) and the new
   * frame is appended.
   */
  enqueue(frame: T): void {
    if (this.closed) return;
    if (this.queue.length >= this.opts.maxQueueSize) {
      const dropped = this.queue.shift() as T;
      this.opts.onOverflow?.(dropped, this.queue.length);
    }
    this.queue.push(frame);
    if (!this.draining) {
      // queueMicrotask vs immediate start: enqueue stays sync, drain
      // proceeds on next microtask. Allows a batch of enqueues from
      // the same call frame to all land before drain starts.
      this.draining = true;
      queueMicrotask(() => {
        void this.drainLoop();
      });
    }
  }

  /** Current queue depth — diagnostic accessor. */
  get depth(): number {
    return this.queue.length;
  }

  /**
   * Stop accepting new frames and drop any pending ones. Idempotent.
   * Called by the broker on connection close. Does NOT await an
   * in-flight drain — the drain loop exits on its next iteration
   * because `closed` is checked there.
   *
   * For graceful close (SIGTERM, broker shutdown) where pending
   * frames SHOULD be delivered before tear-down, use {@link flush}
   * first, THEN `close()`.
   */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  /**
   * Wait for the queue to drain (or until `timeoutMs` elapses).
   * Resolves when `depth === 0` OR the queue is closed. Used by the
   * broker's graceful-close path: enqueue final frames (Goodbye), then
   * await flush, then close.
   *
   * Without flush, the broker's `close()` would tear down the
   * listener while Goodbye frames sit unsent in queues — clients
   * would observe an abrupt remote-abort instead of a clean farewell.
   *
   * Cooperative — does NOT force-drain. If `conn.send` is genuinely
   * stuck (slow remote, dead socket), flush blocks up to `timeoutMs`
   * (default 5000ms) and then returns; pending frames are dropped
   * when `close()` runs after.
   */
  async flush(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    if (this.queue.length === 0 && !this.draining) return;
    const start = Date.now();
    while (this.queue.length > 0 || this.draining) {
      if (this.closed) return;
      if (Date.now() - start > timeoutMs) return;
      // 1ms tick. Short enough that flush is responsive; long enough
      // not to thrash the event loop. The drain loop yields between
      // sends so this tick is well-aligned.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }

  private async drainLoop(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.closed) {
        const frame = this.queue.shift() as T;
        const bytes = this.opts.encode(frame);
        try {
          await this.opts.conn.send(bytes);
        } catch (err) {
          this.opts.onSendError?.(err);
          // Drain stops; the connection is broken. Broker-level
          // disconnect handler will fire and close the queue.
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
