/**
 * Fan ADR 64 progress SIGNALS onto a caller's progress token.
 *
 * A harness reports progress by emitting `<surface>:signal:progress` on the bus
 * — it knows nothing about wires. Reaching the caller is a subscription for the
 * life of one RPC, which is the same three moves wherever it happens: subscribe
 * filtered, push what arrives, stop when the call settles.
 *
 * `session/send` was the only caller for long enough that the moves lived
 * inline. The dynamic command lane needs them too — a compaction reports
 * progress and nothing carried it — and a second inline copy is where the two
 * would start to disagree about teardown.
 */

import type { EventQuery, ProgressStreamWriter, ProtocolEvent } from "@agentick/spec";

export interface ProgressFanout {
  /** Stop the subscription. Call when the RPC settles, success or failure. */
  stop(): void;
  /** Resolves once the stopped subscription has drained its last frame. */
  readonly drained: Promise<void>;
}

/**
 * @param admit Arrival-side filter, for subscriptions too wide to filter at the
 * bus (`fanIn`). Omit to accept everything the query matched.
 */
export function fanOutProgressSignals(
  events: (query: EventQuery) => AsyncIterable<ProtocolEvent>,
  reporter: ProgressStreamWriter,
  query: EventQuery,
  admit?: (envelope: ProtocolEvent) => boolean,
): ProgressFanout {
  const iterator = events(query)[Symbol.asyncIterator]();
  const drained = (async () => {
    try {
      for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
        const envelope = step.value;
        if (admit && !admit(envelope)) continue;
        reporter.push(envelope);
      }
    } catch {
      /* best-effort — progress is never a control path (ADR 64) */
    }
  })();
  return {
    stop: () => {
      void iterator.return?.(undefined);
    },
    drained,
  };
}
