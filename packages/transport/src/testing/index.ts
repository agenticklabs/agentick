/**
 * `runIngressAuthnConformance` — the ingress-authentication conformance
 * suite (ADR 61 slice 1). Every transport runs it against a REAL server.
 *
 * The suite is credential-model aware:
 *
 *   - **bearer** transports (ws, http): a token → principal table drives
 *     the "valid bearer stamps a principal" / "invalid or missing is
 *     refused at the edge" / "prototype-key bypass" assertions, plus the
 *     once-per-crossing proof (per-connection for ws, per-request for
 *     http — two crossings on one session must NOT bleed identity).
 *   - **none** transports (unix socket): host-local trust. The crossing
 *     always carries `credential.kind: "none"`; the assertions are
 *     local-pole-by-default, fail-closed-when-a-source-rejects-`none`,
 *     and admitted-with-no-principal under `allowAnonymous`.
 *
 * The suite observes "what dispatch saw" via a {@link spyAuthorizer} the
 * factory installs on the gateway — it records the principal of every
 * authorized dispatch and always allows, isolating the authn seam under
 * test from any authorization policy.
 *
 * @see docs/proposals/v2/blueprint/61-ingress-authentication.md
 */

import { describe, expect, it } from "vitest";
import type {
  AuthSource,
  Authorizer,
  GatewayHarnessProtocol,
  IngressAdmissionFailure,
} from "@agentick/spec";
import { GATEWAY_ADMISSION_FAILED } from "@agentick/spec";

import { staticTokenAuthSource } from "../server/auth-source.js";

/** Canonical token → principal fixtures the bearer conformance uses. */
export const INGRESS_AUTHN_TOKENS = {
  alice: "tok-alice",
  bob: "tok-bob",
} as const;

/**
 * The `AuthSource` the bearer conformance expects: a static-token table
 * mapping the canonical fixtures to `alice` / `bob`. `allowAnonymous`
 * exercises the local-pole admission path (used by the `none` suite).
 */
export function ingressAuthnAuthSource(opts?: { readonly allowAnonymous?: boolean }): AuthSource {
  return staticTokenAuthSource({
    tokens: {
      [INGRESS_AUTHN_TOKENS.alice]: "alice",
      [INGRESS_AUTHN_TOKENS.bob]: "bob",
    },
    ...(opts?.allowAnonymous ? { allowAnonymous: true } : {}),
  });
}

/**
 * Collect every `gateway:admission:failed` event a gateway publishes (ADR 92
 * §Family 1.3). Attach at server setup, BEFORE any crossing — the events are
 * observed live, not replayed.
 *
 * Each transport factory wires this and returns `admissionFailures` on its
 * {@link IngressAuthnServer}, so the "a refused crossing leaves a trace" law is
 * asserted once in the conformance suite and enforced at every edge.
 */
export function collectAdmissionFailures(gateway: GatewayHarnessProtocol): {
  /** Failures seen so far. Settles the bus fan-out before reading. */
  readonly admissionFailures: () => Promise<readonly IngressAdmissionFailure[]>;
  /** Detach the collector (call from the factory's teardown). */
  readonly stop: () => void;
} {
  const seen: IngressAdmissionFailure[] = [];
  const stream = gateway.events({
    surface: "gateway",
    name: { exact: GATEWAY_ADMISSION_FAILED },
  });
  const iterator = stream[Symbol.asyncIterator]();
  let stopped = false;

  void (async () => {
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done === true) break;
        seen.push(next.value.payload as IngressAdmissionFailure);
      }
    } catch {
      // The stream tears down with the gateway; nothing left to collect.
    }
  })();

  return {
    admissionFailures: async () => {
      // One macrotask for the bus fan-out to reach this subscriber.
      await new Promise((r) => setTimeout(r, 20));
      return [...seen];
    },
    stop: () => {
      stopped = true;
      void iterator.return?.();
    },
  };
}

