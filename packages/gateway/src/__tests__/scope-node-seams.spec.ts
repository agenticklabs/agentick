/**
 * ADR 102 stage 1 — the gateway's node-resolution seams and the
 * defaults that stand in when an adopter configures neither.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LocalEventBus } from "@agentick/runtime";
import type { EventBus } from "@agentick/spec";
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

/**
 * ADR 102 stage 2 — the gateway is the SINGLE SOURCE of the tree. Two
 * independently-configurable resolvers (its own and each app's) would let
 * sessions and subscribers disagree about where a principal lives, and the
 * failure would be silent starvation rather than an error.
 */
describe("gateway node resolution — the app inherits the tree", () => {
  it("a session created under a gateway-mounted app lands on the node the gateway names", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "inherit",
      rootElement: null,
      options: stubCompiler(),
    });
    const session = await app.createSession({ principal: "alice" });

    const node = gateway.attachScopeNode(gateway.sessionNodeFor({ principal: "alice" }));
    expect(busOf(session)).toBe(node.bus);

    node.release();
    await gateway.close();
  });

  it("an app that names its own sessionNode keeps it", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "own-resolver",
      rootElement: null,
      options: { ...stubCompiler(), sessionNode: () => ["app-decides"] },
    });
    const session = await app.createSession({ principal: "alice" });

    const node = gateway.attachScopeNode(gateway.sessionNodeFor({ principal: "alice" }));
    expect(busOf(session)).not.toBe(node.bus);

    node.release();
    await gateway.close();
  });

  // TODO(scope-nodes-app-bus): an app on its OWN bus is left topology-free,
  // because the gateway's tree is rooted at the GATEWAY's bus and relocating
  // the app's sessions into it would make `app.events()` blind to them. The
  // cost is the mirror image: a gateway-scope subscriber attached to a
  // principal node does not see that app's sessions. Closing it needs a tree
  // per bus root, which no consumer has asked for yet.
  it("an app on its own bus is left topology-free", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "own-bus",
      rootElement: null,
      bus: new LocalEventBus(),
      options: stubCompiler(),
    });
    const session = await app.createSession({ principal: "alice" });
    expect(busOf(session)).toBe(busOf(app));
    await gateway.close();
  });
});

const busOf = (harness: unknown): EventBus => (harness as { bus: EventBus }).bus;

/** Enough compiler for `AppHarness` to construct; these tests never render. */
function stubCompiler() {
  return {
    compiler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
    } as never,
  };
}
