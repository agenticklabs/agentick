/**
 * `spyClientTransport` — a Meszaros SPY over the two wire primitives a client
 * handle touches: it RECORDS every `request(method, params)` (the write/read-RPC
 * side) and drives a single push-controlled `subscribe` stream you `emit` frames
 * onto (the subscription side the read views fold). It is the one test double
 * the four scattered client suites each re-rolled (`pushStream` + a `request`
 * recorder); homed here so the handle-conformance closures and the slices 3+
 * refactors share it.
 *
 * Deliberately minimal — it satisfies the `Pick<ClientTransport, "subscribe" |
 * "request">` surface the handle command-clients actually consume, not the full
 * `ClientTransport` (connect/capabilities/progress/onStateChange are irrelevant
 * to a handle unit test). Single-subscription by design: a handle opens one
 * feed; `emit` pushes onto it.
 *
 * @see docs/proposals/v2/client-handles.md §4 (the write-verb spy)
 */

import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  WireMethod,
  WireParams,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";

/** One recorded wire request. */
export interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

/** What `subscribe` was called with (bound-addressing assertions read this). */
export interface RecordedSubscribe {
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  readonly fromCursor?: Cursor;
}

export interface SpyClientTransport {
  /** The `Pick<ClientTransport, "subscribe" | "request">` surface handles consume. */
  readonly transport: {
    subscribe(
      scope: SubscriptionScope,
      query?: EventQuery,
      fromCursor?: Cursor,
    ): SubscriptionStream;
    request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown>;
  };
  /** Every recorded request, oldest first. */
  requests(): readonly RecordedRequest[];
  /** The most recent request, or `undefined` if none. */
  lastRequest(): RecordedRequest | undefined;
  /** The recorded `subscribe` call args, or `undefined` if never opened. */
  subscribeCall(): RecordedSubscribe | undefined;
  /**
   * Push one frame onto the open subscription (models the server's snapshot +
   * delta frames). `channel` names the `session:channel:<x>` the frame rides.
   */
  emit(channel: string, payload: unknown): void;
  /** End the subscription stream cleanly (iterator terminates). */
  endStream(): void;
  /** Whether the handle has closed the subscription. */
  isStreamClosed(): boolean;
}

/**
 * Options seeding the spy's canned request answers. `respondWith` maps a wire
 * method to the value its `request` resolves; a method with no entry resolves
 * `null` (the JSON-RPC "accepted, no body" default). `rejectWith` maps a method
 * to an error the request rejects with (takes precedence).
 */
export interface SpyClientTransportOptions {
  readonly respondWith?: Readonly<Record<string, unknown>>;
  readonly rejectWith?: Readonly<Record<string, unknown>>;
}

export function spyClientTransport(opts: SpyClientTransportOptions = {}): SpyClientTransport {
  const requests: RecordedRequest[] = [];
  let subscribeCall: RecordedSubscribe | undefined;

  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let ended = false;
  let closed = false;
  let seq = 0;

  const stream: SubscriptionStream = {
    subscriptionId: "spy-sub",
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (ended || closed) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      let w: ((r: IteratorResult<EventFrame>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
  };

  return {
    transport: {
      subscribe(scope, query, fromCursor): SubscriptionStream {
        subscribeCall = { scope, query, fromCursor };
        return stream;
      },
      request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        requests.push({ method, params });
        if (opts.rejectWith && method in opts.rejectWith) {
          return Promise.reject(opts.rejectWith[method]);
        }
        return Promise.resolve(opts.respondWith?.[method] ?? null);
      },
    },
    requests: () => requests,
    lastRequest: () => requests[requests.length - 1],
    subscribeCall: () => subscribeCall,
    emit(channel, payload): void {
      const frame: EventFrame = {
        cursor: { value: ++seq } as Cursor,
        envelope: {
          id: `spy-e${seq}`,
          surface: "session",
          name: channelEventName(channel),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: frame, done: false });
      else buffer.push(frame);
    },
    endStream(): void {
      ended = true;
      let w: ((r: IteratorResult<EventFrame>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
    isStreamClosed: () => closed,
  };
}
