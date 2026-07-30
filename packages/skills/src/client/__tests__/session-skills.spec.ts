/**
 * ADR 87 integration — importing `@agentick/skills/client` makes
 * `client.session(id).skills` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `skillsHandle`: the Enumerable snapshot view (`list`/`get`) plus the
 * `search`/`register`/`update`/`remove` verbs over `skills/*`. Proves the full
 * path: register → makeSessionHandle → lazy getter → handle, and the read poll +
 * write RPC.
 */

import { describe, expect, it } from "vitest";
import type { Skill, WireMethod, WireParams } from "@agentick/spec";
import { makeSessionHandle } from "@agentick/client-core";
import { waitFor } from "@agentick/utils/testing";

// Side-effect: registers the `skills` sub-handle + types the slot.
import "../register.js";

const SKILLS: readonly Skill[] = [
  {
    name: "review",
    description: "Review a change",
    content: "# Review",
    updatedAt: 2,
    createdAt: 1,
  },
];

function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "skills/list") return { skills: SKILLS };
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

describe("session.skills (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a skills snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    expect(session.skills).toBeDefined();

    await waitFor(() => session.skills.list().length > 0);
    expect(session.skills.get("review")).toMatchObject({
      name: "review",
      description: "Review a change",
    });
  });

  it("remove() issues skills/remove over the transport (write half)", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    await session.skills.remove({ name: "review" });

    const remove = calls.find((c) => c.method === "skills/remove");
    expect(remove?.params).toEqual({ sessionId: "s1", name: "review" });
  });
});
