/**
 * ADR 87 integration — importing `@agentick/tool-executor/client` makes
 * `client.session(id).tools` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `toolsHandle`: the Enumerable snapshot view (`list`/`get`) plus the `dispatch`
 * verb over `session/dispatch`. Proves register → makeSessionHandle → lazy
 * getter → handle, AND that it does NOT collide with the `clientToolCalls` slot.
 */

import { describe, expect, it } from "vitest";
import type { ToolInfo, WireMethod, WireParams } from "@agentick/spec";
import { makeSessionHandle } from "@agentick/client-core";
import { waitFor } from "@agentick/utils/testing";

// Side-effect: registers BOTH the `clientToolCalls` and `tools` sub-handles.
import "../index.js";

const TOOLS: readonly ToolInfo[] = [
  { name: "echo", description: "Echo", exposure: ["model", "dispatch"], hasInputSchema: true },
];

function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "session/list_tools") return { tools: TOOLS };
      if (method === "session/dispatch") return { content: [{ type: "text", text: "ok" }] };
      return null;
    },
    // Minimal SubscriptionStream double — the `clientToolCalls` slot opens one on
    // access (unrelated to `tools`); an empty stream keeps its getter reachable.
    subscribe() {
      return {
        subscriptionId: "sub-1",
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          /* no frames */
        },
      };
    },
  };
  return {
    id: "c1",
    request: (async (method: WireMethod, params: unknown) =>
      transport.request(method, params as WireParams<WireMethod>)) as never,
    transport: transport as never,
  };
}

describe("session.tools (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a tools snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    expect(session.tools).toBeDefined();
    // Distinct slot — the inbound client-tool-call feed is still there.
    expect(session.clientToolCalls).toBeDefined();

    await waitFor(() => session.tools.list().length > 0);
    expect(session.tools.get("echo")).toMatchObject({ name: "echo" });
  });

  it("dispatch() issues session/dispatch over the transport", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    const out = await session.tools.dispatch("echo", { x: 1 });

    expect(out).toEqual([{ type: "text", text: "ok" }]);
    const dispatch = calls.find((c) => c.method === "session/dispatch");
    expect(dispatch?.params).toEqual({ sessionId: "s1", tool: "echo", input: { x: 1 } });
  });
});
