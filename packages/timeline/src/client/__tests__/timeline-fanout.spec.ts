/**
 * `session.timeline.view(opts)` — the VIEW FACTORY fan-out on the timeline handle
 * (B2 slice 4). The canonical proof: minting TWO views over one handle opens
 * exactly ONE wire subscription (`transport.subscribe` called once), both views
 * fold the same live append, each applies its own filter, and they close
 * independently while the handle's `close()` tears them all down.
 *
 * @see docs/proposals/v2/guide-wire-and-client.md §2
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  TimelineAppendInput,
  TimelineEntry,
  WireMethod,
  WireParams,
} from "@agentick/spec";
import { TIMELINE_APPEND_EVENT_NAME } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { timelineHandle } from "../timeline-handle.js";

function entry(id: string, visibility?: TimelineEntry["visibility"]): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
    ...(visibility ? { visibility } : {}),
  };
}

const ids = (window: readonly TimelineEntry[]): string[] =>
  window.map((e) => (e.kind === "message" ? e.message.id : "boundary"));

/** A push stream + a transport that COUNTS how many times `subscribe` is called. */
function countingClient(): {
  transport: {
    subscribe(s: SubscriptionScope, q?: EventQuery): SubscriptionStream;
    request<M extends WireMethod>(m: M, p: WireParams<M>): Promise<unknown>;
  };
  emit(input: TimelineAppendInput): void;
  subscribeCount(): number;
} {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  let subscribeCount = 0;
  const stream: SubscriptionStream = {
    subscriptionId: "sub-test",
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {},
  };
  return {
    transport: {
      subscribe(_s, _q): SubscriptionStream {
        subscribeCount++;
        return stream;
      },
      async request(): Promise<unknown> {
        return null; // loadOlder is not exercised in the fan-out proof
      },
    },
    emit(input: TimelineAppendInput): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "timeline",
          name: TIMELINE_APPEND_EVENT_NAME,
          phase: "requested",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload: input,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    subscribeCount: () => subscribeCount,
  };
}

describe("session.timeline.view — fan-out (one wire subscription per topic)", () => {
  it("two minted views share ONE subscription and both fold the live append", async () => {
    const client = countingClient();
    const handle = timelineHandle(client, "s1");

    const all = handle.view();
    const modelOnly = handle.view({ filter: (e) => e.visibility === "model" });

    client.emit({ entries: [entry("m1", "model"), entry("o1", "observer")] });
    await waitFor(() => handle.list().length > 0);

    // ONE wire subscription for the whole topic, however many views.
    expect(client.subscribeCount()).toBe(1);
    // Both views fold the same append; each applies its own filter.
    expect(ids(all.list())).toEqual(["m1", "o1"]);
    expect(ids(modelOnly.list())).toEqual(["m1"]);
  });

  it("minted views update on subscribe; close independently; handle.close tears all down", async () => {
    const client = countingClient();
    const handle = timelineHandle(client, "s1");
    const v1 = handle.view();
    const v2 = handle.view();
    let n1 = 0;
    let n2 = 0;
    v1.subscribe(() => n1++);
    v2.subscribe(() => n2++);

    client.emit({ entries: [entry("a")] });
    await waitFor(() => n1 > 0 && n2 > 0);
    expect(client.subscribeCount()).toBe(1); // still one wire subscription

    // Independent close: v1 stops, v2 keeps updating.
    v1.close();
    client.emit({ entries: [entry("b")] });
    await waitFor(() => n2 === 2);
    expect(n1).toBe(1);
    expect(ids(v2.list())).toEqual(["a", "b"]);

    // Closing the handle tears down v2 too (no further notifications).
    handle.close();
    client.emit({ entries: [entry("c")] });
    await new Promise((r) => setTimeout(r, 5));
    expect(n2).toBe(2);
  });
});
