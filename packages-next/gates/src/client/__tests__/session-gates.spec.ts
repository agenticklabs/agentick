/**
 * ADR 87 integration — importing `@agentick/gates-next/client` makes
 * `client.session(id).gates` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `gatesHandle`: the Enumerable snapshot view (`list`/`get`) plus the
 * `clear`/`defer`/`override` verbs over `gates/*`. Proves the full path:
 * register → makeSessionHandle → lazy getter → handle, and the read poll +
 * write RPC.
 */

import { describe, expect, it } from "vitest";
import type { WireMethod, WireParams } from "@agentick/spec-next";
import { makeSessionHandle } from "@agentick/client-core-next";
import { waitFor } from "@agentick/utils-next/testing";

import type { GateInfo } from "../../controller.js";
// Side-effect: registers the `gates` sub-handle + types the slot.
import "../register.js";

const GATES: readonly GateInfo[] = [
  { name: "review", value: "active", verified: false, description: "Await review" },
];

/**
 * Minimal InternalClient — a faithful double: the top-level `request` delegates
 * to `transport.request` (the recorder), exactly as a real client's request
 * pipeline bottoms out at the transport. `session.gates.clear` therefore records
 * on `calls` whether it travels the direct or middleware-wrapped path.
 */
function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "gates/list") return GATES;
      return null;
    },
  };
  return {
    id: "c1",
    request: (async (method: WireMethod, params: unknown) =>
      transport.request(method, params as WireParams<WireMethod>)) as never,
    transport: transport as never,
  };
}

describe("session.gates (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a gates snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    // Non-optional slot, no client-core wiring: importing the subpath registered it.
    expect(session.gates).toBeDefined();

    await waitFor(() => session.gates.list().length > 0);
    expect(session.gates.get("review")).toMatchObject({ name: "review", value: "active" });
  });

  it("clear() issues gates/clear over the transport (write half)", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    await session.gates.clear("review");

    const clear = calls.find((c) => c.method === "gates/clear");
    expect(clear?.params).toEqual({ sessionId: "s1", name: "review" });
  });
});