/** A spy Authorizer: allows every dispatch, records each principal seen. */
export function spyAuthorizer(): {
  readonly authorizer: Authorizer;
  readonly seen: (string | undefined)[];
} {
  const seen: (string | undefined)[] = [];
  return {
    seen,
    authorizer: {
      backend: "spy",
      authorize: (input) => {
        seen.push(input.principal);
        return Promise.resolve({ allowed: true });
      },
    },
  };
}

/**
 * A live server under test, handed to the conformance body. Each method
 * performs REAL crossings through the transport and reports the
 * principal dispatch observed (undefined = local pole), or rejects when
 * the edge refused the crossing.
 */
export interface IngressAuthnServer {
  /**
   * One crossing carrying `token` (undefined = no credential). Resolves
   * with the principal dispatch observed. REJECTS if the edge refused
   * the crossing (401 / socket destroyed) — the suite uses rejection to
   * distinguish an edge refusal from a local-pole fallthrough.
   */
  crossing(token?: string): Promise<{ principal?: string }>;
  /**
   * Every `gateway:admission:failed` event this server's gateway has
   * published so far (ADR 92 §Family 1.3), in order. Required of every edge:
   * a refused crossing that leaves no trace is the gap this closes, so the
   * law is asserted at every transport rather than one.
   */
  admissionFailures(): Promise<readonly IngressAdmissionFailure[]>;
  /**
   * Two crossings over ONE transport session, carrying `tokenA` then
   * `tokenB`. Per-connection transports return the connection identity
   * for both (authenticate-once); per-request transports return each
   * request's own identity (proving no cross-request bleed).
   */
  twoCrossingsOneSession(
    tokenA: string,
    tokenB: string,
  ): Promise<{ first?: string; second?: string }>;
}

/** Transport-specific wiring the conformance suite drives. */
export interface IngressAuthnFactory {
  readonly kind: "websocket" | "http" | "unix";
  readonly credentialModel: "bearer" | "none";
  readonly crossingModel: "per-connection" | "per-request";
  /**
   * Start a REAL server bound to a fresh gateway (with a spy authorizer)
   * and the given `authSource`, run `body`, then tear everything down.
   */
  withServer<T>(
    opts: { readonly authSource?: AuthSource },
    body: (server: IngressAuthnServer) => Promise<T>,
  ): Promise<T>;
}

