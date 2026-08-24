/**
 * `app/destroy_session` and `gateway/destroy_session` over the wire — the
 * strongest verb, its app-less twin, and the two ownership gates both must pass.
 *
 * Round-trip first: a session created over the wire is destroyed over the wire,
 * the normalized result crosses as plain JSON, and the durable record is gone.
 *
 * Then the part destroy has to get right that no other `app/*` verb does. The
 * dispatch gate resolves the TARGET session from `params.sessionId` and applies
 * the same-principal rule — but it resolves through the LIVE registry, and
 * destroy's whole point is that it ALSO reaches a session that is no longer
 * live. For such a session the gate sees no target and the rule goes quiet,
 * while the durable record still names its owner. So the handler re-checks the
 * record. Both halves are pinned below; without the second one, the strongest
 * verb in the API would be the one place a caller could act on someone else's
 * thread.
 *
 * The gateway-level twin adds one thing and changes nothing else: ADDRESSING. A
 * client holding a session id from a cross-app listing has no app id beside it,
 * so `gateway/destroy_session` resolves the owning app itself — live registries
 * first, then the apps' session stores — and reports which app it resolved to.
 *
 * Home note (dep graph): mirrors `session-principal.spec.ts` — `@agentick/gateway`
 * does not depend on transport, so this tier is the only one that can wire a real
 * gateway + authorizer against the real dispatch gate.
 *
 * @verifiedBy this file
 * @see packages/gateway/src/wire/app-extension.ts — the `app/destroy_session` handler
 * @see packages/gateway/src/wire/gateway-extension.ts — the `gateway/destroy_session` handler
 * @see packages/transport/src/server/dispatch.ts — `authorizeDispatch` target resolution
 */

import { describe, expect, it } from "vitest";
import {
  type ContentBlock,
  type DestroySessionResult,
  type GatewayDestroySessionResult,
  type IngressIdentity,
  type JsonRpcResponse,
  type ToolHandler,
  SPEC_VERSION,
} from "@agentick/spec";
import { createGateway, staticAuthorizer, permissiveAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

const NULL_ROOT = null as unknown;

function mkAppOptions(maxActive?: number) {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
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
            stopReason: "end" as const,
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
    toolHandlers: new Map<string, ToolHandler>(),
    ...(maxActive !== undefined ? { sessions: { maxActive } } : {}),
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

function resultOf<T>(resp: JsonRpcResponse): T {
  if (!("result" in resp)) throw new Error(`expected a result frame, got ${JSON.stringify(resp)}`);
  return resp.result as T;
}

const IDENTITY_A: IngressIdentity = { principal: "userA", scopes: ["*"] };
const IDENTITY_B: IngressIdentity = { principal: "userB", scopes: ["*"] };

describe("app/destroy_session — wire round-trip", () => {
  it("creates then destroys a session over the wire, deleting the durable record", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    const created = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "app/create_session",
        params: { appId: app.id, eager: true },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const { sessionId } = resultOf<{ sessionId: string }>(created);
    expect(await app.getSessionRecord(sessionId)).toBeDefined();

    const destroyed = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId, reason: "user deleted the thread" },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const result = resultOf<DestroySessionResult>(destroyed);
    expect(result).toEqual({
      sessionId,
      live: {
        found: true,
        abortedExecutions: 0,
        disposedDescendants: 0,
        cancelledDetachedTasks: 0,
      },
      record: { existed: true },
    });

    expect(app.getSession(sessionId)).toBeUndefined();
    expect(await app.getSessionRecord(sessionId)).toBeUndefined();

    // Idempotent across the wire too — a repeat is a success, not a fault.
    const again = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    expect(resultOf<DestroySessionResult>(again).live.found).toBe(false);
    expect(resultOf<DestroySessionResult>(again).record.existed).toBe(false);

    await gateway.close();
  });
});

