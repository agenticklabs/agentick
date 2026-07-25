/**
 * Tier-3 structural interceptor inheritance (ADR 76) as LIVE inheritance down
 * the construction tree (ADR 83 §4). A harness's effective interceptor list is
 * its construction-ANCESTORS' interceptors (broader scope, root-outermost)
 * wrapping its own, wrapping the body. The inherited layer is SEEDED at the
 * child's construction from `parent.resolvedInterceptors()` (so a child inherits
 * everything registered before it existed) AND kept LIVE via `interceptorParent`
 * (so a registration on the parent AFTER the child exists pushes down to it, and
 * the parent's unsubscribe cascades the removal). No per-op parent walk — each
 * harness reads only its local merged list; the push/pull keeps that list
 * current. This generalizes the hook cascade (ADR 82) from a frozen fold to a
 * live relation, closing the late-registration gap the fold gave up.
 *
 * Scope note (post-flat-topology finding): tier 3 is for construction
 * parent→child relationships — `app → session` (deployment-global concerns on
 * session ops) and `session → its per-session bridges`. The SHARED spine
 * harnesses (loop/executor/tool) are construction-siblings, NOT children — a
 * session-scoped concern around the model call is tier 4, not tier 3.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { BaseHarness, type Middleware } from "@agentick/runtime";
import type {
  HandlerVerdict,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

class TierHarness extends BaseHarness<"tool"> {
  constructor(id: string, parent?: TierHarness) {
    super(
      "tool",
      id,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      // ADR 83 §4 — pull-seed the inherited layer from the parent's CURRENT
      // resolved interceptors AND register as a live child (`interceptorParent`)
      // so later parent registrations push down too.
      parent
        ? { inheritedInterceptors: parent.resolvedInterceptorsForTest(), interceptorParent: parent }
        : {},
    );
  }

  /** Public test accessor for the `protected resolvedInterceptors()` value. */
  resolvedInterceptorsForTest(): readonly Middleware<unknown, unknown, unknown>[] {
    return this.resolvedInterceptors();
  }

  opFx(name: string): Effect.Effect<number, unknown, never> {
    const op: Operation<{ n: number }, number> = {
      opId: `tool:${name}:1`,
      surface: "tool",
      name: `tool:${name}`,
      scope: {},
      input: { n: 1 },
    };
    return this.runOperation(op, (i) => Effect.succeed(i.n));
  }

  /**
   * Register an Effect-native middleware through the OWN-registration funnel
   * (`registerEffectMiddleware` → `registerOwn`), so a late registration
   * propagates to live descendants — the behavior under test.
   */
  useMw(mw: Middleware<unknown, unknown, unknown>): () => void {
    return this.registerEffectMiddleware(mw);
  }

  onBefore(fn: (input: { n: number }) => HandlerVerdict<number> | void): () => void {
    // ADR 83: before-verdict handler → `guard()` sugar.
    return this.guard<{ n: number }, number>((input) => fn(input));
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }
}

async function mk(id: string, parent?: TierHarness): Promise<TierHarness> {
  const h = new TierHarness(id, parent);
  await h.ready;
  return h;
}

describe("Tier-3 structural interceptor inheritance (ADR 76/83) — live inheritance", () => {
  it("a child op is wrapped by its ANCESTOR's middleware, root-outermost", async () => {
    const parent = await mk("app");
    // Register on the ancestor BEFORE constructing the child — the pull-seed
    // snapshots it into the child's inherited layer (unchanged behavior).
    const order: string[] = [];
    parent.useMw((input, next) => {
      order.push("app");
      return next(input);
    });
    const child = await mk("session", parent);
    child.useMw((input, next) => {
      order.push("session");
      return next(input);
    });

    const r = await Effect.runPromise(child.opFx("op"));
    expect(r).toBe(1);
    // Ancestor (broader) is outermost → runs first; then the child's own.
    expect(order).toEqual(["app", "session"]);
  });

  it("late registration on the ancestor IS honored — live inheritance (child + grandchild)", async () => {
    const parent = await mk("app2");
    // Construct the child AND grandchild FIRST — their inherited layers pull the
    // parent's (currently empty) resolved interceptors.
    const child = await mk("session2", parent);
    const grandchild = await mk("bridge2", child);

    const seen: string[] = [];
    // Register on the ancestor AFTER the descendants exist. Under LIVE
    // inheritance this pushes DOWN the construction tree to both.
    parent.useMw((input, next) => {
      seen.push("late-app");
      return next(input);
    });

    // Distinct op names → distinct opIds (same name replays via idempotency).
    await Effect.runPromise(child.opFx("child-op"));
    await Effect.runPromise(grandchild.opFx("gc-op"));
    // The late ancestor registration ran for the already-constructed child AND
    // its grandchild — the fold's old static boundary is gone.
    expect(seen).toEqual(["late-app", "late-app"]);
  });

  it("no ancestor middleware → identical to today (behavior-preserving)", async () => {
    const parent = await mk("app3");
    const child = await mk("session3", parent);
    const order: string[] = [];
    child.useMw((input, next) => {
      order.push("session-only");
      return next(input);
    });

    const r = await Effect.runPromise(child.opFx("op"));
    expect(r).toBe(1);
    // Ancestor registered nothing → only the child's own chain ran.
    expect(order).toEqual(["session-only"]);
  });

  it("a root harness (no parent) inherits nothing", async () => {
    const root = await mk("root");
    const order: string[] = [];
    root.useMw((input, next) => {
      order.push("own");
      return next(input);
    });
    await Effect.runPromise(root.opFx("op"));
    expect(order).toEqual(["own"]);
  });
});

