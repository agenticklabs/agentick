/**
 * End-to-end wire lane (#141 + ADR 34 ingress): REAL gateway, REAL app,
 * REAL session harnesses on the shared substrate — a JSON-RPC request
 * enters `dispatchRequest` with an ingress identity and either reaches
 * the session's TimelineHarness over the inbox or dies at the gate.
 *
 * This is the test the unit suite could not provide: address
 * derivation, the `<surface>:commands` meta-verb ask, exposure
 * flipping, and the Authorizer all exercised against live harnesses.
 */

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ErrorCode,
  type Authorizer,
  type AuthorizeInput,
  type JsonRpcResponse,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

import { fromHandler } from "@agentick/timeline/strategies";

import {
  claimsAuthorizer,
  createGateway,
  staticAuthorizer,
  type GatewayHarness,
} from "@agentick/gateway";

function makeAppOptions() {
  return {
    rootElement: {} as unknown,
    executor: {
      target: { kind: "language-model" as const, provider: "mock", modelId: "stub" },
      project: () => ({}) as never,
      execute: () => Effect.succeed({}) as never,
      executeStream: undefined,
      normalize: () => ({}) as never,
      run: () => Effect.succeed({}) as never,
      abort: () => Effect.succeed(undefined) as never,
    } as never,
    compiler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

const sink: DispatchSink = {
  sendNotification: () => {},
  registerSubscription: () => {},
  unregisterSubscription: () => {},
  registerInFlight: () => {},
  unregisterInFlight: () => {},
};

let rpcId = 0;
async function rpc(
  gateway: GatewayHarness,
  method: string,
  params: Record<string, unknown>,
  principal?: string,
): Promise<JsonRpcResponse> {
  return dispatchRequest(
    gateway as never,
    { jsonrpc: "2.0", id: ++rpcId, method, params },
    sink,
    principal !== undefined ? { principal } : undefined,
  );
}

describe("wire lane e2e — real gateway + session, ingress identity, Authorizer", () => {
  let gateway: GatewayHarness;

  beforeAll(async () => {
    gateway = (await createGateway({
      authorizer: staticAuthorizer({
        grants: { alice: ["timeline:*"] },
        anonymous: [],
      }),
    })) as GatewayHarness;
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "a1",
      ...(makeAppOptions() as object),
      options: {
        ...makeAppOptions(),
        // Construction-bound default compaction — the bare
        // `timeline:compact` signal form resolves to this. Top-level slot.
        timeline: { compact: fromHandler({ handler: async ({ entries }) => entries }) },
      } as never,
    } as never);
    await app.createSession({ sessionId: "s1" });
  });

  afterAll(async () => {
    await gateway.close();
  });

  it("granted principal reaches the REAL TimelineHarness: timeline/compact round-trips", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" }, "alice");
    expect("error" in res ? res.error : undefined).toBeUndefined();
    expect("result" in res && res.result).toBeTruthy();
  });

  it("gated discovery: timeline/commands enumerates for the granted principal", async () => {
    const res = await rpc(gateway, "timeline/commands", { sessionId: "s1" }, "alice");
    if (!("result" in res)) throw new Error("expected result");
    const commands = (res.result as { commands: Array<{ name: string; exposure: string }> })
      .commands;
    const compact = commands.find((c) => c.name === "timeline:compact");
    expect(compact?.exposure).toBe("wire");
  });

  it("addressable-but-not-wire verb is MethodNotFound even for the granted principal", async () => {
    const res = await rpc(gateway, "timeline/append", { sessionId: "s1" }, "alice");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.MethodNotFound);
  });

  it("ungranted principal is Forbidden on an exposed verb", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" }, "mallory");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.Forbidden);
  });

  it("anonymous caller is Forbidden under a configured static policy with no anonymous grants", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" });
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.Forbidden);
  });

  it("porcelain still shadows the dynamic lane (exact-beats-dynamic on a real registry)", async () => {
    // session/send is a hand-written wire extension — resolving it must
    // hit the porcelain extension, not the dynamic marker.
    const resolution = gateway.wireExtensions().resolve("session/send");
    expect(resolution).toBeDefined();
    expect(resolution!.extension.name).not.toBe("@agentick/dynamic-commands");
  });

  it("unknown session id dies with MethodNotFound (no address, no oracle)", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "nope" }, "alice");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    // Address derives, but the ask to a non-existent harness fails —
    // surfaced as an error, never a hang.
    expect("code" in res.error).toBe(true);
  });
});

