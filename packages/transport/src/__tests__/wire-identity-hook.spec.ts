/**
 * Per-request ingress identity reaches the wire hook seam (ADR 34/51 §4.1).
 *
 * The gap this closes: an authenticated wire caller's STRUCTURED identity
 * (`IngressIdentity` — `user` record + `scopes`) could not reach a gateway
 * `onBeforeWire<...>` hook. The hook could reshape params but was blind to WHO
 * was calling. This drives the whole seam end-to-end over a REAL
 * `GatewayHarness` through the transport `dispatchRequest` (the identity rides
 * the 4th arg, exactly as a live transport supplies it after ingress-authn):
 *
 *   (1) a gateway `onBeforeWireAppCreateSession` hook reads `ctx.identity` and
 *       STAMPS the caller's principal into `metadata`, OVERRIDING a value the
 *       client smuggled in the request body — the framework-side smuggle-
 *       override proof. The created session's durable record carries the
 *       HOOK-stamped principal, not the body one.
 *   (2) an unauthenticated dispatch (no identity) → `ctx.identity` is
 *       `undefined` and the hook passes params through untouched.
 *   (3) a wire-extension HANDLER reads the full structured `ctx.identity`
 *       (`user` + `scopes`) alongside the legacy `ctx.principal` string.
 *   (4) a hook on a NON-wire op (`onBeforeAppCreateSession`, the inner
 *       `app:create-session` op the wire handler triggers) sees NO identity —
 *       it rides ONLY the `wire:*` op's scope, never leaking into ordinary
 *       command ctx.
 *
 * Home note (dep graph): these tests drive `dispatchRequest`, which lives in
 * `@agentick/transport`. `@agentick/gateway` does NOT depend on transport (the
 * edge runs transport → gateway), so a gateway-package test cannot import
 * `dispatchRequest` without a cycle. This is the same home + pattern as
 * `wire-command-e2e.spec.ts`.
 *
 * @verifiedBy this file
 * @see packages/spec/src/data/events.ts — `EventScope.identity` (the carrier)
 * @see packages/spec/src/wire/extension.ts — `WireExtensionContext.identity`
 */

import { describe, expect, it } from "vitest";
import {
  type ContentBlock,
  type IngressIdentity,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDeclaration,
  type ToolHandler,
  type WireExtension,
  SPEC_VERSION,
  defineWireExtension,
  jsonSchema,
} from "@agentick/spec";
import { createGateway, permissiveAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

// The adopter's wire row — declared exactly as an adopter would (declaration
// merge), so `idcheck/whoami` is a typed method the extension can register.
declare module "@agentick/spec" {
  interface WireMethods {
    "idcheck/whoami": { params: object; result: { ok: boolean } };
  }
}

// The fixture ingress identity — an adopter-shaped `user` record (the
// multi-tenant case that motivated the seam) plus credential scopes.
const IDENTITY: IngressIdentity = {
  principal: "acme/user-42",
  user: { tenantId: "acme", userId: "user-42" },
  scopes: ["session:send", "app:create-session"],
};

const NULL_ROOT = null as unknown;
const ECHO_REF = "h.echo";

function echoTool(): ToolDeclaration {
  return {
    id: "t.echo",
    name: "echo",
    description: "echoes its input.value",
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model", "dispatch"],
    handlerRef: ECHO_REF,
  };
}

/** Minimal real app options (fake model + real compiler), mirroring the live-link test. */
function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  const handler: ToolHandler = async (input) => [
    { type: "text", text: String((input as { value?: unknown }).value) } satisfies ContentBlock,
  ];
  return {
    executor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    compiler: new CompilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
    tools: [echoTool()],
    toolHandlers: new Map<string, ToolHandler>([[ECHO_REF, handler]]),
  };
}

function stubSink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function createSessionReq(appId: string, metadata: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "app/create_session",
    // `eager` so the durable record these tests read back exists at genesis
    // (lazy genesis otherwise defers the write to the first mutation).
    params: { appId, metadata, eager: true },
  };
}

function sessionIdOf(resp: JsonRpcResponse): string {
  if (!("result" in resp)) throw new Error(`expected a result frame, got ${JSON.stringify(resp)}`);
  return (resp.result as { sessionId: string }).sessionId;
}

