/**
 * `knobsHandle` — the client-side knobs resource handle (read + write).
 *
 * Read half: reuses the `pushStream` fake (from `knobs-state-view.spec.ts`)
 * to seed a snapshot and fold deltas, proving `get`/`subscribe` still work.
 * Write half: `set(key, value)` issues `transport.request("knobs/set", ...)`
 * with the wire-shaped params. And the CQRS round-trip: after `set`, emitting
 * a matching `knobs-state` delta re-folds the view — the handle never
 * hand-patches its own read state.
 */

import { describe, expect, it } from "vitest";
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
import { waitFor } from "@agentick/utils-next/testing";

import { knobsHandle } from "../knobs-handle.js";
import { KNOBS_STATE_CHANNEL, type KnobsStateFrame } from "../../channel.js";

/** A push-driven subscription stream a test emits knobs-state frames onto. */
function pushStream(): SubscriptionStream & { emit(frame: KnobsStateFrame): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(frame: KnobsStateFrame): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName(KNOBS_STATE_CHANNEL),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload: frame,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {},
  };
}

/** Fake command client: real subscribe stream + a `request` recorder. */
function fakeCommandClient(
  stream: SubscriptionStream,
  captured: { method?: WireMethod; params?: unknown } = {},
) {
  return {
    transport: {
      subscribe(_scope: SubscriptionScope, _query?: EventQuery): SubscriptionStream {
        return stream;
      },
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.method = method;
        captured.params = params;
        return null;
      },
    },
  };
}

describe("knobsHandle", () => {
  it("set() issues transport.request('knobs/set', { sessionId, key, value })", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const handle = knobsHandle(fakeCommandClient(pushStream(), captured), "s1");

    await handle.set("temperature", 0.9);

    expect(captured.method).toBe("knobs/set");
    expect(captured.params).toEqual({ sessionId: "s1", key: "temperature", value: 0.9 });
  });

  it("read half: snapshot seeds get(), then a delta re-folds the view (CQRS round-trip)", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const stream = pushStream();
    const handle = knobsHandle(fakeCommandClient(stream, captured), "s1");

    // Snapshot seeds the read half.
    stream.emit({ kind: "snapshot", version: 1, values: { temperature: 0.7 }, descriptors: [] });
    await waitFor(() => Object.keys(handle.get()).length > 0);
    expect(handle.get()).toEqual({ temperature: 0.7 });

    // Write command — no local hand-patch, so the view is still 0.7 here.
    await handle.set("temperature", 0.9);
    expect(handle.get()).toEqual({ temperature: 0.7 });

    // The write's effect returns as a channel delta and re-folds the view.
    stream.emit({
      kind: "delta",
      version: 2,
      ops: [{ op: "replace", path: "/temperature", value: 0.9 }],
    });
    await waitFor(() => handle.get().temperature === 0.9);
    expect(handle.get()).toEqual({ temperature: 0.9 });
  });

  it("subscribe() notifies on channel updates", async () => {
    const stream = pushStream();
    const handle = knobsHandle(fakeCommandClient(stream), "s1");

    let notified = 0;
    handle.subscribe(() => {
      notified += 1;
    });

    stream.emit({ kind: "snapshot", version: 1, values: { temperature: 0.7 }, descriptors: [] });
    await waitFor(() => notified > 0);
    expect(notified).toBeGreaterThan(0);
  });
});