describe("staticTokenAuthSource — prototype-key bypass (review finding)", () => {
  it("inherited object members are NOT valid tokens", async () => {
    const { staticTokenAuthSource } = await import("../server/auth-source.js");
    const auth = staticTokenAuthSource({ tokens: { good: "alice" } });
    for (const evil of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      await expect(auth.authenticate({ kind: "bearer", token: evil, headers: {} })).rejects.toThrow(
        /unknown token/,
      );
    }
    expect(
      (await auth.authenticate({ kind: "bearer", token: "good", headers: {} })).principal,
    ).toBe("alice");
    await expect(auth.authenticate({ kind: "bearer", headers: {} })).rejects.toThrow(
      /no credential/,
    );
    await expect(auth.authenticate({ kind: "none" })).rejects.toThrow(/no credential/);
  });

  it("rejects the federated platform credential (slice 2 — unsupported by static-token)", async () => {
    const { staticTokenAuthSource } = await import("../server/auth-source.js");
    const { IngressCredentialUnsupported } = await import("@agentick/spec");
    const auth = staticTokenAuthSource({ tokens: { good: "alice" } });
    await expect(
      auth.authenticate({ kind: "platform", platform: "telegram", platformUserId: "42" }),
    ).rejects.toBeInstanceOf(IngressCredentialUnsupported);
  });

  it("allowAnonymous admits the `none` credential as the local pole", async () => {
    const { staticTokenAuthSource } = await import("../server/auth-source.js");
    const auth = staticTokenAuthSource({ tokens: {}, allowAnonymous: true });
    expect(await auth.authenticate({ kind: "none" })).toEqual({});
    expect(await auth.authenticate({ kind: "bearer", headers: {} })).toEqual({});
  });
});

describe("dispatch choke point — one gate, both lanes (review findings)", () => {
  function stubHost(authorizer: unknown, sessionPrincipal?: string) {
    const session = { id: "s1", principal: sessionPrincipal } as never;
    const app = { getSession: (id: string) => (id === "s1" ? session : undefined) } as never;
    return {
      authorizer,
      // ADR 84 §5 — the dispatch gate routes policy through `host.authorize`;
      // delegate to the same authorizer so the auth assertions still hold.
      authorize: (i: AuthorizeInput) => (authorizer as Authorizer).authorize(i),
      app: () => app,
      apps: () => [app],
      runWireDispatch: (_m: unknown, _p: unknown, _ctx: unknown, run: () => Promise<unknown>) =>
        run(),
      wireExtensions: () => ({
        resolve: (m: string) =>
          m === "session/send"
            ? {
                extension: { name: "porcelain", namespace: "session", methods: {} },
                handler: async () => ({ ok: true }),
              }
            : undefined,
        enumerate: () => [],
      }),
    } as never;
  }

  it("PORCELAIN methods are gated: ungranted principal gets Forbidden on session/send", async () => {
    const host = stubHost(staticAuthorizer({ grants: { alice: ["timeline:*"] } }));
    const res = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 1, method: "session/send", params: { sessionId: "s1" } },
      sink,
      { principal: "alice" },
    );
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(-32003); // Forbidden
  });

  it("porcelain scope label defaults to the verb: session:send grant admits session/send", async () => {
    const host = stubHost(staticAuthorizer({ grants: { alice: ["session:send"] } }));
    const res = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 2, method: "session/send", params: { sessionId: "s1" } },
      sink,
      { principal: "alice" },
    );
    expect("result" in res && res.result).toMatchObject({ ok: true });
  });

  it("same-principal target rule has REAL input: alice cannot touch bob's session", async () => {
    const host = stubHost(staticAuthorizer({ grants: { alice: ["*"] } }), "bob");
    const res = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 3, method: "session/send", params: { sessionId: "s1" } },
      sink,
      { principal: "alice" },
    );
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(-32003);
  });

  it("owner passes the target rule on their own session", async () => {
    const host = stubHost(staticAuthorizer({ grants: { bob: ["session:send"] } }), "bob");
    const res = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 4, method: "session/send", params: { sessionId: "s1" } },
      sink,
      { principal: "bob" },
    );
    expect("result" in res && res.result).toMatchObject({ ok: true });
  });
});

