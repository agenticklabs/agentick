/**
 * The bundle's whole job: importing it registers EVERY built-in session
 * sub-handle (ADR 87), so `client.session(id).tasks` / `.knobs` /
 * `.elicitations` self-assemble with no per-harness imports.
 */

import { describe, expect, it } from "vitest";
import type { ClientTransport, EventFrame, SubscriptionStream } from "@agentick/spec";

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

describe("@agentick/client-bundle", () => {
  it("registers every built-in session sub-handle slot on import", () => {
    const names = registeredSessionHandleExtensions();
    expect(names).toEqual(
      expect.arrayContaining([
        "tasks",
        "knobs",
        "elicitations",
        "clientToolCalls",
        "timeline",
        "gates",
        "tools",
        "skills",
        "prompts",
        "resources",
        "state",
      ]),
    );
  });

  it("a session handle self-assembles all built-in slots (no per-harness imports)", () => {
    // Minimal client: the slots are lazy getters; only the subscribe transport
    // is touched when a view is first read (not here — we assert presence).
    const fakeClient = {
      id: "c1",
      // The RPC-backed handles (gates/tools/skills/prompts/resources/state) eager
      // fetch on construction; a benign resolver keeps the fire-and-forget poll
      // from throwing.
      request: (async () => null) as never,
      transport: {
        request: (async () => null) as ClientTransport["request"],
        subscribe: (() => neverStream()) as ClientTransport["subscribe"],
      } as never,
    };
    const session = makeSessionHandle(fakeClient, "s1");

    expect(typeof session.tasks.list).toBe("function"); // TasksHandle (Enumerable)
    expect(typeof session.knobs.list).toBe("function"); // KnobsHandle (Enumerable)
    expect(typeof session.elicitations.list).toBe("function"); // Enumerable read
    expect(typeof session.elicitations.respond).toBe("function"); // Respondable by-id
    expect(typeof session.clientToolCalls.list).toBe("function"); // Enumerable read
    expect(typeof session.clientToolCalls.set).toBe("function"); // folded declare verb
    expect(typeof session.clientToolCalls.route).toBe("function"); // folded router verb
    expect(typeof session.timeline.list).toBe("function"); // TimelineView (Enumerable)
    expect(typeof session.gates.list).toBe("function"); // GatesClientHandle (Enumerable)
    expect(typeof session.tools.list).toBe("function"); // ToolsClientHandle (Enumerable)
    expect(typeof session.tools.dispatch).toBe("function"); // host-door dispatch verb
    expect(typeof session.skills.list).toBe("function"); // SkillsClientHandle (Enumerable)
    expect(typeof session.skills.search).toBe("function"); // read verb
    expect(typeof session.prompts.list).toBe("function"); // PromptsClientHandle (Enumerable)
    expect(typeof session.prompts.render).toBe("function"); // read verb
    expect(typeof session.resources.list).toBe("function"); // ResourcesClientHandle (Enumerable)
    expect(typeof session.resources.read).toBe("function"); // read verb
    expect(typeof session.state.list).toBe("function"); // StateClientHandle (Enumerable)
    expect(typeof session.state.set).toBe("function"); // write verb
  });
});