describe("wire hook seam — per-request ingress identity", () => {
  it("(1) onBeforeWire hook reads ctx.identity and OVERRIDES a client-smuggled principal", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // The adopter override recipe: stamp the AUTHENTICATED caller's principal,
    // clobbering whatever the client put in the body. Blind without ctx.identity.
    gateway.hook({
      onBeforeWireAppCreateSession: (input, ctx) => {
        const stamped = ctx.identity?.user?.userId;
        if (stamped === undefined) return; // unauth → pass through (test 2)
        return { ...input, metadata: { ...input.metadata, principal: String(stamped) } };
      },
    });

    // Client SMUGGLES a principal in the request body — the hook must win.
    const resp = await dispatchRequest(
      gateway,
      createSessionReq(app.id, { principal: "SMUGGLED-BY-CLIENT" }),
      stubSink(),
      { identity: IDENTITY },
    );

    const record = await app.getSessionRecord(sessionIdOf(resp));
    if (!record) throw new Error("session record was not persisted");
    // The HOOK-stamped principal (from identity.user.userId), NOT the body one.
    expect(record.metadata?.principal).toBe("user-42");

    await gateway.close();
  });

  it("(2) unauthenticated dispatch → ctx.identity undefined; params pass through untouched", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    let sawIdentity: IngressIdentity | undefined = IDENTITY; // sentinel — must be overwritten
    gateway.hook({
      onBeforeWireAppCreateSession: (input, ctx) => {
        sawIdentity = ctx.identity;
        const stamped = ctx.identity?.user?.userId;
        if (stamped === undefined) return; // pass through unchanged
        return { ...input, metadata: { ...input.metadata, principal: String(stamped) } };
      },
    });

    // No 4th arg → the local/unauthenticated pole.
    const resp = await dispatchRequest(
      gateway,
      createSessionReq(app.id, { principal: "BODY-VALUE" }),
      stubSink(),
    );

    expect(sawIdentity).toBeUndefined();
    const record = await app.getSessionRecord(sessionIdOf(resp));
    if (!record) throw new Error("session record was not persisted");
    // The hook returned void → the body metadata is honored verbatim.
    expect(record.metadata?.principal).toBe("BODY-VALUE");

    await gateway.close();
  });

  it("(3) a wire-extension handler reads the full structured ctx.identity + the principal string", async () => {
    let captured: { identity?: IngressIdentity; principal?: string } | undefined;
    const ext: WireExtension = defineWireExtension({
      name: "adopter:idcheck",
      namespace: "idcheck",
      methods: {
        "idcheck/whoami": async (_params, ctx) => {
          captured = { identity: ctx.identity, principal: ctx.principal };
          return { ok: true };
        },
      },
    });

    // Permissive authorizer: these tests exercise identity THREADING, not the
    // Authorizer gate (orthogonal, ADR 51). Default `unconfiguredAuthorizer`
    // denies authenticated callers lacking a matching grant — that would block
    // the dispatch BEFORE the ctx the test inspects is even reached.
    const gateway = await createGateway({
      wireExtensions: [ext],
      authorizer: permissiveAuthorizer(),
    });
    await gateway.listen();

    await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 7, method: "idcheck/whoami", params: {} },
      stubSink(),
      { identity: IDENTITY },
    );

    expect(captured).toBeDefined();
    // The full structured object survived — user record + scopes, not just principal.
    expect(captured!.identity).toEqual(IDENTITY);
    expect(captured!.identity?.user).toEqual({ tenantId: "acme", userId: "user-42" });
    expect(captured!.identity?.scopes).toEqual(["session:send", "app:create-session"]);
    // The legacy scalar projection is still populated alongside it.
    expect(captured!.principal).toBe("acme/user-42");

    await gateway.close();
  });

  it("(4) a hook on a NON-wire op sees no identity (no leak into ordinary command ctx)", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    let wireHadIdentity: boolean | undefined;
    let innerHadIdentity: boolean | undefined;

    // The WIRE op hook — SEES the identity (the seam works).
    gateway.hook({
      onBeforeWireAppCreateSession: (input, ctx) => {
        wireHadIdentity = ctx.identity !== undefined;
        return input;
      },
    });
    // The INNER, non-wire `app:create-session` op the handler triggers — the
    // identity rides only the wire op's scope, so this ctx must NOT carry it.
    gateway.hook({
      onBeforeAppCreateSession: (input, ctx) => {
        innerHadIdentity = ctx.identity !== undefined;
        return input;
      },
    });

    await dispatchRequest(gateway, createSessionReq(app.id, {}), stubSink(), {
      identity: IDENTITY,
    });

    expect(wireHadIdentity).toBe(true); // the seam delivered it at the wire boundary
    expect(innerHadIdentity).toBe(false); // …and it did NOT leak into the inner op

    await gateway.close();
  });
});

