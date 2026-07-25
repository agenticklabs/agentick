/**
 * `runStoreConformance` — the SHARED conformance skeleton for stores
 * (data-layer plan §3.5 P8). Extracted from the common structure of
 * `runTaskStoreConformance` (`@agentick/tasks`) and
 * `runTimelineStoreConformance` (`@agentick/timeline`): the options shape
 * (`label` / `factory` / `skip?` / `capabilities?`), the `setup` + `suite`
 * gating, and the genuinely **store-agnostic** cases.
 *
 * Only three behaviors are archetype-independent, so only these live here:
 *   1. `backend` is a stable, non-empty identifier.
 *   2. reading an unknown key yields the archetype's empty value
 *      (collection → `undefined`; log → `[]`) — via the {@link
 *      StoreConformanceOptions.emptyRead} probe.
 *   3. deleting an absent key is idempotent (settles, never throws) — via the
 *      {@link StoreConformanceOptions.idempotentDelete} probe.
 *
 * Everything shape-specific (upsert, scope/status filtering, append ordering,
 * seq monotonicity, prune-of-terminals, …) is registered by the store's own
 * suite through the {@link StoreConformanceOptions.cases} hook, which runs
 * inside the same `describe` block so its `it`s nest under the suite heading.
 *
 * Kept vitest-based (`describe`/`it`/`expect`) exactly like the per-store
 * suites it factors out.
 *
 * @see docs/proposals/v2/data-layer-plan.md §3.5
 */

import { describe, expect, it } from "vitest";

/** Everything a store's own suite needs to register its shape-specific cases. */
export interface StoreConformanceContext<S> {
  /** Constructs a fresh, isolated store — call once per `it`. */
  readonly setup: () => Promise<S>;
  /** The declared capability flags, forwarded from the options. */
  readonly capabilities?: StoreCapabilities;
}

/** Optional capability flags a suite skips when unsupported. */
export interface StoreCapabilities {
  /** `prune` supported — defaults to `typeof store.prune === "function"`. */
  readonly prune?: boolean;
}

export interface StoreConformanceOptions<S extends { readonly backend: string }> {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => S | Promise<S>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a store).
   * For adapters whose backend may be absent in the test env — compute the
   * availability boolean at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
  /** Capabilities the suite skips if unsupported. */
  readonly capabilities?: StoreCapabilities;
  /**
   * Store-agnostic empty-read probe: read an absent key and assert it yields
   * the archetype's empty value. Required — a collection/log store always has a
   * single-key read verb; supply how to call it. (Registration is
   * unconditional so it stays out of the `no-conditional-tests` lint's way.)
   */
  readonly emptyRead: {
    /** How to read one addressable unit by key. */
    readonly read: (store: S, key: string) => Promise<unknown>;
    /** Expected value for an absent key (`undefined` for collection, `[]` for log). */
    readonly expected: unknown;
    /** Key to probe. Defaults to a clearly-absent sentinel. */
    readonly key?: string;
  };
  /**
   * Store-agnostic idempotent-delete probe: delete an absent key twice; both
   * settle without throwing. The store's own suite still owns the richer
   * "delete removes an existing record" assertions (those touch shape-specific
   * read verbs).
   */
  readonly idempotentDelete: (store: S, key: string) => Promise<unknown>;
  /** Register the store's shape-specific cases inside the shared describe. */
  readonly cases?: (ctx: StoreConformanceContext<S>) => void;
}

export function runStoreConformance<S extends { readonly backend: string }>(
  opts: StoreConformanceOptions<S>,
): void {
  const setup = async (): Promise<S> => opts.factory();
  const suite = opts.skip ? describe.skip : describe;

  suite(`Store conformance — ${opts.label}`, () => {
    it("reports a stable, non-empty backend identifier", async () => {
      const store = await setup();
      expect(typeof store.backend).toBe("string");
      expect(store.backend.length).toBeGreaterThan(0);
    });

    const emptyRead = opts.emptyRead;
    it("read of an unknown key returns the archetype's empty value", async () => {
      const store = await setup();
      const got = await emptyRead.read(store, emptyRead.key ?? "key:never-seen");
      expect(got).toEqual(emptyRead.expected);
    });

    const idempotentDelete = opts.idempotentDelete;
    it("delete of an absent key is idempotent (settles, never throws)", async () => {
      const store = await setup();
      // Both calls must settle; a throw fails the test.
      await idempotentDelete(store, "key:absent");
      await idempotentDelete(store, "key:absent");
    });

    opts.cases?.({ setup, capabilities: opts.capabilities });
  });
}