export function runIngressAuthnConformance(factory: IngressAuthnFactory): void {
  const { alice, bob } = INGRESS_AUTHN_TOKENS;
  const bearer = factory.credentialModel === "bearer";
  const none = factory.credentialModel === "none";

  // Capability-gated via `it.runIf` (not `if`-wrapped tests) — the
  // codebase idiom, and it keeps the skipped branch visible in the
  // reporter rather than silently absent.
  describe(`ingress authn conformance — ${factory.kind}`, () => {
    // ── bearer transports (ws, http) ──────────────────────────────────
    it.runIf(bearer)(
      "configured AuthSource + valid bearer → principal stamped, dispatch sees it",
      async () => {
        await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
          const { principal } = await server.crossing(alice);
          expect(principal).toBe("alice");
        });
      },
    );

    it.runIf(bearer)(
      "missing credential → refused at the edge, never local-pole fallthrough",
      async () => {
        await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
          // Rejection (not a resolve with principal:undefined) is the
          // proof the edge failed closed instead of admitting the pole.
          await expect(server.crossing(undefined)).rejects.toBeDefined();
        });
      },
    );

    it.runIf(bearer)("invalid credential → refused at the edge", async () => {
      await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
        await expect(server.crossing("not-a-real-token")).rejects.toBeDefined();
      });
    });

    it.runIf(bearer)("prototype-key token is refused at the edge (bypass guard)", async () => {
      await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
        await expect(server.crossing("__proto__")).rejects.toBeDefined();
      });
    });

    it.runIf(bearer)("no AuthSource → local pole, no principal", async () => {
      await factory.withServer({}, async (server) => {
        // Token is presented but ignored — no source, no principal.
        const { principal } = await server.crossing(alice);
        expect(principal).toBeUndefined();
      });
    });

    it.runIf(bearer && factory.crossingModel === "per-connection")(
      "authenticates ONCE per connection — two dispatches share one identity",
      async () => {
        await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
          const { first, second } = await server.twoCrossingsOneSession(alice, bob);
          // Identity is pinned at the crossing; the second frame's token
          // is moot on a stateful connection.
          expect(first).toBe("alice");
          expect(second).toBe("alice");
        });
      },
    );

    it.runIf(bearer && factory.crossingModel === "per-request")(
      "authenticates PER REQUEST — two crossings on one session, no identity bleed",
      async () => {
        await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
          const { first, second } = await server.twoCrossingsOneSession(alice, bob);
          expect(first).toBe("alice");
          expect(second).toBe("bob");
        });
      },
    );

    // ── host-local trust transports (unix socket) ─────────────────────
    it.runIf(none)("no AuthSource → local pole, no principal (host-local trust)", async () => {
      await factory.withServer({}, async (server) => {
        const { principal } = await server.crossing(undefined);
        expect(principal).toBeUndefined();
      });
    });

    it.runIf(none)(
      "configured AuthSource rejecting `none` → crossing refused (fail closed)",
      async () => {
        await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
          await expect(server.crossing(undefined)).rejects.toBeDefined();
        });
      },
    );

    it.runIf(none)(
      "configured AuthSource with allowAnonymous → admitted, no principal",
      async () => {
        await factory.withServer(
          { authSource: ingressAuthnAuthSource({ allowAnonymous: true }) },
          async (server) => {
            const { principal } = await server.crossing(undefined);
            expect(principal).toBeUndefined();
          },
        );
      },
    );

    // ── admission-failure visibility (ADR 92 §Family 1.3) ─────────────
    //
    // A refused crossing produces no operation — nothing ran — so without
    // this event a client probing an edge leaves NO trace at all. Every
    // transport must publish it; the `none` edge refuses an unacceptable
    // anonymous crossing, the bearer edges refuse a bad token.

    it("a refused crossing publishes gateway:admission:failed", async () => {
      await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
        // `none` edges have no token to send; their AuthSource refuses the
        // anonymous crossing outright, which is the same admission refusal.
        await expect(
          server.crossing(bearer ? "not-a-real-token" : undefined),
        ).rejects.toBeDefined();

        const failures = await server.admissionFailures();
        expect(failures).toHaveLength(1);
        expect(failures[0]!.failureClass).toBe("authenticate");
        expect(failures[0]!.transportKind).toBe(factory.kind);
      });
    });

    it("the admission-failure payload never carries credential material", async () => {
      await factory.withServer({ authSource: ingressAuthnAuthSource() }, async (server) => {
        const secret = "tok-super-secret";
        await expect(server.crossing(bearer ? secret : undefined)).rejects.toBeDefined();

        const failures = await server.admissionFailures();
        expect(failures).toHaveLength(1);
        const serialized = JSON.stringify(failures[0]);
        // Neither the token nor a header bag may reach the audit trail.
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain("Bearer");
        expect(serialized).not.toContain("authorization");
        expect(Object.keys(failures[0]!)).not.toContain("credential");
      });
    });

    it("an ADMITTED crossing publishes nothing", async () => {
      await factory.withServer(
        {
          authSource: bearer
            ? ingressAuthnAuthSource()
            : ingressAuthnAuthSource({ allowAnonymous: true }),
        },
        async (server) => {
          await server.crossing(bearer ? alice : undefined);
          expect(await server.admissionFailures()).toHaveLength(0);
        },
      );
    });

    it("no AuthSource → the local pole is admitted, never reported", async () => {
      await factory.withServer({}, async (server) => {
        await server.crossing(bearer ? alice : undefined);
        expect(await server.admissionFailures()).toHaveLength(0);
      });
    });
  });
}