describe("connection + request coordinates reach the wire ctx", () => {
  it("a stateful transport's connectionId arrives on the handler's ctx", async () => {
    let seen: { connectionId?: string; requestId?: string } | undefined;
    const gateway = await createGateway({
      wireExtensions: [
        {
          name: "coords",
          namespace: "coords",
          methods: {
            "coords/read": (_p: unknown, ctx: unknown) => {
              const c = ctx as { connectionId?: string; requestId?: string };
              seen = { connectionId: c.connectionId, requestId: c.requestId };
              return { ok: true };
            },
          },
        } as never,
      ],
    });
    await gateway.listen();

    await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "coords/read", params: {} } as never,
      stubSink(),
      { connectionId: "conn-SOCKET-1" },
    );

    expect(seen?.connectionId).toBe("conn-SOCKET-1");
    // Always present — every dispatch IS one request, whatever the edge.
    expect(seen?.requestId).toEqual(expect.any(String));
    await gateway.close();
  });

  it("two requests on one connection share the connection and differ by request", async () => {
    const seen: Array<{ connectionId?: string; requestId?: string }> = [];
    const gateway = await createGateway({
      wireExtensions: [
        {
          name: "coords",
          namespace: "coords",
          methods: {
            "coords/read": (_p: unknown, ctx: unknown) => {
              const c = ctx as { connectionId?: string; requestId?: string };
              seen.push({ connectionId: c.connectionId, requestId: c.requestId });
              return { ok: true };
            },
          },
        } as never,
      ],
    });
    await gateway.listen();

    for (const id of [1, 2]) {
      await dispatchRequest(
        gateway,
        { jsonrpc: "2.0", id, method: "coords/read", params: {} } as never,
        stubSink(),
        { connectionId: "conn-SOCKET-1" },
      );
    }

    expect(seen[0]!.connectionId).toBe(seen[1]!.connectionId);
    // Server-minted, so two clients both sending JSON-RPC id `1` never collide.
    expect(seen[0]!.requestId).not.toBe(seen[1]!.requestId);
    await gateway.close();
  });

  it("a stateless edge leaves connectionId undefined rather than inventing one", async () => {
    let seen: { connectionId?: string } | undefined;
    const gateway = await createGateway({
      wireExtensions: [
        {
          name: "coords",
          namespace: "coords",
          methods: {
            "coords/read": (_p: unknown, ctx: unknown) => {
              seen = { connectionId: (ctx as { connectionId?: string }).connectionId };
              return { ok: true };
            },
          },
        } as never,
      ],
    });
    await gateway.listen();

    await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "coords/read", params: {} } as never,
      stubSink(),
    );

    expect(seen?.connectionId).toBeUndefined();
    await gateway.close();
  });
});

describe("the connection id a client is told is the one the server addresses it by", () => {
  it("returns the SAME id at handshake that later dispatches carry", async () => {
    // The round trip nothing asserted: `initialize` used to mint its own id and
    // hand the client a value nothing else in the system used, so a client
    // comparing an addressed `target` against its own id could never match.
    let dispatched: string | undefined;
    const gateway = await createGateway({
      wireExtensions: [
        {
          name: "coords",
          namespace: "coords",
          methods: {
            "coords/read": (_p: unknown, ctx: unknown) => {
              dispatched = (ctx as { connectionId?: string }).connectionId;
              return { ok: true };
            },
          },
        } as never,
      ],
    });
    await gateway.listen();

    const connection = { connectionId: "conn-SOCKET-1" };

    const handshake = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "v1" } } as never,
      stubSink(),
      connection,
    );
    await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 2, method: "coords/read", params: {} } as never,
      stubSink(),
      connection,
    );

    const told = (handshake as { result: { connectionId: string } }).result.connectionId;
    expect(told).toBe("conn-SOCKET-1");
    expect(told).toBe(dispatched);
    await gateway.close();
  });

  it("a stateless edge is told its request id — unique, and never a socket it does not have", async () => {
    const gateway = await createGateway();
    await gateway.listen();

    const first = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "v1" } } as never,
      stubSink(),
    );
    const second = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "v1" } } as never,
      stubSink(),
    );

    const a = (first as { result: { connectionId: string } }).result.connectionId;
    const b = (second as { result: { connectionId: string } }).result.connectionId;
    expect(a).toEqual(expect.any(String));
    expect(a).not.toBe(b);
    await gateway.close();
  });
});
