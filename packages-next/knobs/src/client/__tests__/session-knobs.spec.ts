/**
 * ADR 87 integration — importing `@agentick/knobs-next/client` makes
 * `client.session(id).knobs` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `knobsHandle`: the `KnobsState` read view plus `set(key, value)` over
 * `knobs/set`. Proves the full path: register → makeSessionHandle → getter →
 * handle, and the write half round-trips through the channel (CQRS).
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
import { makeSessionHandle } from "@agentick/client-core-next";
import { waitFor } from "@agentick/utils-next/testing";

import { KNOBS_STATE_CHANNEL, type KnobsStateFrame } from "../../channel.js";
// Side-effect: registers the `knobs` sub-handle + types the slot.
import "../register.js";

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

/** Minimal InternalClient: id + a subscribe stream + a `request` recorder. */
function fakeInternalClient(
  stream: SubscriptionStream,
  captured: { method?: WireMethod; params?: unknown } = {},
) {
  return {
    id: "c1",
    request: (async () => null) as never,
    transport: {
      subscribe(_scope: SubscriptionScope, _query?: EventQuery): SubscriptionStream {
        return stream;
      },
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.method = method;
        captured.params = params;
        return null;
      },
    } as never,
  };
}

describe("session.knobs (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and folds a knobs snapshot", async () => {
    const stream = pushStream();
    const session = makeSessionHandle(fakeInternalClient(stream), "s1");

    // Non-optional slot, no client-core wiring: importing the subpath registered it.
    expect(session.knobs).toBeDefined();

    stream.emit({ kind: "snapshot", version: 1, values: { temperature: 0.7 }, descriptors: [] });
    await waitFor(() => Object.keys(session.knobs.get()).length > 0);
    expect(session.knobs.get()).toEqual({ temperature: 0.7 });
  });

  it("set() issues knobs/set over the transport (write half)", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const session = makeSessionHandle(fakeInternalClient(pushStream(), captured), "s1");

    await session.knobs.set("temperature", 0.9);

    expect(captured.method).toBe("knobs/set");
    expect(captured.params).toEqual({ sessionId: "s1", key: "temperature", value: 0.9 });
  });
});
