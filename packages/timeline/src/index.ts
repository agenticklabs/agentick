/**
 * @agentick/timeline — TimelineHarness extraction (ADR 26 Step 5a).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withTimeline()` +
 * `TimelineHarness` via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.timeline` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { TimelineHarness, type TimelineHarnessOptions } from "./harness.js";
export type { TimelineHandle } from "./handle.js";
// The `timeline:history` read contract — the shapes the command and its wire
// projection (`timeline/history`) carry. Exported so an adopter typing a guard,
// a hook, or a bespoke consumer of the read names the same shapes it does.
export type { TimelineHistoryInput, TimelineHistoryPage } from "./wire-augment.js";
export { withTimeline, type TimelineConfig, type WithTimelineOptions } from "./extension.js";

// ADR 93 — the namespace definition: `defineTimeline` (identity + brand) and
// `defineTimelineStore` (the port's typed inline constructor), plus the genesis
// seam's types. The definition IS the options for `withTimeline` and the
// top-level `createApp({ timeline })` slot alike.
export {
  defineTimeline,
  defineTimelineStore,
  isTimelineDefinition,
  isTimelineHarnessInstance,
  type BrandedTimelineDefinition,
  type TimelineCompactCtx,
  type TimelineCompactor,
  type TimelineDefinition,
  type TimelineHydrateCtx,
  type TimelineHydrator,
  type TimelineStoreVerbs,
} from "./definition.js";
// The named hydrators — the genesis-seam library. `hydrateFromStore()` is the
// default when a store is configured (ADR 49 preserved); `hydrateTail(n)` is
// the bounded-memory form.
export { hydrateFromStore, hydrateTail } from "./hydrators.js";

// Compaction-strategy factories live at the `@agentick/timeline/strategies`
// subpath (parallel to skills' `/loaders`) — they return CompactStrategy
// VALUES, not `withX` session extensions. See ./strategies.ts.

// ADR 49 — "stores, not snapshots" durability. The bundled in-memory default;
// the port + `SeqTagged` shape now live in `@agentick/spec` (the LOG
// archetype `TimelineStore extends LogStore<TimelineEntry>`; data-layer plan
// §6-D).
export { MemoryTimelineStore } from "./store.js";
// Re-exported so store adapters (`@agentick/timeline-fs`,
// `-postgres`, adopter-written) get the port + entry + seq-tag types from
// the same package as the harness they back — one dep, not two.
export type {
  LogMutation,
  LogQuery,
  SeqTagged,
  StoreCtx,
  TimelineEntry,
  TimelineStore,
} from "@agentick/spec";
