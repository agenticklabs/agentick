/**
 * `knobsHandle` — the client-side knobs resource handle on the `ClientHandle`
 * contract.
 *
 * Read half: `list()` returns DESCRIPTORS+values seeded from the snapshot frame
 * (friction #1), `get(id)` looks one up, deltas re-fold the values doc.
 * Write half: `set(id, value)` issues `transport.request("knobs/set", ...)` with
 * the wire-shaped `{ sessionId, id, value }` params (friction #13). And the CQRS
 * round-trip: after `set`, emitting a matching `knobs-state` delta re-folds the
 * view — the handle never hand-patches its own read state.
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
  it("set() issues transport.request('knobs/set', { sessionId, id, value })", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const handle = knobsHandle(fakeCommandClient(pushStream(), captured), "s1");

    await handle.set("temperature", 0.9);

    expect(captured.method).toBe("knobs/set");
    expect(captured.params).toEqual({ sessionId: "s1", id: "temperature", value: 0.9 });
  });

  it("list() returns DESCRIPTORS+values from the snapshot; get(id) looks one up", async () => {
    const stream = pushStream();
    const handle = knobsHandle(fakeCommandClient(stream), "s1");

    stream.emit({
      kind: "snapshot",
      version: 1,
      values: { temperature: 0.7 },
      descriptors: [
        { id: "temperature", value: 0.7, valueType: "number", min: 0, max: 1, description: "Temp" },
      ],
    });
    await waitFor(() => handle.list().length > 0);

    // Descriptors, not bare values (friction #1) — declared metadata rides through.
    expect(handle.list()).toMatchObject([
      { id: "temperature", value: 0.7, min: 0, max: 1, description: "Temp" },
    ]);
    expect(handle.get("temperature")).toMatchObject({ id: "temperature", value: 0.7, max: 1 });
    expect(handle.get("nope")).toBeUndefined();
  });

  it("read half: snapshot seeds, a delta re-folds the value (CQRS round-trip)", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const stream = pushStream();
    const handle = knobsHandle(fakeCommandClient(stream, captured), "s1");

    stream.emit({
      kind: "snapshot",
      version: 1,
      values: { temperature: 0.7 },
      descriptors: [{ id: "temperature", value: 0.7, valueType: "number" }],
    });
    await waitFor(() => handle.list().length > 0);
    expect(handle.get("temperature")?.value).toBe(0.7);

    // Write command — no local hand-patch, so the view is still 0.7 here.
    await handle.set("temperature", 0.9);
    expect(handle.get("temperature")?.value).toBe(0.7);

    // The write's effect returns as a channel delta and re-folds the view; the
    // descriptor metadata (valueType) survives across the values patch.
    stream.emit({
      kind: "delta",
      version: 2,
      ops: [{ op: "replace", path: "/temperature", value: 0.9 }],
    });
    await waitFor(() => handle.get("temperature")?.value === 0.9);
    expect(handle.get("temperature")).toMatchObject({
      id: "temperature",
      value: 0.9,
      valueType: "number",
    });
  });

  it("subscribe(cb) notifies on channel updates; cb receives NO arguments", async () => {
    const stream = pushStream();
    const handle = knobsHandle(fakeCommandClient(stream), "s1");

    let notified = 0;
    let argCount = -1;
    handle.subscribe((...args: unknown[]) => {
      notified += 1;
      argCount = args.length;
    });

    stream.emit({ kind: "snapshot", version: 1, values: { temperature: 0.7 }, descriptors: [] });
    await waitFor(() => notified > 0);
    expect(notified).toBeGreaterThan(0);
    expect(argCount).toBe(0);
  });
});