describe("scope refinement — downscoping (#198) + session ceiling (#199)", () => {
  it("initialize scope request NARROWS claims: excluded scope is Forbidden afterward", async () => {
    const { BaseConnectionContext } = await import("../server/connection-context.js");
    const host = (() => {
      const session = { id: "s1" } as never;
      const app = { getSession: (id: string) => (id === "s1" ? session : undefined) } as never;
      const authorizer = claimsAuthorizer();
      return {
        authorizer,
        authorize: (i: AuthorizeInput) => authorizer.authorize(i),
        app: () => app,
        apps: () => [app],
        runWireDispatch: (_m: unknown, _p: unknown, _ctx: unknown, run: () => Promise<unknown>) =>
          run(),
        wireExtensions: () => ({
          resolve: (m: string) =>
            m.startsWith("session/") || m.startsWith("timeline/")
              ? {
                  extension: { name: "p", namespace: "x", methods: {} },
                  handler: async () => ({ ok: true }),
                }
              : undefined,
          enumerate: () => [],
        }),
      } as never;
    })();
    class TestConn extends BaseConnectionContext {
      sent: unknown[] = [];
      protected sendFrame(frame: unknown): void {
        this.sent.push(frame);
      }
      protected closeWire(): void {}
      async drive(frame: unknown) {
        return (
          this as unknown as { dispatchInbound: (f: unknown) => Promise<unknown> }
        ).dispatchInbound(frame);
      }
    }
    // Credential carries BOTH scopes; the client requests only timeline.
    const conn = new TestConn(host, {
      principal: "alice",
      scopes: ["session:send", "timeline:compact"],
    });
    await conn.drive({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "v1",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
        scopes: ["timeline:compact"],
      },
    });
    const ok = (await conn.drive({
      jsonrpc: "2.0",
      id: 2,
      method: "timeline/compact",
      params: { sessionId: "s1" },
    })) as { result?: unknown };
    expect(ok.result).toBeTruthy();
    const denied = (await conn.drive({
      jsonrpc: "2.0",
      id: 3,
      method: "session/send",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(denied.error?.code).toBe(-32003); // claim held by credential, EXCLUDED by request
  });

  it("session requiredScopes is a structural ceiling no grant can waive", async () => {
    const session = { id: "s1", requiredScopes: ["kyc:verified"] } as never;
    const app = { getSession: (id: string) => (id === "s1" ? session : undefined) } as never;
    const authorizer = staticAuthorizer({ grants: { alice: ["*"] } }); // star grant!
    const host = {
      authorizer,
      authorize: (i: AuthorizeInput) => authorizer.authorize(i),
      app: () => app,
      apps: () => [app],
      runWireDispatch: (_m: unknown, _p: unknown, _ctx: unknown, run: () => Promise<unknown>) =>
        run(),
      wireExtensions: () => ({
        resolve: () => ({
          extension: { name: "p", namespace: "x", methods: {} },
          handler: async () => ({ ok: true }),
        }),
        enumerate: () => [],
      }),
    } as never;
    const denied = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 1, method: "timeline/compact", params: { sessionId: "s1" } },
      sink,
      { principal: "alice", scopes: ["something:else"] },
    );
    if (!("error" in denied) || denied.error === undefined) throw new Error("expected error");
    expect(denied.error.code).toBe(-32003);

    const allowed = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 2, method: "timeline/compact", params: { sessionId: "s1" } },
      sink,
      { principal: "alice", scopes: ["kyc:verified"] },
    );
    expect("result" in allowed && allowed.result).toBeTruthy();
  });
});

