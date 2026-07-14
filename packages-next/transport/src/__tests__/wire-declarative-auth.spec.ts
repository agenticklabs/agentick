/**
 * Declarative per-method authorization (ADR 46 `WireExtension.auth`, wired into
 * the ADR 51 §4.1 dispatch choke point).
 *
 * The choke point reads the resolved extension's declared `WireMethodAuth`:
 *   - absent            → verb-derived scope, gated (default; backward-compat).
 *   - `required: false` → OPEN: authorizer policy skipped (ceiling still applies).
 *   - `scope: "role"`   → ADDITIVE: verb-scope AND role, never a relabel
 *                          (ADR 51 §3.3 anti-bypass).
 */

import { describe, expect, it } from "vitest";
import {
  defineWireExtension,
  ErrorCode,
  type AppHarnessProtocol,
  type AuthorizeInput,
  type Authorizer,
  type GatewayHarnessProtocol,
  type IngressIdentity,
  type JsonRpcRequest,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec-next";
import { createWireExtensionRegistry } from "@agentick/gateway-next";

import { dispatchRequest, type DispatchHost, type DispatchSink } from "../server/dispatch.js";

declare module "@agentick/spec-next" {
  interface WireMethods {
    "authX/plain": { params: { sessionId?: string }; result: { ok: true } };
    "authX/open": { params: { sessionId?: string }; result: { ok: true } };
    "authX/scoped": { params: object; result: { ok: true } };
  }
}

const authExt: WireExtension = defineWireExtension({
  name: "@test/authX",
  namespace: "authX",
  version: "0.1.0",
  methods: {
    "authX/plain": async () => ({ ok: true as const }),
    "authX/open": async () => ({ ok: true as const }),
    "authX/scoped": async () => ({ ok: true as const }),
  },
  auth: {
    // authX/plain: no entry → default verb-derived gating (`authX:plain`).
    "authX/open": { required: false }, // open — policy skipped
    "authX/scoped": { required: true, scope: "admin" }, // verb-scope AND admin
  },
});

function stubSink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function req(method: string, params: unknown, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

/** Records every scope the authorizer is asked about; allows only `granted`. */
function recordingAuthorizer(granted: readonly string[]): {
  authorizer: Authorizer;
  seen: string[];
} {
  const seen: string[] = [];
  const authorizer: Authorizer = {
    backend: "test",
    authorize: (input: AuthorizeInput) => {
      seen.push(input.scope);
      return Promise.resolve(
        granted.includes(input.scope) ? { allowed: true } : { allowed: false },
      );
    },
  };
  return { authorizer, seen };
}

function host(
  authorizer: Authorizer | undefined,
  sessions: ReadonlyMap<string, SessionHarnessProtocol> = new Map(),
): DispatchHost {
  const registry = createWireExtensionRegistry();
  registry.register(authExt);
  registry.seal();
  const app = {
    id: "app-1",
    getSession: (id: string) => sessions.get(id),
  } as unknown as AppHarnessProtocol;
  return {
    id: "gw",
    apps: () => [app],
    app: () => app,
    wireExtensions: () => registry,
    authorizer,
    // ADR 84 §5 — `authorizeDispatch` routes its policy calls through
    // `host.authorize`, the real gateway's hookable `authorizer:authorize` op.
    // This fake mirrors that: delegate to the same authorizer so the `seen`
    // recorder observes every scope the gate asks about. Never reached when
    // `authorizer` is undefined (the no-authorizer guard returns first).
    authorize: (input: AuthorizeInput) =>
      authorizer ? authorizer.authorize(input) : Promise.resolve({ allowed: true }),
    runWireDispatch: (_m: unknown, _p: unknown, run: () => Promise<unknown>) => run(),
  } as unknown as GatewayHarnessProtocol;
}

const principal: IngressIdentity = { principal: "p", scopes: [] };

function isOk(resp: Awaited<ReturnType<typeof dispatchRequest>>): boolean {
  return "result" in resp && resp.result !== undefined;
}

describe("declarative per-method auth (ADR 46 + ADR 51 §3.3)", () => {
  it("absent auth entry → gated by the verb-derived scope (backward-compatible)", async () => {
    const { authorizer, seen } = recordingAuthorizer(["authX:plain"]);
    const resp = await dispatchRequest(
      host(authorizer),
      req("authX/plain", {}),
      stubSink(),
      principal,
    );
    expect(isOk(resp)).toBe(true);
    expect(seen).toEqual(["authX:plain"]); // verb-derived label
  });

  it("required:false → OPEN: the authorizer policy is skipped entirely", async () => {
    // An authorizer that grants NOTHING — an open method must still pass, and
    // the authorizer must never be consulted for it.
    const { authorizer, seen } = recordingAuthorizer([]);
    const resp = await dispatchRequest(
      host(authorizer),
      req("authX/open", {}),
      stubSink(),
      principal,
    );
    expect(isOk(resp)).toBe(true);
    expect(seen).toEqual([]); // policy skipped — never asked
  });

  it("scope → ADDITIVE: requires BOTH the verb scope AND the role", async () => {
    const { authorizer, seen } = recordingAuthorizer(["authX:scoped", "admin"]);
    const resp = await dispatchRequest(
      host(authorizer),
      req("authX/scoped", {}),
      stubSink(),
      principal,
    );
    expect(isOk(resp)).toBe(true);
    expect(seen).toEqual(["authX:scoped", "admin"]); // both checked, verb first
  });

  it("anti-bypass (§3.3): the role alone does NOT reach the verb — verb scope still required", async () => {
    // Holds `admin` but NOT `authX:scoped`. A relabel-to-role would let this
    // through; additive semantics deny it (the verb gate is never widened).
    const { authorizer } = recordingAuthorizer(["admin"]);
    const resp = await dispatchRequest(
      host(authorizer),
      req("authX/scoped", {}),
      stubSink(),
      principal,
    );
    expect(isOk(resp)).toBe(false);
    expect("error" in resp && resp.error?.code).toBe(ErrorCode.Forbidden);
  });

  it("additive role is required on top — verb scope alone is not enough", async () => {
    const { authorizer } = recordingAuthorizer(["authX:scoped"]); // missing `admin`
    const resp = await dispatchRequest(
      host(authorizer),
      req("authX/scoped", {}),
      stubSink(),
      principal,
    );
    expect(isOk(resp)).toBe(false);
    expect("error" in resp && resp.error?.code).toBe(ErrorCode.Forbidden);
  });

  it("required:false does NOT waive the session's structural requiredScopes ceiling (#199)", async () => {
    const scoped = { id: "s1", requiredScopes: ["x:need"] } as unknown as SessionHarnessProtocol;
    const sessions = new Map([["s1", scoped]]);
    // Open method, targeting a scoped session, caller lacks the ceiling scope.
    const { authorizer } = recordingAuthorizer([]); // policy would be skipped anyway
    const resp = await dispatchRequest(
      host(authorizer, sessions),
      req("authX/open", { sessionId: "s1" }),
      stubSink(),
      principal, // scopes: [] — does not cover x:need
    );
    expect(isOk(resp)).toBe(false); // ceiling is un-waivable, even for open methods
    expect("error" in resp && resp.error?.code).toBe(ErrorCode.Forbidden);
  });
});
