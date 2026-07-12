/**
 * `knobsStateView` — the knobs client façade over `channelView`.
 *
 * Pins the knobs reduction against the REAL frame types: the opening snapshot
 * seeds the whole store; subsequent `knobs-state` deltas apply their JSON-Patch
 * ops (one per changed knob). The adopter sees a live `Record<knobId, value>`
 * and never touches channel names, frame kinds, or RFC 6902.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { knobsStateView } from "../knobs-state-view.js";
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

function fakeClient(stream: SubscriptionStream, captured: { query?: EventQuery } = {}) {
  return {
    transport: {
      subscribe(_scope: SubscriptionScope, query?: EventQuery): SubscriptionStream {
        captured.query = query;
        return stream;
      },
    },
  };
}

describe("knobsStateView", () => {
  it("seeds from the snapshot frame, then folds JSON-Patch deltas", async () => {
    const stream = pushStream();
    const view = knobsStateView(fakeClient(stream), "s1");

    stream.emit({ kind: "snapshot", version: 1, values: { temperature: 0.7, verbosity: "low" } });
    await waitFor(() => Object.keys(view.get()).length > 0);
    expect(view.get()).toEqual({ temperature: 0.7, verbosity: "low" });

    stream.emit({
      kind: "delta",
      version: 2,
      ops: [{ op: "replace", path: "/temperature", value: 0.9 }],
    });
    await waitFor(() => view.get().temperature === 0.9);
    expect(view.get()).toEqual({ temperature: 0.9, verbosity: "low" });

    stream.emit({ kind: "delta", version: 3, ops: [{ op: "add", path: "/model", value: "opus" }] });
    await waitFor(() => "model" in view.get());
    expect(view.get()).toEqual({ temperature: 0.9, verbosity: "low", model: "opus" });

    stream.emit({ kind: "delta", version: 4, ops: [{ op: "remove", path: "/verbosity" }] });
    await waitFor(() => !("verbosity" in view.get()));
    expect(view.get()).toEqual({ temperature: 0.9, model: "opus" });
  });

  it("subscribes to the knobs-state channel (arg-free façade builds the scope)", () => {
    const captured: { query?: EventQuery } = {};
    knobsStateView(fakeClient(pushStream(), captured), "s1");
    expect(captured.query).toEqual({
      surface: "session",
      name: { exact: "session:channel:knobs-state" },
    });
  });
});
