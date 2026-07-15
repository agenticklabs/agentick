/**
 * The bundle's whole job: importing it registers EVERY built-in session
 * sub-handle (ADR 87), so `client.session(id).tasks` / `.knobs` /
 * `.elicitations()` self-assemble with no per-harness imports.
 */

import { describe, expect, it } from "vitest";
import type { ClientTransport, EventFrame, SubscriptionStream } from "@agentick/spec-next";

// The bundle under test — side-effect imports the built-in /client subpaths and
// re-exports the client-core surface.
import { makeSessionHandle, registeredSessionHandleExtensions } from "../index.js";

/** A subscription stream that never yields — the tasks/knobs views subscribe
 * eagerly, so `subscribe` must return a real async-iterable (not `{}`). */
function neverStream(): SubscriptionStream {
  return {
    subscriptionId: "sub-test",
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return { next: () => new Promise<IteratorResult<EventFrame>>(() => {}) };
    },
    async close(): Promise<void> {},
  };
}

describe("@agentick/client-bundle-next", () => {
  it("registers every built-in session sub-handle slot on import", () => {
    const names = registeredSessionHandleExtensions();
    expect(names).toEqual(
      expect.arrayContaining(["tasks", "knobs", "elicitations", "respondToElicitation"]),
    );
  });

  it("a session handle self-assembles all built-in slots (no per-harness imports)", () => {
    // Minimal client: the slots are lazy getters; only the subscribe transport
    // is touched when a view is first read (not here — we assert presence).
    const fakeClient = {
      id: "c1",
      request: (async () => null) as never,
      transport: {
        subscribe: (() => neverStream()) as ClientTransport["subscribe"],
      } as never,
    };
    const session = makeSessionHandle(fakeClient, "s1");

    expect(session.tasks).toBeDefined(); // ChannelView<TaskStatusMap>
    expect(session.knobs).toBeDefined(); // KnobsHandleView
    expect(typeof session.elicitations).toBe("function"); // stream factory
    expect(typeof session.respondToElicitation).toBe("function"); // reply command
  });
});
