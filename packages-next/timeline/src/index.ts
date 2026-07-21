/**
 * @agentick/timeline-next — TimelineHarness extraction (ADR 26 Step 5a).
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
export { withTimeline, type WithTimelineOptions } from "./extension.js";
export { runTimelineHarnessConformance } from "./conformance.js";

// Compaction-strategy factories live at the `@agentick/timeline-next/strategies`
// subpath (parallel to skills' `/loaders`) — they return CompactStrategy
// VALUES, not `withX` session extensions. See ./strategies.ts.

// ADR 49 — "stores, not snapshots" durability. The bundled in-memory default;
// the port + `SeqTagged` shape now live in `@agentick/spec-next` (the LOG
// archetype `TimelineStore extends LogStore<TimelineEntry>`; data-layer plan
// §6-D).
export { MemoryTimelineStore } from "./store.js";
// Re-exported so store adapters (`@agentick/timeline-fs-next`,
// `-postgres-next`, adopter-written) get the port + entry + seq-tag types from
// the same package as the harness they back — one dep, not two.
export type {
  LogMutation,
  LogQuery,
  SeqTagged,
  StoreCtx,
  TimelineEntry,
  TimelineStore,
} from "@agentick/spec-next";
export {
  runTimelineStoreConformance,
  type TimelineStoreConformanceOptions,
} from "./store-conformance.js";
