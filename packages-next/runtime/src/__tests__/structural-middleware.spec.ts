/**
 * Tier-3 structural middleware inheritance (ADR 76) as a CONSTRUCTION-FOLD.
 * A harness's effective middleware is its construction-ANCESTORS' resolved
 * interceptors (folded in at construction) composed root-outermost, wrapping
 * its own, wrapping the body. The inherited layer is SNAPSHOTTED at the child's
 * construction (`inheritedInterceptors: parent.resolvedInterceptors()`) — NOT
 * walked per op. So a child sees registrations made on the parent BEFORE it was
 * constructed; registrations made AFTER are outside the child's static fold.
 * This mirrors the hook cascade (ADR 82): the fold IS the walk, memoized.
 *
 * Scope note (post-flat-topology finding): tier 3 is for construction
 * parent→child relationships — `app → session` (deployment-global concerns on
 * session ops) and `session → its per-session bridges`. The SHARED spine
 * harnesses (loop/executor/tool) are construction-siblings, NOT children — a
 * session-scoped concern around the model call is tier 4, not tier 3.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { BaseHarness, type Middleware } from "@agentick/runtime-next";
import type {
  HandlerVerdict,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

class TierHarness extends BaseHarness<"tool"> {
  constructor(id: string, parent?: TierHarness) {
    super(
      "tool",
      id,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      // ADR 76 fold — snapshot the parent's RESOLVED interceptors at THIS
      // harness's construction. Nothing is walked per op afterwards.
      parent ? { inheritedInterceptors: parent.resolvedInterceptorsForTest() } : {},
    );
  }

  /** Public test accessor for the `protected resolvedInterceptors()` fold value. */
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

  useMw(mw: Middleware<unknown, unknown, unknown>): () => void {
    return this.middleware.use(mw);
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

describe("Tier-3 structural middleware inheritance (ADR 76) — construction-fold", () => {
  it("a child op is wrapped by its ANCESTOR's middleware, root-outermost", async () => {
    const parent = await mk("app");
    // Register on the ancestor BEFORE constructing the child — the fold snapshots
    // it into the child's inherited layer.
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

  it("late registration on the ancestor is NOT honored — the fold's static boundary", async () => {
    const parent = await mk("app2");
    // Construct the child FIRST — its inherited layer snapshots the parent's
    // (currently empty) resolved interceptors.
    const child = await mk("session2", parent);

    const seen: string[] = [];
    // Register on the ancestor AFTER the child exists — outside the child's
    // static fold, so the child op does NOT see it.
    parent.useMw((input, next) => {
      seen.push("late-app");
      return next(input);
    });

    await Effect.runPromise(child.opFx("op"));
    expect(seen).toEqual([]); // the late ancestor registration never ran for the child
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

describe("Tier-3 Q2 — `before` handler inheritance (uniform with middleware)", () => {
  it("an ancestor's `before` handler runs for a child op", async () => {
    const parent = await mk("app-h");
    const ran: string[] = [];
    // Register the ancestor guard BEFORE constructing the child (fold snapshot).
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

  it("an ancestor `before` VETO short-circuits the child op", async () => {
    const parent = await mk("app-v");
    // Ancestor veto registered BEFORE the child is constructed → folded in.
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
