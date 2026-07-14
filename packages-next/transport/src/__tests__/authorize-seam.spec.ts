/**
 * The authorize op seam (ADR 84 §5 — the fine contextual auth layer).
 *
 * `authorizeDispatch` routes its POLICY calls through `host.authorize`, the
 * gateway's hookable `authorizer:authorize` op (NOT the raw
 * `host.authorizer.authorize`). So a gateway-scoped `onBeforeAuthorizerAuthorize`
 * hook fires around each policy ask and can augment the `AuthorizeInput` (grant
 * a contextual scope) or throw to deny; `onAfterAuthorizerAuthorize` observes
 * the `AuthorizeResult`.
 *
 * These use the REAL `GatewayHarness` (not a hand-rolled fake) so the op
 * actually runs. They prove:
 *   - a contextual `onBeforeAuthorizerAuthorize` scope flips a policy DENY to an
 *     ALLOW around a live dispatch, and `onAfterAuthorizerAuthorize` sees it,
 *   - the STRUCTURAL ceiling (`requiredScopes`) still denies regardless of ANY
 *     authorize hook — it is checked BEFORE and OUTSIDE the op, so the hook
 *     never even fires (un-waivability).
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  defineWireExtension,
  type AuthorizeResult,
  type JsonRpcRequest,
  type WireExtension,
} from "@agentick/spec-next";
import { claimsAuthorizer, createGateway } from "@agentick/gateway-next";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

// Synthetic wire method for these tests. `authz/probe` derives verb scope
// `authz:probe` — a fresh namespace, no collision with framework methods.
declare module "@agentick/spec-next" {
  interface WireMethods {
    "authz/probe": { params: { echo: string }; result: { echoed: string } };
  }
}

const probeExt: WireExtension = defineWireExtension({
  name: "@test/authz-probe",
  namespace: "authz",
  methods: {
    "authz/probe": async ({ echo }) => ({ echoed: echo }),
  },
});

/** Minimal AppHarness construction stub (no real React / model needed). */
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
    reconciler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

function sink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function req(method: string, params: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

describe("authorizeDispatch — the fine contextual auth layer (ADR 84 §5)", () => {
  it("onBeforeAuthorizerAuthorize grants a contextual scope, flipping a policy DENY to ALLOW; onAfter observes", async () => {
    // claimsAuthorizer allows iff the caller's token scopes cover the asked
    // scope. `alice` carries NO scopes → the verb `authz:probe` is denied.
    const gw = await createGateway({ authorizer: claimsAuthorizer(), wireExtensions: [probeExt] });

    // Baseline (no hook): the policy denies — Forbidden, no result.
    const denied = await dispatchRequest(gw, req("authz/probe", { echo: "x" }), sink(), {
      principal: "alice",
      scopes: [],
    });
    expect("error" in denied && denied.error).toBeTruthy();
    expect("result" in denied).toBe(false);

    // The fine contextual layer: grant EXACTLY the scope being asked, from
    // request context (here, unconditionally — a real gate would inspect the
    // request). Plus an observer of the decision.
    const observed: AuthorizeResult[] = [];
    gw.hook({
      onBeforeAuthorizerAuthorize: (input) => ({
        ...input,
        tokenScopes: [...(input.tokenScopes ?? []), input.scope],
      }),
      onAfterAuthorizerAuthorize: (result) => {
        observed.push(result);
        return result;
      },
    });

    const allowed = await dispatchRequest(gw, req("authz/probe", { echo: "x" }), sink(), {
      principal: "alice",
      scopes: [],
    });
    // The contextual grant flipped the decision — the handler ran.
    expect("result" in allowed && allowed.result).toEqual({ echoed: "x" });
    // onAfterAuthorizerAuthorize observed an allow.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((r) => r.allowed)).toBe(true);

    await gw.close();
  });

  it("the structural requiredScopes ceiling denies regardless of ANY authorize hook — the hook never fires (un-waivable)", async () => {
    const gw = await createGateway({ authorizer: claimsAuthorizer(), wireExtensions: [probeExt] });
    await gw.listen();
    const app = await gw.createApp({
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    // A session with a structural ceiling: callers MUST hold `kyc:verified`.
    await app.createSession({ sessionId: "s1", requiredScopes: ["kyc:verified"] });

    // A maximally-permissive authorize hook: it would grant EVERYTHING if it
    // ran. The ceiling must still win — and the hook must never even fire.
    let hookFired = 0;
    gw.hook({
      onBeforeAuthorizerAuthorize: (input) => {
        hookFired++;
        return { ...input, tokenScopes: ["*"] };
      },
    });

    // `alice` holds the verb scope but NOT the ceiling scope.
    const resp = await dispatchRequest(
      gw,
      req("authz/probe", { echo: "x", sessionId: "s1" }),
      sink(),
      {
        principal: "alice",
        scopes: ["authz:probe"],
      },
    );

    // Denied by the structural ceiling.
    expect("error" in resp && resp.error).toBeTruthy();
    expect("result" in resp).toBe(false);
    // The ceiling ran BEFORE (and outside) the authorize op — so the op, and
    // its hook, never fired. No hook could have widened the ceiling.
    expect(hookFired).toBe(0);

    await gw.close();
  });
});
