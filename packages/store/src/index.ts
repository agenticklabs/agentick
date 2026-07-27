/**
 * @agentick/store — generic store substrate for Agentick v2.
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
 *   - {@link View} — the harness-side SYNCHRONOUS projection of a
 *     `Store`: sync read cache + write-through (via the `query`/`mutate`
 *     seam) + a `KeyedNotifier` (render pings) + a `ChangeNotifier` (typed
 *     deltas), all in ONE primitive. This is the convergence that RETIRED the
 *     earlier `CollectionProjection` (sync cache + write-through + hydrate) once
 *     every store-backed harness — knobs, state (Cut 1), skills, prompts (Cut 2a)
 *     — moved onto it. A store-backed harness whose protocol reads are
 *     synchronous composes this instead of re-deriving the projection + notify
 *     seams by hand.
 *   - {@link LogView} — the LOG-archetype sibling of {@link View}: the
 *     harness-side SYNCHRONOUS projection of a `LogStore`. Owns the two-tier
 *     (durable log + materialized projection) storage + write-behind pump +
 *     compaction-target machine the timeline harness hand-rolled, generic over
 *     the entry type `T`. `View : CollectionStore :: LogView : LogStore`.
 *
 * Plus, on the `@agentick/store/testing` subpath (NOT this barrel — test
 * doubles and conformance suites never ship on the production entry point):
 * `runStoreConformance`, the shared conformance skeleton the per-store suites
 * (`runTaskStoreConformance`, `runTimelineStoreConformance`) delegate their
 * store-agnostic cases to.
 *
 * The archetype **port** shapes (`CollectionStore`) live in `@agentick/spec`
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
export { View, type ViewConfig } from "./view.js";
export {
  LogView,
  type LogViewConfig,
  type LogViewSnapshot,
  type LogViewReadSnapshot,
  type LogProjectionMeta,
  type LogViewImportMode,
} from "./log-view.js";
export { JournalProjectedStore, type JournalProjectedConfig } from "./journal-projected.js";
export { IdempotentCollectionStore, idempotentWrite } from "./idempotent-write.js";
export { stubStoreCtx } from "./stub-store-ctx.js";
