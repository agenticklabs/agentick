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
 *   - {@link CollectionProjection} — the synchronous read-model over an async
 *     `CollectionStore`: sync cache + write-through + hydrate, the primitive
 *     that fell out of runs #1 (tasks) and #2 (knobs). A store-backed harness
 *     whose protocol reads are synchronous composes this instead of
 *     re-deriving the projection + dual-write by hand.
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

export { MemoryCollection, type MemoryCollectionConfig } from "./memory-collection.js";
export { CollectionProjection } from "./collection-projection.js";
export {
  runStoreConformance,
  type StoreCapabilities,
  type StoreConformanceContext,
  type StoreConformanceOptions,
} from "./store-conformance.js";
