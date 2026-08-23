/**
 * ADR 102 stage 1 — the gateway's node-resolution seams and the
 * defaults that stand in when an adopter configures neither.
 */

import { describe, expect, it } from "vitest";
import { createGateway } from "../create-gateway.js";

describe("gateway node resolution — defaults", () => {
  it("an authenticated caller's node is their principal; their attachable set is that node", async () => {
    const gateway = await createGateway();
    expect(gateway.sessionNodeFor({ principal: "alice" })).toEqual(["alice"]);
    expect(gateway.attachableNodesFor({ principal: "alice" })).toEqual([["alice"]]);
    await gateway.close();
  });

  it("an unauthenticated caller resolves to the root — the local pole sees everything", async () => {
    const gateway = await createGateway();
    expect(gateway.sessionNodeFor(undefined)).toEqual([]);
    expect(gateway.sessionNodeFor({})).toEqual([]);
    expect(gateway.attachableNodesFor(undefined)).toEqual([[]]);
    await gateway.close();
  });
});

describe("gateway node resolution — configured", () => {
  it("uses the adopter's sessionNode, and defaults the attachable set to it", async () => {
    const gateway = await createGateway({
      sessionNode: (auth) => [
        `tenant:${auth.user?.["tenantId"] as string}`,
        `user:${auth.principal}`,
      ],
    });
    const auth = { principal: "ryan", user: { tenantId: "acme" } };
    expect(gateway.sessionNodeFor(auth)).toEqual(["tenant:acme", "user:ryan"]);
    expect(gateway.attachableNodesFor(auth)).toEqual([["tenant:acme", "user:ryan"]]);
    await gateway.close();
  });

  it("attachableNodes widens the set independently of sessionNode", async () => {
    const gateway = await createGateway({
      sessionNode: (auth) => [`user:${auth.principal}`],
      attachableNodes: (auth) => [[`user:${auth.principal}`], ["room:standup"]],
    });
    const auth = { principal: "ryan" };
    expect(gateway.sessionNodeFor(auth)).toEqual(["user:ryan"]);
    expect(gateway.attachableNodesFor(auth)).toEqual([["user:ryan"], ["room:standup"]]);
    await gateway.close();
  });
});
