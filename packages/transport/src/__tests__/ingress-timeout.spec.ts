/**
 * The ingress-authentication wall-clock ceiling (ADR 61).
 *
 * An `AuthSource` is adopter code that talks to the network — a JWKS fetch, an
 * OAuth introspection call. If it never settles, the crossing never settles
 * either: the HTTP request hangs and the WebSocket upgrade leaks its socket.
 * Neither edge had a ceiling, and neither could grow one on its own — the
 * `await authSource.authenticate(...)` lives here, at the shared seam, so the
 * bound belongs here too and every edge inherits it.
 *
 * The default is applied by the helper, not by its callers: an edge that
 * forgets to pass a ceiling is still bounded.
 *
 * Every assertion below is a BOUNDED race. Awaiting an unbounded crossing
 * directly would express the bug as a runner timeout; racing it turns the hang
 * into an ordinary failed expectation.
 */

import { describe, expect, it, vi } from "vitest";
import type { AuthSource, IngressAdmissionFailure, IngressContext } from "@agentick/spec";

import { authenticateIngress, DEFAULT_INGRESS_AUTHN_TIMEOUT_MS } from "../server/ingress.js";

const CONTEXT: IngressContext = {
  transportKind: "http",
  credential: { kind: "bearer", token: "tok-secret", headers: {} },
  connectionId: "conn-1",
};

/** An `AuthSource` that never settles — the hung-dependency case. */
function hungAuthSource(): AuthSource {
  return { backend: "hung", authenticate: () => new Promise(() => {}) };
}

type Settlement =
  | { readonly state: "admitted"; readonly value: IngressContext }
  | { readonly state: "refused"; readonly error: unknown }
  | { readonly state: "hung" };

/** Race a crossing against a test ceiling so a hang is an assertion, not a timeout. */
async function settle(crossing: Promise<IngressContext>, testCeilingMs = 500): Promise<Settlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<Settlement>([
      crossing.then(
        (value) => ({ state: "admitted", value }) as const,
        (error: unknown) => ({ state: "refused", error }) as const,
      ),
      new Promise<Settlement>((resolve) => {
        timer = setTimeout(() => resolve({ state: "hung" }), testCeilingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("authenticateIngress — wall-clock ceiling", () => {
  it("REFUSES a crossing whose AuthSource never settles", async () => {
    const outcome = await settle(authenticateIngress(CONTEXT, hungAuthSource(), { timeoutMs: 50 }));
    expect(outcome.state).toBe("refused");
  });

  it("the refusal is an Error naming the ceiling it exceeded", async () => {
    const outcome = await settle(authenticateIngress(CONTEXT, hungAuthSource(), { timeoutMs: 50 }));
    expect(outcome.state).toBe("refused");
    const error = (outcome as { error?: unknown }).error;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/50/);
  });

  it("a timed-out crossing leaves an admission-failure trace", async () => {
    const seen: IngressAdmissionFailure[] = [];
    const outcome = await settle(
      authenticateIngress(CONTEXT, hungAuthSource(), {
        timeoutMs: 50,
        onRejected: (f) => seen.push(f),
      }),
    );
    expect(outcome.state).toBe("refused");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.failureClass).toBe("authenticate");
    expect(seen[0]!.transportKind).toBe("http");
    expect(seen[0]!.connectionId).toBe("conn-1");
    // The audit trail never learns the credential (ADR 92 §Family 1.3).
    expect(JSON.stringify(seen[0])).not.toContain("tok-secret");
  });

  it("applies a DEFAULT ceiling when the caller configures none", async () => {
    vi.useFakeTimers();
    try {
      // Never awaited directly — an unbounded crossing would hang the runner.
      let state: string | undefined;
      void authenticateIngress(CONTEXT, hungAuthSource()).then(
        () => (state = "admitted"),
        () => (state = "refused"),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_AUTHN_TIMEOUT_MS + 1);
      expect(state).toBe("refused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default ceiling is 10s — long enough for a real JWKS fetch", () => {
    expect(DEFAULT_INGRESS_AUTHN_TIMEOUT_MS).toBe(10_000);
  });

  it("an AuthSource that settles under the ceiling is untouched", async () => {
    const source: AuthSource = {
      backend: "slow",
      authenticate: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { principal: "alice" };
      },
    };
    const outcome = await settle(authenticateIngress(CONTEXT, source, { timeoutMs: 500 }));
    expect(outcome.state).toBe("admitted");
    expect((outcome as { value: IngressContext }).value.identity?.principal).toBe("alice");
  });

  it("a REJECTING AuthSource still surfaces its own error, not the ceiling's", async () => {
    const source: AuthSource = {
      backend: "rejecting",
      authenticate: () => Promise.reject(new Error("bad token")),
    };
    const outcome = await settle(authenticateIngress(CONTEXT, source, { timeoutMs: 500 }));
    expect(outcome.state).toBe("refused");
    expect(((outcome as { error: Error }).error as Error).message).toBe("bad token");
  });

  it("the local pole (no AuthSource) never waits on a ceiling", async () => {
    const outcome = await settle(authenticateIngress(CONTEXT, undefined, { timeoutMs: 1 }));
    expect(outcome.state).toBe("admitted");
    expect((outcome as { value: IngressContext }).value.identity).toBeUndefined();
  });

  it("`timeoutMs: Infinity` opts out — for a deliberately interactive AuthSource", async () => {
    const outcome = await settle(
      authenticateIngress(CONTEXT, hungAuthSource(), { timeoutMs: Infinity }),
      120,
    );
    expect(outcome.state).toBe("hung");
  });
});
