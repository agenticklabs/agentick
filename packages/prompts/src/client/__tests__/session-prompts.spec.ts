/**
 * ADR 87 integration — importing `@agentick/prompts/client` makes
 * `client.session(id).prompts` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `promptsHandle`: the Enumerable snapshot view (`list`/`get`) plus the
 * `render`/`invoke`/`register`/`update`/`remove` verbs over `prompts/*`.
 */

import { describe, expect, it } from "vitest";
import type { PromptDeclarationRecord, WireMethod, WireParams } from "@agentick/spec";
import { makeSessionHandle } from "@agentick/client-core";
import { waitFor } from "@agentick/utils/testing";

// Side-effect: registers the `prompts` sub-handle + types the slot.
import "../register.js";

const PROMPTS: readonly PromptDeclarationRecord[] = [{ name: "greet", description: "Say hello" }];

function fakeInternalClient(calls: Array<{ method: WireMethod; params: unknown }>) {
  const transport = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
      calls.push({ method, params });
      if (method === "prompts/list") return PROMPTS;
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

describe("session.prompts (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and polls a prompts snapshot", async () => {
    const session = makeSessionHandle(fakeInternalClient([]), "s1");

    expect(session.prompts).toBeDefined();

    await waitFor(() => session.prompts.list().length > 0);
    expect(session.prompts.get("greet")).toMatchObject({ name: "greet", description: "Say hello" });
  });

  it("remove() issues prompts/remove over the transport (write half)", async () => {
    const calls: Array<{ method: WireMethod; params: unknown }> = [];
    const session = makeSessionHandle(fakeInternalClient(calls), "s1");

    await session.prompts.remove({ name: "greet" });

    const remove = calls.find((c) => c.method === "prompts/remove");
    expect(remove?.params).toEqual({ sessionId: "s1", name: "greet" });
  });
});
