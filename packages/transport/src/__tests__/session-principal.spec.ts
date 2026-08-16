/**
 * The session-principal completion (ADR 48) — the owning principal is STAMPED
 * at session creation and the wire dispatch gate READS it (the same-principal
 * target rule finally has real input).
 *
 * Before this work the `SessionHarnessProtocol.principal` field existed but
 * nothing populated it, so the gate's same-principal rule was structurally
 * dead. These tests drive the REAL `GatewayHarness` through the transport
 * `dispatchRequest` (identity rides the 4th arg exactly as a live transport
 * supplies it post-ingress-authn) and prove:
 *
 *   (1) `app/create_session` stamps the AUTHENTICATED caller's principal onto
 *       the session harness AND its durable `SessionRecord`.
 *   (2) a `principal` smuggled in the request BODY is ignored — the wire params
 *       type carries no such field; ownership is the edge's to assert.
 *   (3) an unauthenticated dispatch leaves the session unstamped.
 *   (4) HEADLINE — the same-principal gate ENGAGES: a session owned by userB,
 *       reached by caller userA (who holds a `*` grant), is DENIED purely by
 *       the target-principal rule; the owner userA→A / userB→B control passes.
 *       This is the test that makes ADR-48 real: the denial can only happen if
 *       the stamped principal reached `authorizeDispatch`'s target resolution.
 *
 * Home note (dep graph): these drive `dispatchRequest` (in `@agentick/transport`).
 * `@agentick/gateway` does NOT depend on transport, so this is the only tier
 * that can wire a real gateway + authorizer against the real dispatch gate —
 * the same home + pattern as `wire-identity-hook.spec.ts`.
 *
 * @verifiedBy this file
 * @see packages/gateway/src/wire/app-extension.ts — the `app/create_session` stamp
 * @see packages/transport/src/server/dispatch.ts — `authorizeDispatch` target resolution
 * @see packages/gateway/src/authorizers.ts — `sameTarget` (the same-principal rule)
 */

import { describe, expect, it } from "vitest";
import {
  type ContentBlock,
  type IngressIdentity,
  type JsonRpcResponse,
  type ToolDeclaration,
  type ToolHandler,
  SPEC_VERSION,
  jsonSchema,
} from "@agentick/spec";
import { createGateway, permissiveAuthorizer, staticAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

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

/** Minimal real app options (fake model + real compiler), mirroring wire-identity-hook. */
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

function sessionIdOf(resp: JsonRpcResponse): string {
  if (!("result" in resp)) throw new Error(`expected a result frame, got ${JSON.stringify(resp)}`);
  return (resp.result as { sessionId: string }).sessionId;
}

const IDENTITY_B: IngressIdentity = { principal: "userB", scopes: ["*"] };
const IDENTITY_A: IngressIdentity = { principal: "userA", scopes: ["*"] };

describe("session-principal — stamped at creation, read by the gate (ADR 48)", () => {
  it("(1) app/create_session stamps the caller's principal onto the harness + record", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    const resp = await dispatchRequest(
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
    const sessionId = sessionIdOf(resp);

    // On the live harness (what the dispatch gate reads).
    expect(app.getSession(sessionId)?.principal).toBe("userB");
    // …and on the durable record (the resume index carries ownership).
    const record = await app.getSessionRecord(sessionId);
    expect(record?.principal).toBe("userB");

    await gateway.close();
  });

  it("(2) a principal smuggled in the request body is IGNORED (edge asserts ownership)", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    const resp = await dispatchRequest(
      gateway,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "app/create_session",
        // `principal` is NOT a member of AppCreateSessionParams — smuggled as an
        // untyped extra; the handler never destructures it.
        params: { appId: app.id, eager: true, principal: "SMUGGLED-BY-CLIENT" } as Record<
          string,
          unknown
        >,
      },
      stubSink(),
      { identity: IDENTITY_B },
    );
    const sessionId = sessionIdOf(resp);

    // The authenticated identity wins; the body value is never read.
    expect(app.getSession(sessionId)?.principal).toBe("userB");
    expect((await app.getSessionRecord(sessionId))?.principal).toBe("userB");

    await gateway.close();
  });

  it("(3) an unauthenticated dispatch leaves the session unstamped", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // No 4th arg → the local / unauthenticated pole.
    const resp = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "app/create_session", params: { appId: app.id } },
      stubSink(),
    );
    const sessionId = sessionIdOf(resp);

    expect(app.getSession(sessionId)?.principal).toBeUndefined();
    expect((await app.getSessionRecord(sessionId))?.principal).toBeUndefined();

    await gateway.close();
  });

  it("(4) HEADLINE — the same-principal gate ENGAGES on the stamped principal", async () => {
    // Both principals hold a `*` grant, so the ONLY thing that can deny is the
    // target-principal rule — the denial proves the stamp reached the gate.
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // A session OWNED BY userB (host-door stamp — also proves the host door).
    const session = await app.createSession({ principal: "userB" });
    expect(session.principal).toBe("userB");

    // Caller userA reaches userB's session → DENIED by the same-principal rule.
    const denied = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 1, method: "session/list_tools", params: { sessionId: session.id } },
      stubSink(),
      { identity: IDENTITY_A },
    );
    expect("error" in denied && denied.error).toBeTruthy();
    expect("result" in denied).toBe(false);

    // Control — the OWNER (userB) reaches the same session → ALLOWED.
    const allowed = await dispatchRequest(
      gateway,
      { jsonrpc: "2.0", id: 2, method: "session/list_tools", params: { sessionId: session.id } },
      stubSink(),
      { identity: IDENTITY_B },
    );
    expect("result" in allowed).toBe(true);
    expect("error" in allowed && allowed.error).toBeFalsy();

    await gateway.close();
  });
});
