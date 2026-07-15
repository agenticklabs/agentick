/**
 * `channelStream` — the ground-floor read primitive: a channel's ordered stream
 * of frames (`envelope.payload`), snapshot-first then deltas. Materializes
 * NOTHING, so it is the general construct for any state shape — a small value,
 * a large collection, a paginated feed, or a request/event channel. Every typed
 * read surface (including {@link channelView}) bottoms out here.
 *
 * SINGLE-CONSUMER, like the transport subscription it wraps: consume it ONCE —
 * `for await (const frame of stream)` OR `stream.onChange(cb)` (which drives the
 * same underlying iteration). For MANY observers, use {@link channelView} (it
 * single-consumes a stream and fans state out to many listeners), or open a
 * second `channelStream`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages-next/client-core/src/__tests__/channel-stream.spec.ts
 */

import type {
  ChannelStream,
  ClientTransport,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec-next";
import { channelEventQuery } from "@agentick/spec-next";

export type { ChannelStream } from "@agentick/spec-next";

/** Minimal client surface a channel stream/view needs. */
export interface ChannelClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/**
 * Open a channel's frame stream. Yields each frame's `envelope.payload` (typed
 * `F`); frames with an `undefined` payload are skipped.
 */
export function channelStream<F = unknown>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
): ChannelStream<F> {
  const sub = client.transport.subscribe(scope, channelEventQuery(channel));

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
