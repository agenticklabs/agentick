/**
 * ADR 96 — the drop-layer `hooks:` / `guards:` bags are BASE behavior.
 *
 * A harness declares its verb and its handler; `BaseHarnessOptions` carries the
 * two bags and the base constructor registers them. Nothing in this file's
 * harness does anything to make that work — that absence IS the claim.
 *
 * Pinned here: the short names reach the right command; each verdict arm
 * reaches its terminal; both bags register on the OWN chain, so they cascade to
 * a child exactly as `.use` does; and `fx.guard` — the Effect-native primitive
 * that replaced the tool-executor's `guardDispatch` — fires, vetoes, and is
 * reachable on an `fxProxy`-derived surface.
 *
 * The TYPE-level claim (the short key is exact, the discriminated key is
 * rejected) is pinned in `definition-interceptors.type.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { HandlerError } from "@agentick/spec";
import type { HarnessFx, MessageEnvelope, MessageHandlerError } from "@agentick/spec";

import { BaseHarness, type BaseHarnessOptions } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

interface StampInput {
  readonly note: string;
}
type StampOutput = string;

declare module "../substrate/base-harness.js" {
  interface CommandRegistry {
    "tool:stamp": { input: StampInput; output: StampOutput };
  }
}

/**
 * A harness with ONE verb and NO interceptor plumbing. It accepts the bags
 * because its options type names its surface, and registers them because the
 * base does.
 */
class StampHarness extends BaseHarness<"tool"> {
  readonly stamp: (input: StampInput) => Promise<StampOutput>;
  /** Body invocations — a guard must veto BEFORE this moves. */
  bodyRuns = 0;

  constructor(scopeId: string, options: BaseHarnessOptions<unknown, "tool"> = {}) {
    super("tool", scopeId, new MemoryJournal(), new LocalEventBus(), new LocalInbox(), options);
    this.stamp = this.command<StampInput, StampOutput, never>({
      name: "tool:stamp",
      handler: (i) =>
        Effect.sync(() => {
          this.bodyRuns++;
          return `stamped:${i.note}`;
        }),
    });
  }

  /** The `fxProxy`-derived surface, so the proxy's own `guard` branch is reachable. */
  get proxiedFx(): HarnessFx {
    return this.fxProxy();
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }

  /** A child that pull-seeds and live-attaches, as every sub-harness does. */
  child(scopeId: string): StampHarness {
    return new StampHarness(scopeId, {
      inheritedInterceptors: this.resolvedInterceptors(),
      interceptorParent: this,
    });
  }
}

describe("ADR 96 — options.hooks (drop-layer)", () => {
  it("onBefore<Verb> transforms the input of this namespace's command", async () => {
    const h = new StampHarness("h1", {
      hooks: { onBeforeStamp: (input) => ({ note: input.note.toUpperCase() }) },
    });
    await h.ready;
    await expect(h.stamp({ note: "hi" })).resolves.toBe("stamped:HI");
  });

  it("onAfter<Verb> transforms the output", async () => {
    const h = new StampHarness("h2", { hooks: { onAfterStamp: (output) => `${output}!` } });
    await h.ready;
    await expect(h.stamp({ note: "hi" })).resolves.toBe("stamped:hi!");
  });

  it("a before-hook that throws vetoes the op", async () => {
    const h = new StampHarness("h3", {
      hooks: {
        onBeforeStamp: () => {
          throw new Error("nope");
        },
      },
    });
    await h.ready;
    await expect(h.stamp({ note: "hi" })).rejects.toBeTruthy();
    expect(h.bodyRuns).toBe(0);
  });
});

describe("ADR 96 — options.guards (drop-layer)", () => {
  it("a void verdict admits", async () => {
    const h = new StampHarness("g1", { guards: { stamp: () => undefined } });
    await h.ready;
    await expect(h.stamp({ note: "ok" })).resolves.toBe("stamped:ok");
  });

  it("a veto verdict terminates before the body runs", async () => {
    const h = new StampHarness("g2", {
      guards: { stamp: (input) => (input.note === "bad" ? { kind: "veto" } : undefined) },
    });
    await h.ready;
    await expect(h.stamp({ note: "bad" })).rejects.toThrow("operation outcome: vetoed");
    expect(h.bodyRuns).toBe(0);
    await expect(h.stamp({ note: "fine" })).resolves.toBe("stamped:fine");
  });

  it("a replace verdict short-circuits with the supplied result", async () => {
    const h = new StampHarness("g3", {
      guards: { stamp: () => ({ kind: "replace", result: "canned" }) },
    });
    await h.ready;
    await expect(h.stamp({ note: "x" })).resolves.toBe("canned");
    expect(h.bodyRuns).toBe(0);
  });

  it("cascades to a child constructed after it (parent → child)", async () => {
    const parent = new StampHarness("p", {
      guards: { stamp: (input) => (input.note === "blocked" ? { kind: "veto" } : undefined) },
    });
    await parent.ready;
    const child = parent.child("p:child");
    await child.ready;
    await expect(child.stamp({ note: "fine" })).resolves.toBe("stamped:fine");
    await expect(child.stamp({ note: "blocked" })).rejects.toThrow("operation outcome: vetoed");
  });

  it("cascades a hook to a child too", async () => {
    const parent = new StampHarness("p2", { hooks: { onAfterStamp: (out) => `${out}/parent` } });
    await parent.ready;
    const child = parent.child("p2:child");
    await child.ready;
    await expect(child.stamp({ note: "x" })).resolves.toBe("stamped:x/parent");
  });
});

describe("ADR 96 — fx.guard (the Effect-native primitive)", () => {
  it("admits, vetoes, and unsubscribes", async () => {
    const h = new StampHarness("fx1");
    await h.ready;
    const off = h.fx.guard<StampInput, StampOutput>((input) =>
      Effect.succeed(input.note === "no" ? ({ kind: "veto" } as const) : undefined),
    );
    await expect(h.stamp({ note: "yes" })).resolves.toBe("stamped:yes");
    await expect(h.stamp({ note: "no" })).rejects.toThrow("operation outcome: vetoed");
    off();
    await expect(h.stamp({ note: "no" })).resolves.toBe("stamped:no");
  });

  it("is reachable on an fxProxy-derived surface", async () => {
    const h = new StampHarness("fx2");
    await h.ready;
    const off = h.proxiedFx.guard<StampInput, StampOutput>(() =>
      Effect.succeed({ kind: "veto" } as const),
    );
    await expect(h.stamp({ note: "x" })).rejects.toThrow("operation outcome: vetoed");
    off();
    await expect(h.stamp({ note: "x" })).resolves.toBe("stamped:x");
  });
});
