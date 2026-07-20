/**
 * @agentick/store-next — generic store substrate for Agentick v2.
 *
 * The "conform, don't reinvent" halves of a store-backed harness's default
 * backing:
 *
 *   - {@link MemoryCollection} — the `Map`-backed generic that subsumes every
 *     collection-archetype in-memory store (tasks today; credentials / knobs /
 *     state / session next). Parameterize `{ backend, keyOf, matchQuery,
 *     prunePredicate? }`; the mechanics are the generic's.
 *   - {@link MemoryLog} — the log-side sibling: the `Map`-backed generic that
 *     subsumes every log-archetype in-memory store (timeline today). A full
 *     in-memory array per log is the intended default (no bounding — §2.7);
 *     the only per-store knob is the `backend` label.
 *   - {@link CollectionProjection} — the synchronous read-model over an async
 *     `CollectionStore`: sync cache + write-through + hydrate, the primitive
 *     that fell out of runs #1 (tasks) and #2 (knobs). A store-backed harness
 *     whose protocol reads are synchronous composes this instead of
 *     re-deriving the projection + dual-write by hand.
 *   - {@link ReactiveView} — the convergence of `CollectionProjection` + a
 *     `KeyedNotifier` (render pings) + a `ChangeNotifier` (typed deltas) into
 *     ONE harness-side sync projection of a `ReactiveStore`. Drives the store
 *     through the `query`/`mutate` seam. Knobs + state compose this (Cut 1); the
 *     remaining harnesses fan out in Cut 2. Coexists with `CollectionProjection`
 *     until then.
 *   - {@link runStoreConformance} — the shared conformance skeleton the
 *     per-store suites (`runTaskStoreConformance`, `runTimelineStoreConformance`)
 *     delegate their store-agnostic cases to.
 *
 * The archetype **port** shapes (`CollectionStore`) live in `@agentick/spec-next`
 * (the cross-package contract); the defaults + conformance live here.
 *
 * Private workspace package. Bundled into the `agentick` metapackage; not
 * published independently.
 *
 * @see docs/proposals/v2/data-layer-plan.md
 */

export {
  MemoryCollection,
  type MemoryCollectionConfig,
  type CollectionChangeEvent,
} from "./memory-collection.js";
export { MemoryLog, type MemoryLogConfig } from "./memory-log.js";
export { CollectionProjection } from "./collection-projection.js";
export { ReactiveView, type ReactiveViewConfig } from "./reactive-view.js";
export { JournalProjectedStore, type JournalProjectedConfig } from "./journal-projected.js";
export { IdempotentCollectionStore, idempotentWrite } from "./idempotent-write.js";
export {
  runStoreConformance,
  type StoreCapabilities,
  type StoreConformanceContext,
  type StoreConformanceOptions,
} from "./store-conformance.js";
export { stubStoreCtx } from "./stub-store-ctx.js";
