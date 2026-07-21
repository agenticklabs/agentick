/**
 * `eventStream` — the ground-floor read primitive over ANY session-event
 * subscription: an ordered stream of frame payloads (`envelope.payload`)
 * matching an arbitrary {@link EventQuery} on a {@link SubscriptionScope}.
 * Materializes NOTHING, so it is the general construct for any state shape —
 * a channel (snapshot-first then deltas), a command-lifecycle projection (the
 * timeline `fold`), a request/event feed.
 *
 * {@link channelStream} is `eventStream` pinned to `channelEventQuery(channel)`;
 * every typed read surface bottoms out here.
 *
 * SINGLE-CONSUMER, like the transport subscription it wraps: consume it ONCE —
 * `for await (const frame of stream)` OR `stream.onChange(cb)` (which drives the
 * same underlying iteration). For MANY observers, use {@link eventView} (it
 * single-consumes a stream and fans state out to many listeners), or open a
 * second `eventStream`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages-next/client-core/src/__tests__/event-view.spec.ts
 */

import type {
  ChannelStream,
  ClientTransport,
  Cursor,
  EventQuery,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec-next";

export type { ChannelStream } from "@agentick/spec-next";

/** Minimal client surface an event stream/view needs. */
export interface EventClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/**
 * Open a frame stream for `query` on `scope`. Yields each frame's
 * `envelope.payload` (typed `F`); frames with an `undefined` payload are
 * skipped. An optional `fromCursor` resumes the live tail from AFTER a point
 * already seen by the caller (threaded straight into `transport.subscribe`).
 */
export function eventStream<F = unknown>(
  client: EventClient,
  scope: SubscriptionScope,
  query: EventQuery,
  fromCursor?: Cursor,
): ChannelStream<F> {
  const sub = client.transport.subscribe(scope, query, fromCursor);

  async function* iterate(): AsyncGenerator<F> {
    for await (const frame of sub) {
      const payload = frame.envelope.payload;
      if (payload !== undefined) yield payload as F;
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    onChange(listener: (frame: F) => void): Unsubscribe {
      // Sugar: drive the iteration and hand each frame to the listener. Shares
      // the single underlying subscription (single-consumer contract).
      let active = true;
      void (async () => {
        for await (const frame of iterate()) {
          if (!active) break;
          try {
            listener(frame);
          } catch {
            // Isolate listener faults — one bad reaction can't stop delivery.
          }
        }
      })();
      return () => {
        active = false;
      };
    },
    close(): void {
      void sub.close();
    },
  };
}
