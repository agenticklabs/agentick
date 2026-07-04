/**
 * ADR 51 slice 5 (#141): the dynamic command lane + Authorizer gate.
 *
 * Pins the security posture: deny-by-default (unexposed verb ==
 * absent method), grant-gated exposure, same-principal target rule,
 * exact-beats-dynamic resolution, and the origin: "wire" stamp.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { WireRpcError, ErrorCode, type CommandInfo, type MessageInbox } from "@agentick/spec-next";

import { permissiveAuthorizer, staticAuthorizer, unconfiguredAuthorizer } from "../authorizers.js";
import { createCommandsListHandler, createDynamicCommandResolver } from "../dynamic-commands.js";
import { createWireExtensionRegistry } from "../wire-registry.js";

// ── stub inbox: scripted `<surface>:commands` replies + ask recorder ──

interface AskRecord {
  address: string;
  type: string;
  origin?: string;
  payload?: unknown;
}

function stubInbox(commandsByAddress: Record<string, readonly CommandInfo[]>): {
  inbox: MessageInbox;
  asks: AskRecord[];
} {
  const asks: AskRecord[] = [];
  const inbox = {
    ask: (address: string, input: { type: string; origin?: string; payload?: unknown }) => {
      asks.push({ address, type: input.type, origin: input.origin, payload: input.payload });
      if (input.type.endsWith(":commands")) {
        const commands = commandsByAddress[address];
        if (!commands) return Effect.fail(new Error(`no harness at ${address}`));
        return Effect.succeed({ commands });
      }
      return Effect.succeed({ ok: true, echoed: input.payload });
    },
  } as unknown as MessageInbox;
  return { inbox, asks };
}

const cmd = (name: string, exposure: CommandInfo["exposure"]): CommandInfo => ({
  name,
  exposure,
  hasInput: true,
});

const TIMELINE_ADDR = "timeline:s1:timeline";

function lane(grants: Record<string, readonly string[]> = {}, anonymous: readonly string[] = []) {
  const { inbox, asks } = stubInbox({
    [TIMELINE_ADDR]: [
      cmd("timeline:compact", "wire"),
      cmd("timeline:append", "addressable"),
      cmd("timeline:commands", "wire"),
    ],
    "knobs:s1:knobs": [cmd("knobs:set", "wire"), cmd("knobs:commands", "wire")],
  });
  const resolver = createDynamicCommandResolver({
    inbox,
    authorizer: staticAuthorizer({ grants, anonymous }),
  });
  return { resolver, asks, inbox };
}

describe("authorizers", () => {
  it("staticAuthorizer: exact, surface-glob, and star patterns; deny without grant", async () => {
    const a = staticAuthorizer({
      grants: { alice: ["timeline:compact", "knobs:*"], root: ["*"] },
    });
    expect((await a.authorize({ principal: "alice", scope: "timeline:compact" })).allowed).toBe(
      true,
    );
    expect((await a.authorize({ principal: "alice", scope: "knobs:set" })).allowed).toBe(true);
    expect((await a.authorize({ principal: "alice", scope: "skills:remove" })).allowed).toBe(false);
    expect((await a.authorize({ principal: "root", scope: "anything:at-all" })).allowed).toBe(true);
    expect((await a.authorize({ scope: "timeline:compact" })).allowed).toBe(false); // anonymous
  });

  it("same-principal target rule holds for static + permissive; unconfigured denies principals outright", async () => {
    const target = { principal: "bob" };
    for (const a of [staticAuthorizer({ grants: { alice: ["*"] } }), permissiveAuthorizer()]) {
      const res = await a.authorize({ principal: "alice", scope: "x:y", target });
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe("target-principal-mismatch");
    }
    // Unconfigured: the principal denial fires FIRST (no policy exists
    // to elevate anyone); unauthenticated callers still hit the rule.
    const unconfigured = unconfiguredAuthorizer();
    expect(
      (await unconfigured.authorize({ principal: "alice", scope: "x:y", target })).reason,
    ).toBe("authorizer-unconfigured");
    expect((await unconfigured.authorize({ scope: "x:y", target })).reason).toBe(
      "target-principal-mismatch",
    );
  });

  it("unconfiguredAuthorizer: local pole passes, any principal is denied", async () => {
    const a = unconfiguredAuthorizer();
    expect((await a.authorize({ scope: "timeline:compact" })).allowed).toBe(true);
    expect((await a.authorize({ principal: "alice", scope: "timeline:compact" })).allowed).toBe(
      false,
    );
  });
});

describe("registry — exact-beats-dynamic + sealing", () => {
  it("porcelain shadows the dynamic lane; dynamic serves the rest", () => {
    const registry = createWireExtensionRegistry();
    const porcelain = async () => "porcelain";
    registry.register({
      name: "t",
      namespace: "timeline",
      methods: { "timeline/compact": porcelain } as never,
    });
    let dynamicHits = 0;
    registry.registerDynamicResolver((method) => {
      dynamicHits++;
      return { extension: { name: "d", namespace: "*", methods: {} }, handler: async () => method };
    });
    registry.seal();

    expect(registry.resolve("timeline/compact")!.handler).toBe(porcelain);
    expect(dynamicHits).toBe(0);
    expect(registry.resolve("knobs/set")).toBeDefined();
    expect(dynamicHits).toBe(1);
  });

  it("dynamic registration is pre-seal and single", () => {
    const registry = createWireExtensionRegistry();
    registry.registerDynamicResolver(() => undefined);
    expect(() => registry.registerDynamicResolver(() => undefined)).toThrow(/exactly ONE/);
    const sealedRegistry = createWireExtensionRegistry();
    sealedRegistry.seal();
    expect(() => sealedRegistry.registerDynamicResolver(() => undefined)).toThrow(/sealed/);
  });
});

describe("dynamic command lane — deny-by-default", () => {
  it("an addressable-but-not-wire verb is indistinguishable from an absent method", async () => {
    const { resolver } = lane({ alice: ["*"] });
    const r = resolver("timeline/append")!;
    const err = await r
      .handler({ sessionId: "s1" }, { principal: "alice" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireRpcError);
    expect((err as WireRpcError).code).toBe(ErrorCode.MethodNotFound);
  });

  it("an exposed verb without a grant is Forbidden", async () => {
    const { resolver } = lane({ alice: ["knobs:*"] });
    const err = await resolver("timeline/compact")!
      .handler({ sessionId: "s1" }, { principal: "alice" })
      .catch((e: unknown) => e);
    expect((err as WireRpcError).code).toBe(ErrorCode.Forbidden);
  });

  it("an exposed + granted verb dispatches with origin 'wire' and the params as payload", async () => {
    const { resolver, asks } = lane({ alice: ["timeline:compact"] });
    const result = await resolver("timeline/compact")!.handler(
      { sessionId: "s1", instructions: "tight" },
      { principal: "alice" },
    );
    expect(result).toMatchObject({ ok: true });
    const dispatch = asks.find((a) => a.type === "timeline:compact")!;
    expect(dispatch.address).toBe(TIMELINE_ADDR);
    expect(dispatch.origin).toBe("wire");
    expect(dispatch.payload).toMatchObject({ instructions: "tight" });
  });

  it("underivable address (missing sessionId; unknown surface) → MethodNotFound", async () => {
    const { resolver } = lane({ alice: ["*"] });
    const noSession = await resolver("timeline/compact")!
      .handler({}, { principal: "alice" })
      .catch((e: unknown) => e);
    expect((noSession as WireRpcError).code).toBe(ErrorCode.MethodNotFound);
    const badSurface = await resolver("sandbox/exec")!
      .handler({ sessionId: "s1" }, { principal: "alice" })
      .catch((e: unknown) => e);
    expect((badSurface as WireRpcError).code).toBe(ErrorCode.MethodNotFound);
  });

  it("the meta-verb serves enumeration, gated like everything else", async () => {
    const { resolver } = lane({ alice: ["timeline:commands"] });
    const reply = (await resolver("timeline/commands")!.handler(
      { sessionId: "s1" },
      { principal: "alice" },
    )) as { commands: readonly CommandInfo[] };
    expect(reply.commands.map((c) => c.name)).toContain("timeline:compact");
    const denied = await resolver("timeline/commands")!
      .handler({ sessionId: "s1" }, { principal: "mallory" })
      .catch((e: unknown) => e);
    expect((denied as WireRpcError).code).toBe(ErrorCode.Forbidden);
  });
});

describe("commands/list — discovery", () => {
  it("lists only wire-exposed rows across surfaces the caller can see", async () => {
    const { inbox } = lane();
    const handler = createCommandsListHandler({
      inbox,
      authorizer: staticAuthorizer({ grants: { alice: ["*"] } }),
    });
    const reply = (await handler({ sessionId: "s1" }, { principal: "alice" })) as {
      commands: Array<{ method: string; command: CommandInfo }>;
    };
    const methods = reply.commands.map((c) => c.method);
    expect(methods).toContain("timeline/compact");
    expect(methods).toContain("knobs/set");
    expect(methods).not.toContain("timeline/append"); // addressable ≠ wire
  });

  it("denied callers see nothing (discovery is itself gated)", async () => {
    const { inbox } = lane();
    const handler = createCommandsListHandler({
      inbox,
      authorizer: staticAuthorizer({ grants: {} }),
    });
    const reply = (await handler({ sessionId: "s1" }, { principal: "mallory" })) as {
      commands: unknown[];
    };
    expect(reply.commands).toEqual([]);
  });
});