describe("app/destroy_session — ownership", () => {
  it("the dispatch gate denies a LIVE session owned by another principal", async () => {
    // Both principals hold `*`, so the only thing that can deny is the
    // same-principal target rule reading the session's stamped owner.
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const session = await app.createSession({ principal: "userB", eager: true });

    const denied = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId: session.id },
      },
      stubSink(),
      { identity: IDENTITY_A },
    );
    expect("error" in denied && denied.error).toBeTruthy();
    // Denied means NOT destroyed — the session and its record are intact.
    expect(app.getSession(session.id)).toBeDefined();
    expect(await app.getSessionRecord(session.id)).toBeDefined();

    // Control: the owner destroys it.
    const allowed = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId: session.id },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    expect(resultOf<DestroySessionResult>(allowed).record.existed).toBe(true);
    expect(await app.getSessionRecord(session.id)).toBeUndefined();

    await gateway.close();
  });

  it("the handler denies a NOT-LIVE session whose record names another owner", async () => {
    // The case the dispatch gate structurally cannot cover: no live session, so
    // no target principal for the same-principal rule to read. Only the durable
    // record knows who owns this thread. An LRU page-out (`maxActive: 1`) is the
    // honest way to reach that state through the public API — the harness is
    // gone from the live registry, the record survives.
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions(1) });

    const owned = await app.createSession({
      sessionId: "paged-out",
      principal: "userB",
      eager: true,
    });
    expect(owned.id).toBe("paged-out");
    // Creating a second session evicts the first (soft LRU cap of 1).
    await app.createSession({ sessionId: "keeper" });
    expect(app.getSession("paged-out")).toBeUndefined();
    expect((await app.getSessionRecord("paged-out"))?.principal).toBe("userB");

    const denied = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId: "paged-out" },
      },
      stubSink(),
      { identity: IDENTITY_A },
    );
    expect("error" in denied && denied.error).toBeTruthy();
    expect(await app.getSessionRecord("paged-out")).toBeDefined();

    // The owner reaches the same record and deletes it.
    const allowed = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "app/destroy_session",
        params: { appId: app.id, sessionId: "paged-out" },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const result = resultOf<DestroySessionResult>(allowed);
    expect(result.live.found).toBe(false);
    expect(result.record.existed).toBe(true);
    expect(await app.getSessionRecord("paged-out")).toBeUndefined();

    await gateway.close();
  });
});

describe("gateway/destroy_session — app-less addressing", () => {
  it("resolves the owning app on a multi-app gateway and reports which one", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    // TWO mounted apps, and the target lives on the SECOND — so a handler that
    // guessed the first app, or only ever looked at one, fails here.
    const first = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const second = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await first.createSession({ sessionId: "decoy" });
    await second.createSession({ sessionId: "target", eager: true });

    const destroyed = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        // No appId in the params — that is the whole point of the verb.
        method: "gateway/destroy_session",
        params: { sessionId: "target", reason: "user deleted the thread" },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const result = resultOf<GatewayDestroySessionResult>(destroyed);
    expect(result.appId).toBe(second.id);
    expect(result.sessionId).toBe("target");
    expect(result.live.found).toBe(true);
    expect(result.record.existed).toBe(true);

    // Destroyed on its own app; the decoy on the other app is untouched.
    expect(second.getSession("target")).toBeUndefined();
    expect(await second.getSessionRecord("target")).toBeUndefined();
    expect(first.getSession("decoy")).toBeDefined();

    await gateway.close();
  });

  it("denies a session owned by another principal, resolved through the store", async () => {
    // Paged out (`maxActive: 1`), so BOTH halves are exercised at once: the live
    // registry cannot resolve the app, so `appForSession` has to fall through to
    // the session stores — and the dispatch gate sees no live target, so only the
    // handler's record check stands between userA and userB's thread.
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const owner = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions(1) });

    await owner.createSession({ sessionId: "paged-out", principal: "userB", eager: true });
    await owner.createSession({ sessionId: "keeper" });
    expect(owner.getSession("paged-out")).toBeUndefined();

    const denied = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "gateway/destroy_session",
        params: { sessionId: "paged-out" },
      },
      stubSink(),
      { identity: IDENTITY_A },
    );
    expect("error" in denied && denied.error).toBeTruthy();
    expect(await owner.getSessionRecord("paged-out")).toBeDefined();

    // The owner reaches it — through the store, with no app id supplied.
    const allowed = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "gateway/destroy_session",
        params: { sessionId: "paged-out" },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const result = resultOf<GatewayDestroySessionResult>(allowed);
    expect(result.appId).toBe(owner.id);
    expect(result.live.found).toBe(false);
    expect(result.record.existed).toBe(true);
    expect(await owner.getSessionRecord("paged-out")).toBeUndefined();

    await gateway.close();
  });

  it("is idempotent for a session no mounted app claims — no appId, no fault", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    const resp = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "gateway/destroy_session",
        params: { sessionId: "never-existed" },
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    expect(resultOf<GatewayDestroySessionResult>(resp)).toEqual({
      sessionId: "never-existed",
      live: {
        found: false,
        abortedExecutions: 0,
        disposedDescendants: 0,
        cancelledDetachedTasks: 0,
      },
      record: { existed: false },
    });

    await gateway.close();
  });
});
