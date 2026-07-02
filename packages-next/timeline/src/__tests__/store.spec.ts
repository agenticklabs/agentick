/**
 * MemoryTimelineStore — runs the shared TimelineStore conformance suite
 * against the bundled default. Every adapter package re-runs this suite;
 * the bundled store is the reference it validates against.
 */

import { runTimelineStoreConformance } from "../store-conformance.js";
import { MemoryTimelineStore } from "../store.js";

runTimelineStoreConformance({
  label: "MemoryTimelineStore (bundled default)",
  factory: () => new MemoryTimelineStore(),
});