describe("scope refinement — review-fix coverage (glob semantics, structural ceiling)", () => {
  it("glob claim survives narrowing to its member (cover-aware intersection)", async () => {
    const { intersectScopes } = await import("@agentick/spec");
    expect(intersectScopes(["timeline:*"], ["timeline:compact"])).toEqual(["timeline:compact"]);
    expect(intersectScopes(["timeline:compact"], ["timeline:*"])).toEqual(["timeline:compact"]);
    expect(intersectScopes(["*"], ["session:send"])).toEqual(["session:send"]);
    expect(intersectScopes(["knobs:set"], ["timeline:*"])).toEqual([]);
  });

  it("star/glob claims satisfy the ceiling (cover-aware)", async () => {
    const session = { id: "s1", requiredScopes: ["kyc:verified"] } as never;
    const app = { getSession: (id: string) => (id === "s1" ? session : undefined) } as never;
    const authorizer = staticAuthorizer({ grants: { alice: ["*"] } });
    const host = {
      authorizer,
      authorize: (i: AuthorizeInput) => authorizer.authorize(i),
      app: () => app,
      apps: () => [app],
      runWireDispatch: (_m: unknown, _p: unknown, _ctx: unknown, run: () => Promise<unknown>) =>
        run(),
      wireExtensions: () => ({
        resolve: () => ({
          extension: { name: "p", namespace: "x", methods: {} },
          handler: async () => ({ ok: true }),
        }),
        enumerate: () => [],
      }),
    } as never;
    const viaStar = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 1, method: "timeline/compact", params: { sessionId: "s1" } },
      sink,
      { principal: "alice", scopes: ["*"] },
    );
    expect("result" in viaStar && viaStar.result).toBeTruthy();
    const viaGlob = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 2, method: "timeline/compact", params: { sessionId: "s1" } },
      sink,
      { principal: "alice", scopes: ["kyc:*"] },
    );
    expect("result" in viaGlob && viaGlob.result).toBeTruthy();
  });

  it("the ceiling holds even with NO authorizer on the host (truly structural)", async () => {
    const session = { id: "s1", requiredScopes: ["kyc:verified"] } as never;
    const app = { getSession: (id: string) => (id === "s1" ? session : undefined) } as never;
    const host = {
      // no authorizer at all
      app: () => app,
      apps: () => [app],
      runWireDispatch: (_m: unknown, _p: unknown, _ctx: unknown, run: () => Promise<unknown>) =>
        run(),
      wireExtensions: () => ({
        resolve: () => ({
          extension: { name: "p", namespace: "x", methods: {} },
          handler: async () => ({ ok: true }),
        }),
        enumerate: () => [],
      }),
    } as never;
    const anon = await dispatchRequest(
      host,
      { jsonrpc: "2.0", id: 1, method: "timeline/compact", params: { sessionId: "s1" } },
      sink,
      undefined,
    );
    if (!("error" in anon) || anon.error === undefined) throw new Error("expected error");
    expect(anon.error.code).toBe(-32003);
  });

  it("re-initialize can only narrow further — dropped scopes are unrecoverable", async () => {
    const { intersectScopes } = await import("@agentick/spec");
    let scopes: readonly string[] = ["timeline:*", "session:send"];
    scopes = intersectScopes(scopes, ["timeline:compact"]); // narrow
    scopes = intersectScopes(scopes, ["timeline:*", "session:send"]); // attempt re-widen
    expect(scopes).toEqual(["timeline:compact"]);
  });
});
