/**
 * ADR 93 landmine 6 — `ctx.store` typing flows from the `store` slot through the
 * definition's generic, and it composes with the ADR-91 `Derived` brand.
 *
 * These assertions live in the TYPES; the runtime bodies exist only so vitest
 * has something to execute. Every `@ts-expect-error` line FAILS the typecheck if
 * the inference ever stops holding — which is the point: `pnpm typecheck` runs
 * `tsc -p tsconfig.json` (tests included), so this file is a real gate, not
 * documentation.
 *
 * Pattern borrowed verbatim from `packages/runtime/src/__tests__/ctx-brand.type.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import type {
  Derived,
  OperationCtx,
  SeqTagged,
  TimelineEntry,
  TimelineStore,
} from "@agentick/spec";

import {
  defineTimeline,
  defineTimelineStore,
  type TimelineDefinition,
  type TimelineHydrateCtx,
  type TimelineHydrator,
} from "../definition.js";
import { hydrateFromStore, hydrateTail } from "../hydrators.js";

// ── A store adapter with a verb BEYOND the port, so inference is observable ──

interface TenantTimelineStore extends TimelineStore {
  /** An adapter-only verb — visible on `ctx.store` iff inference flowed. */
  lastN(logKey: string, n: number): Promise<readonly SeqTagged<TimelineEntry>[]>;
  readonly tenant: string;
}

const tenantStore: TenantTimelineStore = Object.assign(
  defineTimelineStore({
    backend: "tenant",
    append: () => Promise.resolve([]),
    read: () => Promise.resolve([]),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(false),
    history: () => Promise.resolve([]),
  }),
  {
    lastN: () => Promise.resolve([] as readonly SeqTagged<TimelineEntry>[]),
    tenant: "acme",
  },
);

describe("ADR 93 — ctx.store inference (compile-time)", () => {
  it("flows the CONCRETE store type from the `store` slot onto ctx.store", () => {
    let sawTenant: string | undefined;
    defineTimeline({
      store: tenantStore,
      hydrate: async (ctx) => {
        // Inference reached the adapter's own surface, not just the port.
        sawTenant = ctx.store.tenant;
        return ctx.store.lastN(ctx.sessionId ?? "", 10).then((rows) => rows.map((r) => r.entry));
      },
    });
    expect(sawTenant).toBeUndefined(); // definitions are inert — nothing ran
  });

  it("a hydrator may not reach a verb the store does NOT have", () => {
    defineTimeline({
      store: tenantStore,
      hydrate: async (ctx) => {
        // @ts-expect-error — `notAVerb` is not on TenantTimelineStore; the store
        // slot's type is the contract, so a typo fails the build.
        void ctx.store.notAVerb;
        return [];
      },
    });
    expect(true).toBe(true);
  });

  it("defaults ctx.store to the PORT when no store slot is supplied", () => {
    defineTimeline({
      hydrate: async (ctx) => {
        // The port's verbs are there…
        void ctx.store.read;
        void ctx.store.backend;
        // @ts-expect-error — …but an adapter-specific verb is not: without a
        // `store` slot the generic falls back to `TimelineStore`.
        void ctx.store.tenant;
        return [];
      },
    });
    expect(true).toBe(true);
  });

  it("a specialized definition FITS a port-typed slot (the variance requirement)", () => {
    // ADR 93 landmine 6: `hydrate` is a METHOD signature precisely so this
    // assignment holds. Every top-level slot is typed at the PORT
    // (`TimelineDefinition<TimelineStore>`), so a definition specialized on a
    // concrete adapter MUST be assignable to it — otherwise
    // `createApp({ timeline: defineTimeline({ store: myPgStore, hydrate }) })`
    // would not compile, which was the bug this shape fixes.
    const specialized = defineTimeline({
      store: tenantStore,
      hydrate: async (ctx) => ctx.store.lastN("k", 1).then((r) => r.map((x) => x.entry)),
    });
    const atThePort: TimelineDefinition = specialized;
    expect(atThePort).toBe(specialized);
  });

  it("a standalone hydrator still carries its store's type", () => {
    const tenantHydrator: TimelineHydrator<TenantTimelineStore> = (ctx) =>
      ctx.store.lastN("k", 1).then((rows) => rows.map((r) => r.entry));
    defineTimeline({ store: tenantStore, hydrate: tenantHydrator });
    expect(typeof tenantHydrator).toBe("function");
  });

  it("the named hydrators are assignable at BOTH the port and a concrete adapter", () => {
    defineTimeline({ store: tenantStore, hydrate: hydrateFromStore<TenantTimelineStore>() });
    defineTimeline({ store: tenantStore, hydrate: hydrateTail<TenantTimelineStore>(100) });
    // The unparameterized forms default to the port, so they fit any slot.
    defineTimeline({ store: tenantStore, hydrate: hydrateFromStore() });
    defineTimeline({ hydrate: hydrateTail(10) });
    expect(true).toBe(true);
  });
});

describe("ADR 93 × ADR 91 — Derived brand interplay (compile-time)", () => {
  it("a BRANDED ctx satisfies the plain hydrate ctx (zero adopter friction)", () => {
    // The framework mints `Derived<OperationCtx & { store }>`; the adopter's
    // hydrator signature is the PLAIN interface. A branded value satisfies a
    // plain one, so no adopter ever writes `Derived<…>`.
    type Minted = Derived<OperationCtx & { readonly store: TenantTimelineStore }>;
    const accepts = (ctx: TimelineHydrateCtx<TenantTimelineStore>): string | undefined =>
      ctx.store.tenant ?? ctx.sessionId;
    const asMinted = null as unknown as Minted;
    expect(typeof accepts).toBe("function");
    // Compile-time: the minted value is accepted where the plain type is asked for.
    void (() => accepts(asMinted));
  });

  it("a HAND-ASSEMBLED bag cannot satisfy the branded mint", () => {
    const bag = {
      sessionId: "s",
      store: tenantStore,
      log: () => {},
      trace: {},
      metrics: {},
      run: () => {},
      runner: {},
    };
    // @ts-expect-error — nothing that skipped `deriveContext` carries the brand
    // (ADR 91 §Enforcement), so a framework seam typed `Derived<…>` rejects it.
    const rejected: Derived<OperationCtx & { readonly store: TenantTimelineStore }> = bag;
    expect(rejected).toBeDefined();
  });

  it("the hydrate ctx carries the ADR-91 facets, not just the trunk", () => {
    defineTimeline({
      hydrate: async (ctx) => {
        // Observability + Ops are present because the ctx IS an OperationCtx.
        ctx.log.debug({ msg: "genesis" });
        void ctx.metrics;
        void ctx.trace;
        void ctx.run;
        void ctx.runner;
        return [];
      },
    });
    expect(true).toBe(true);
  });

  it("the compact ctx carries `instructions` on top of the same spine", () => {
    defineTimeline({
      compact: (entries, ctx) => {
        void ctx.instructions;
        void ctx.sessionId;
        ctx.log.debug({ msg: "compacting", n: entries.length });
        // @ts-expect-error — `store` is the GENESIS facet; compaction folds
        // entries it was handed and never reaches for durability itself.
        void ctx.store;
        return entries;
      },
    });
    expect(true).toBe(true);
  });
});
