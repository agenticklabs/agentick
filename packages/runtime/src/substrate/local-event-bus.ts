/**
 * In-process EventBus implementation.
 *
 * Pure pub/sub. Per-subscriber bounded buffer with configurable overflow
 * strategy (drop-oldest/drop-newest/error). Lazy fan-out: publish is a
 * no-op when no subscriber's query matches the envelope.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 */

import type { EventQuery, ProtocolEvent } from "@agentick/spec";
import type {
  EventBus,
  SubscribeOptions,
  SubscriberOverflow,
} from "@agentick/spec";
import { BufferOverflowError } from "@agentick/spec";
import { matchesQuery } from "./query.js";

type PendingOutcome =
  | { readonly kind: "event"; readonly event: ProtocolEvent }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly error: Error };

interface Subscriber {
  readonly id: number;
  readonly query: EventQuery;
  readonly bufferSize: number;
  readonly overflow: SubscriberOverflow;
  readonly buffer: ProtocolEvent[];
  readonly signal?: AbortSignal;
  /** Resolver for an in-flight `next()` call awaiting an event. */
  pending?: (outcome: PendingOutcome) => void;
  /** When set, the next `next()` call throws this and the iterable ends. */
  pendingError?: Error;
  closed: boolean;
}

export class LocalEventBus implements EventBus {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 0;
  private closed = false;

  async publish(event: ProtocolEvent): Promise<void> {
    if (this.closed) return;
    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      if (!matchesQuery(event, sub.query)) continue;
      this.deliver(sub, event);
    }
  }

  subscribe(query: EventQuery, options: SubscribeOptions = {}): AsyncIterable<ProtocolEvent> {
    if (this.closed) {
      return emptyAsyncIterable();
    }
    const id = this.nextId++;
    const sub: Subscriber = {
      id,
      query,
      bufferSize: options.bufferSize ?? 256,
      overflow: options.overflow ?? "drop-oldest",
      buffer: [],
      signal: options.signal,
      closed: false,
    };
    this.subscribers.set(id, sub);

    const bus = this;
    const onAbort = () => bus.closeSubscriber(sub);
    sub.signal?.addEventListener("abort", onAbort, { once: true });

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ProtocolEvent>> {
            if (sub.pendingError) {
              const err = sub.pendingError;
              sub.pendingError = undefined;
              bus.closeSubscriber(sub);
              throw err;
            }
            if (sub.buffer.length > 0) {
              return { value: sub.buffer.shift()!, done: false };
            }
            if (sub.closed) {
              return { value: undefined, done: true };
            }
            const outcome = await new Promise<PendingOutcome>((resolve) => {
              sub.pending = resolve;
            });
            if (outcome.kind === "done") return { value: undefined, done: true };
            if (outcome.kind === "error") {
              bus.closeSubscriber(sub);
              throw outcome.error;
            }
            return { value: outcome.event, done: false };
          },
          async return(): Promise<IteratorResult<ProtocolEvent>> {
            sub.signal?.removeEventListener("abort", onAbort);
            bus.closeSubscriber(sub);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /** Close all subscribers. Test helper. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers.values()) this.closeSubscriber(sub);
  }

  /** Diagnostic: count of active subscribers. */
  subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) if (!s.closed) n++;
    return n;
  }

  // ────────── helpers ──────────

  private deliver(sub: Subscriber, event: ProtocolEvent): void {
    if (sub.pending) {
      const resolve = sub.pending;
      sub.pending = undefined;
      resolve({ kind: "event", event });
      return;
    }
    if (sub.buffer.length >= sub.bufferSize) {
      switch (sub.overflow) {
        case "drop-oldest":
          sub.buffer.shift();
          sub.buffer.push(event);
          return;
        case "drop-newest":
          return;
        case "error":
          sub.pendingError = new BufferOverflowError(sub.bufferSize);
          return;
      }
    }
    sub.buffer.push(event);
  }

  private closeSubscriber(sub: Subscriber): void {
    if (sub.closed) return;
    sub.closed = true;
    this.subscribers.delete(sub.id);
    if (sub.pending) {
      const r = sub.pending;
      sub.pending = undefined;
      r({ kind: "done" });
    }
  }
}

async function* emptyAsyncIterable(): AsyncIterable<ProtocolEvent> {
  // intentionally empty
  return;
}
