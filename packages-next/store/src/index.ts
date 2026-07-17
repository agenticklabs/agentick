/**
 * @agentick/store-next — generic store substrate for Agentick v2.
 *
 * Two exports, both the "conform, don't reinvent" halves of a store-backed
 * harness's default backing:
 *
 *   - {@link MemoryCollection} — the `Map`-backed generic that subsumes every
 *     collection-archetype in-memory store (tasks today; credentials / knobs /
 *     state / session next). Parameterize `{ backend, keyOf, matchQuery,
 *     prunePredicate? }`; the mechanics are the generic's.
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
export {
  runStoreConformance,
  type StoreCapabilities,
  type StoreConformanceContext,
  type StoreConformanceOptions,
} from "./store-conformance.js";
