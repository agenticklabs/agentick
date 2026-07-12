/**
 * Tier-3 structural middleware inheritance (ADR 76). A harness's effective
 * middleware is its construction-ANCESTORS' chains composed root-outermost,
 * wrapping its own, wrapping the body. Walked fresh per op (honors late
 * registration), terminating at the first non-`BaseHarness` parent.
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
  constructor(id: string, parent?: BaseHarness<"tool">) {
    super(
      "tool",
      id,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      parent ? { parent } : {},
    );
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
    return this.handlers.register<{ n: number }, number>("before", (input) =>
      Effect.sync(() => fn(input)),
    );
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error("n/a") }));
  }
}

async function mk(id: string, parent?: BaseHarness<"tool">): Promise<TierHarness> {
  const h = new TierHarness(id, parent);
  await h.ready;
  return h;
}

describe("Tier-3 structural middleware inheritance (ADR 76)", () => {
  it("a child op is wrapped by its ANCESTOR's middleware, root-outermost", async () => {
    const parent = await mk("app");
    const child = await mk("session", parent);

    const order: string[] = [];
    parent.useMw((input, next) => {
      order.push("app");
      return next(input);
    });
    child.useMw((input, next) => {
      order.push("session");
      return next(input);
    });

    const r = await Effect.runPromise(child.opFx("op"));
    expect(r).toBe(1);
    // Ancestor (broader) is outermost → runs first; then the child's own.
    expect(order).toEqual(["app", "session"]);
  });

  it("late registration on the ancestor is honored (walked fresh per op)", async () => {
    const parent = await mk("app2");
    const child = await mk("session2", parent);

    const seen: string[] = [];
    // Register on the ancestor AFTER construction — the per-op walk picks it up.
    parent.useMw((input, next) => {
      seen.push("late-app");
      return next(input);
    });

    await Effect.runPromise(child.opFx("op"));
    expect(seen).toEqual(["late-app"]);
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
    const child = await mk("session-h", parent);
    const ran: string[] = [];
    parent.onBefore(() => {
      ran.push("app-before");
    });
    child.onBefore(() => {
      ran.push("session-before");
    });

    await Effect.runPromise(child.opFx("op"));
    // Ancestor first (root-outermost), then own — same as middleware.
    expect(ran).toEqual(["app-before", "session-before"]);
  });

  it("an ancestor `before` VETO short-circuits the child op", async () => {
    const parent = await mk("app-v");
    const child = await mk("session-v", parent);
    parent.onBefore(() => ({ kind: "veto", reason: "app-policy" }));
    let bodyRan = false;
    child.onBefore(() => {
      bodyRan = true; // should NOT run — parent vetoes first
    });

    const exit = await Effect.runPromiseExit(child.opFx("op"));
    expect(exit._tag).toBe("Failure"); // vetoed → the op does not succeed
    expect(bodyRan).toBe(false);
  });
});