describe("Tier-3 live inheritance — firing + cascade", () => {
  it("(a) parent registers BEFORE child → child inherits at construction (pull)", async () => {
    const parent = await mk("a-app");
    const seen: string[] = [];
    parent.useMw((input, next) => {
      seen.push("app");
      return next(input);
    });
    const child = await mk("a-session", parent);
    await Effect.runPromise(child.opFx("op"));
    expect(seen).toEqual(["app"]);
  });

  it("(b) parent registers AFTER child → existing child + grandchild see it next op (push)", async () => {
    const parent = await mk("b-app");
    const child = await mk("b-session", parent);
    const grandchild = await mk("b-bridge", child);

    // Before the registration nothing fires. Distinct op names throughout →
    // distinct opIds (reusing a name replays the cached terminal, skipping the
    // interceptor chain — which would mask the push under test).
    const seen: string[] = [];
    await Effect.runPromise(child.opFx("pre"));
    expect(seen).toEqual([]);

    parent.useMw((input, next) => {
      seen.push("late");
      return next(input);
    });

    await Effect.runPromise(child.opFx("child-post"));
    await Effect.runPromise(grandchild.opFx("gc-post"));
    expect(seen).toEqual(["late", "late"]);
  });

  it("(b-guard) a late ancestor guard VETO reaches an already-constructed child", async () => {
    const parent = await mk("bg-app");
    const child = await mk("bg-session", parent);

    // Registered AFTER the child exists — live inheritance must still deny.
    parent.onBefore(() => ({ kind: "veto", reason: "late-app-policy" }));

    const exit = await Effect.runPromiseExit(child.opFx("op"));
    expect(exit._tag).toBe("Failure"); // vetoed → the child op does not succeed
  });

  it("(c) unsubscribe from the parent registration removes it from ALL descendants", async () => {
    const parent = await mk("c-app");
    const child = await mk("c-session", parent);
    const grandchild = await mk("c-bridge", child);

    const seen: string[] = [];
    const off = parent.useMw((input, next) => {
      seen.push("shared");
      return next(input);
    });

    // Fires on both descendants while live. Distinct op names → distinct opIds
    // so the post-unsubscribe ops actually re-run the chain (not a cached
    // idempotency replay, which would pass this test for the wrong reason).
    await Effect.runPromise(child.opFx("c1"));
    await Effect.runPromise(grandchild.opFx("g1"));
    expect(seen).toEqual(["shared", "shared"]);

    // Unsubscribe on the parent cascades the removal down by identity.
    off();
    seen.length = 0;
    await Effect.runPromise(child.opFx("c2"));
    await Effect.runPromise(grandchild.opFx("g2"));
    expect(seen).toEqual([]);
  });

  it("(d) a detached/closed child stops receiving pushes", async () => {
    const parent = await mk("d-app");
    const child = await mk("d-session", parent);

    // Detach the child from the interceptor tree.
    await child.close();

    const seen: string[] = [];
    parent.useMw((input, next) => {
      seen.push("post-close");
      return next(input);
    });

    // The now-detached child must not receive the push.
    await Effect.runPromise(child.opFx("op"));
    expect(seen).toEqual([]);
  });
});

describe("Tier-3 — `before` handler inheritance (uniform with middleware)", () => {
  it("an ancestor's `before` handler runs for a child op (pull)", async () => {
    const parent = await mk("app-h");
    const ran: string[] = [];
    // Register the ancestor guard BEFORE constructing the child (pull-seed).
    parent.onBefore(() => {
      ran.push("app-before");
    });
    const child = await mk("session-h", parent);
    child.onBefore(() => {
      ran.push("session-before");
    });

    await Effect.runPromise(child.opFx("op"));
    // Ancestor first (root-outermost), then own — same as middleware.
    expect(ran).toEqual(["app-before", "session-before"]);
  });

  it("an ancestor `before` VETO short-circuits the child op (pull)", async () => {
    const parent = await mk("app-v");
    // Ancestor veto registered BEFORE the child is constructed → pull-seeded.
    parent.onBefore(() => ({ kind: "veto", reason: "app-policy" }));
    const child = await mk("session-v", parent);
    let bodyRan = false;
    child.onBefore(() => {
      bodyRan = true; // should NOT run — parent vetoes first
    });

    const exit = await Effect.runPromiseExit(child.opFx("op"));
    expect(exit._tag).toBe("Failure"); // vetoed → the op does not succeed
    expect(bodyRan).toBe(false);
  });
});
