/**
 * ADR 87 integration — importing `@agentick/state/client` makes
 * `client.session(id).state` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `stateHandle`: the Enumerable snapshot view (`list`/`get`) plus the
 * `set`/`delete` verbs over `state/*`. Proves the full path: register →
 * makeSessionHandle → lazy getter → handle, and the read poll + write RPC.
 */

import { describe, expect, it } from "vitest";
import type { StateListEntry, WireMethod, WireParams } from "@agentick/spec";
import { makeSessionHandle } from "@agentick/client-core";
import { waitFor } from "@agentick/utils/testing";

// Side-effect: registers the `state` sub-handle + types the slot.
import "../register.js";

const ENTRIES: readonly StateListEntry[] = [{ key: "cursor", value: 3 }];

/**
 * Minimal InternalClient — a faithful double: the top-level `request` delegates
 * to `transport.request` (the recorder), exactly as a real client's request
 * pipeline bottoms out at the transport.
 */
function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "state/list") return ENTRIES;
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

describe("session.state (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a state snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    // Non-optional slot, no client-core wiring: importing the subpath registered it.
    expect(session.state).toBeDefined();

    await waitFor(() => session.state.list().length > 0);
    expect(session.state.get("cursor")).toEqual({ key: "cursor", value: 3 });
  });

  it("set() issues state/set over the transport (write half)", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    await session.state.set("cursor", 4);

    const set = calls.find((c) => c.method === "state/set");
    expect(set?.params).toEqual({ sessionId: "s1", key: "cursor", value: 4 });
  });
});
