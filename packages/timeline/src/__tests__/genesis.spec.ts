/**
 * ADR 93 — the GENESIS laws at the harness level, plus the interceptor-cascade
 * ORDER the `hooks:` / `guards:` bags desugar into.
 *
 * Laws pinned here (ADR 93 landmines 2, 3, and the cascade-order gate):
 *   - genesis output is SEED, never re-appended (landmine 3);
 *   - a throwing hydrator surfaces `TimelineHydrateFailed` with nothing
 *     half-installed (landmine 2);
 *   - a definition's `hooks:` / `guards:` bags use DROP-LAYER keys and land on
 *     the same ops the discriminated app-level names reach;
 *   - APP-level interceptors wrap DEFINITION-level ones: app guards veto before
 *     a definition guard runs, app before-hooks run first, afters unwind in
 *     reverse (ADR 93 §Guards on configs — "governance outranks local policy").
 *
 * The fork-no-genesis law lives with the layer that knows lineage — see
 * `packages/app/src/__tests__/genesis-lifecycle.spec.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  hooksToMiddlewares,
  guardsToMiddlewares,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  type Middleware,
} from "@agentick/runtime";
import { TimelineHydrateFailed } from "@agentick/spec";
import type { TimelineEntry } from "@agentick/spec";

import { TimelineHarness, type TimelineHarnessOptions } from "../harness.js";
import { MemoryTimelineStore } from "../store.js";
import { defineTimeline } from "../definition.js";
import { messageEntry } from "../conformance.js";
import { fromHandler } from "../strategies.js";

async function harness(options: TimelineHarnessOptions = {}): Promise<TimelineHarness> {
  const h = new TimelineHarness(
    `t-genesis-${Math.random().toString(36).slice(2)}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

describe("genesis — the seed law (ADR 93 landmine 3)", () => {
  it("seeded entries never reach the store's append", async () => {
    const store = new MemoryTimelineStore();
    const appended: string[] = [];
    const spied: MemoryTimelineStore = Object.assign(Object.create(store) as MemoryTimelineStore, {
      append: (key: string, entries: readonly TimelineEntry[], ctx: never) => {
        for (const e of entries) appended.push(e.kind === "message" ? e.message.id : e.kind);
        return store.append(key, entries, ctx);
      },
    });
    const h = await harness({
      store: spied,
      hydrate: async () => [messageEntry("g1", "a"), messageEntry("g2", "b")],
    });
    await h.hydrate();
    await h.flush();
    expect(appended).toEqual([]);
    expect(h.readPersisted()).toHaveLength(2);
    // A real append still writes through — genesis is the ONLY exemption.
    await h.append(messageEntry("live", "c"));
    await h.flush();
    expect(appended).toEqual(["live"]);
    await h.close();
  });

  it("seeds BOTH tiers so the first render sees the resumed conversation", async () => {
    const h = await harness({ hydrate: async () => [messageEntry("g1", "a")] });
    await h.hydrate();
    expect(h.readPersisted()).toHaveLength(1);
    expect(h.read().entries).toHaveLength(1);
    // The projection version bumped, so a subscribed renderer re-reads.
    expect(h.read().version).toBeGreaterThan(0);
    await h.close();
  });

  it("no store and no hydrator ⇒ genesis is a no-op (the zero-cost default)", async () => {
    const h = await harness();
    await h.hydrate();
    expect(h.readPersisted()).toEqual([]);
    expect(h.read().version).toBe(0);
    await h.close();
  });
});

describe("genesis — typed failure (ADR 93 landmine 2)", () => {
  it("a throwing hydrator rejects with TimelineHydrateFailed carrying the cause", async () => {
    const boom = new Error("tier catalog unreachable");
    const h = await harness({ hydrate: () => Promise.reject(boom) });
    await expect(h.hydrate()).rejects.toBeInstanceOf(TimelineHydrateFailed);
    await expect(h.hydrate()).rejects.toMatchObject({ cause: boom });
    // Nothing was installed — no half-genesis harness.
    expect(h.readPersisted()).toEqual([]);
    await h.close();
  });

  it("an already-typed failure is not double-wrapped", async () => {
    const typed = new TimelineHydrateFailed({ cause: "inner" });
    const h = await harness({ hydrate: () => Promise.reject(typed) });
    await expect(h.hydrate()).rejects.toBe(typed);
    await h.close();
  });
});

describe("genesis — the ctx.store facet (ADR 91/93)", () => {
  it("the hydrator receives the definition's own store plus session identity", async () => {
    const store = new MemoryTimelineStore();
    let seen: { store?: unknown; sessionId?: string; hasLog?: boolean; hasRun?: boolean } = {};
    const h = await harness({
      store,
      hydrate: async (ctx) => {
        seen = {
          store: ctx.store,
          sessionId: ctx.sessionId,
          hasLog: typeof ctx.log === "function",
          hasRun: typeof ctx.run === "function",
        };
        return [];
      },
    });
    await h.hydrate();
    expect(seen.store).toBe(store);
    expect(seen.sessionId).toBe(h.id);
    // The derived ctx is not a bare bag — the ADR-91 facets are there.
    expect(seen.hasLog).toBe(true);
    expect(seen.hasRun).toBe(true);
    await h.close();
  });

  it("the ctx is also a StoreCtx — a hydrator hands it straight to the store", async () => {
    const store = new MemoryTimelineStore();
    await store.append("t-storectx:timeline", [messageEntry("p1", "a")], {} as never);
    const h = new TimelineHarness(
      "t-storectx:timeline",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: (ctx) => ctx.store.read(ctx.sessionId ?? "", ctx) },
    );
    await h.ready;
    await h.hydrate();
    expect(h.readPersisted()).toHaveLength(1);
    await h.close();
  });

  it("carries the journal's READ slice, so an event-sourced hydrator is writable", async () => {
    let reader: unknown;
    const h = await harness({
      hydrate: async (ctx) => {
        reader = (ctx as { journalReader?: unknown }).journalReader;
        return [];
      },
    });
    await h.hydrate();
    expect(typeof (reader as { readByQuery?: unknown } | undefined)?.readByQuery).toBe("function");
    await h.close();
  });
});

describe("compact — the definition's (entries, ctx) sugar", () => {
  it("the function form drives the no-arg signal form", async () => {
    const h = await harness({
      compact: (entries) => [messageEntry("summary", `[${entries.length}]`)],
    });
    await h.append(messageEntry("a", "1"), messageEntry("b", "2"));
    const result = await h.compact();
    expect(result).toMatchObject({ entriesBefore: 2, entriesAfter: 1, source: "persisted" });
    expect(h.read().entries).toHaveLength(1);
    // Nothing was rewritten; the summary is appended after the two turns.
    expect(h.readPersisted()).toHaveLength(3);
    await h.close();
  });

  it("the compactor's ctx carries op identity and the signal's advisory instructions", async () => {
    let seen: { sessionId?: string; instructions?: unknown } = {};
    const h = await harness({
      compact: (entries, ctx) => {
        seen = { sessionId: ctx.sessionId, instructions: ctx.instructions };
        return entries;
      },
    });
    await h.append(messageEntry("a", "1"));
    await h.compact();
    expect(seen.sessionId).toBe(h.id);
    expect(seen.instructions).toBeUndefined();
    await h.close();
  });

  it("a configured CompactStrategy value still works (the other arm of the dichotomy)", async () => {
    const h = await harness({
      compact: fromHandler({ handler: async ({ entries }) => entries.slice(0, 1) }),
    });
    await h.append(messageEntry("a", "1"), messageEntry("b", "2"));
    await h.compact();
    expect(h.read().entries).toHaveLength(1);
    await h.close();
  });
});

describe("definition hooks:/guards: — drop-layer keys reach the discriminated ops", () => {
  it("hooks: { onBeforeAppend } fires on timeline:append", async () => {
    const seen: string[] = [];
    const h = await harness(
      defineTimeline({
        hooks: {
          onBeforeAppend: (input) => {
            seen.push(`before:${input.entries.length}`);
          },
          onAfterAppend: () => {
            seen.push("after");
          },
        },
      }),
    );
    await h.append(messageEntry("a", "1"));
    expect(seen).toEqual(["before:1", "after"]);
    await h.close();
  });

  it("guards: { append } can VETO an append", async () => {
    const h = await harness(
      defineTimeline({
        guards: {
          append: (input) =>
            input.entries.length > 1 ? { kind: "veto", reason: "batch too large" } : undefined,
        },
      }),
    );
    await h.append(messageEntry("a", "1"));
    expect(h.readPersisted()).toHaveLength(1);
    // A veto surfaces as the runner's terminal outcome, carrying the reason —
    // assert both, so the test cannot pass on an unrelated rejection.
    await expect(h.append(messageEntry("b", "2"), messageEntry("c", "3"))).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { outcome: "vetoed", reason: "batch too large" },
    });
    // The veto held: nothing from the rejected batch landed.
    expect(h.readPersisted()).toHaveLength(1);
    await h.close();
  });

  it("guards: { compact } sees the compact signal and can replace the result", async () => {
    const h = await harness(
      defineTimeline({
        compact: (entries) => entries,
        guards: {
          compact: () => ({
            kind: "replace",
            result: { entriesBefore: 0, entriesAfter: 0, source: "persisted" as const },
          }),
        },
      }),
    );
    await h.append(messageEntry("a", "1"));
    const result = await h.compact();
    expect(result).toEqual({ entriesBefore: 0, entriesAfter: 0, source: "persisted" });
    // The body never ran, so the projection is untouched.
    expect(h.read().entries).toHaveLength(1);
    await h.close();
  });
});

describe("cascade ORDER — app wraps definition (ADR 93 §Guards on configs)", () => {
  /**
   * The app tier is modelled the way the real app does it: its declarative bags
   * are adapted to op-scoped middleware and handed down as
   * `inheritedInterceptors` (the construction fold). The definition's bags
   * register on the harness's OWN chain. `resolvedInterceptors()` orders
   * inherited-before-own, and `orderInterceptors` floats guards outermost with a
   * STABLE sort — so the tier order survives inside each kind.
   */
  function appTier(
    hooks: Parameters<typeof hooksToMiddlewares>[0],
    guards: Parameters<typeof guardsToMiddlewares>[0],
  ): readonly Middleware<unknown, unknown, unknown>[] {
    return [...guardsToMiddlewares(guards), ...hooksToMiddlewares(hooks)];
  }

  it("an APP guard vetoes before a DEFINITION guard is consulted", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {},
        {
          timelineAppend: () => {
            order.push("app-guard");
            return { kind: "veto", reason: "app says no" };
          },
        },
      ),
      guards: {
        append: () => {
          order.push("definition-guard");
          return undefined;
        },
      },
    });
    await expect(h.append(messageEntry("a", "1"))).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { reason: "app says no" },
    });
    // The app guard ran and short-circuited: the definition guard never did.
    expect(order).toEqual(["app-guard"]);
    expect(h.readPersisted()).toEqual([]);
    await h.close();
  });

  it("an APP before-hook wraps a DEFINITION before-hook; afters unwind in reverse", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {
          onBeforeTimelineAppend: () => {
            order.push("app-before");
          },
          onAfterTimelineAppend: () => {
            order.push("app-after");
          },
        },
        {},
      ),
      hooks: {
        onBeforeAppend: () => {
          order.push("definition-before");
        },
        onAfterAppend: () => {
          order.push("definition-after");
        },
      },
    });
    await h.append(messageEntry("a", "1"));
    expect(order).toEqual(["app-before", "definition-before", "definition-after", "app-after"]);
    await h.close();
  });

  it("the TOTAL order is app guards → definition guards → app before → definition before → body", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {
          onBeforeTimelineAppend: () => {
            order.push("app-before");
          },
        },
        {
          timelineAppend: () => {
            order.push("app-guard");
            return undefined;
          },
        },
      ),
      hooks: {
        onBeforeAppend: () => {
          order.push("definition-before");
        },
      },
      guards: {
        append: () => {
          order.push("definition-guard");
          return undefined;
        },
      },
    });
    await h.append(messageEntry("a", "1"));
    expect(order).toEqual(["app-guard", "definition-guard", "app-before", "definition-before"]);
    await h.close();
  });
});
