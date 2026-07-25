/**
 * ADR 87 integration — importing `@agentick/resources-next/client` makes
 * `client.session(id).resources` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `resourcesHandle`: the Enumerable descriptor view (`list`/`get`) plus the
 * `listTemplates`/`read` reads over `resources/*`. Proves the full path:
 * register → makeSessionHandle → lazy getter → handle, and the read poll +
 * read RPC.
 */

import { describe, expect, it } from "vitest";
import type { ResourcesListResult, WireMethod, WireParams } from "@agentick/spec-next";
import { makeSessionHandle } from "@agentick/client-core-next";
import { waitFor } from "@agentick/utils-next/testing";

// Side-effect: registers the `resources` sub-handle + types the slot.
import "../register.js";

const RESOURCES: ResourcesListResult = {
  resources: [{ uri: "file:///a.txt", name: "a", description: "A" }],
};

/**
 * Minimal InternalClient — a faithful double: the top-level `request` delegates
 * to `transport.request` (the recorder), exactly as a real client's request
 * pipeline bottoms out at the transport.
 */
function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "resources/list") return RESOURCES;
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

describe("session.resources (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a resource snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    // Non-optional slot, no client-core wiring: importing the subpath registered it.
    expect(session.resources).toBeDefined();

    await waitFor(() => session.resources.list().length > 0);
    expect(session.resources.get("file:///a.txt")).toMatchObject({
      uri: "file:///a.txt",
      name: "a",
    });
  });

  it("read(uri) issues resources/read over the transport", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    await session.resources.read("file:///a.txt");

    const read = calls.find((c) => c.method === "resources/read");
    expect(read?.params).toEqual({ sessionId: "s1", uri: "file:///a.txt" });
  });
});
