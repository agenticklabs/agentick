/**
 * `@agentick/timeline/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory. Adopters compose their test bridges by importing
 * from each harness's testing subpath, or use the convenience
 * `fakeBridges()` from `agentick/testing`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { TimelineEntry } from "@agentick/spec";

import { TimelineHarness, type TimelineHarnessOptions } from "../harness.js";

/**
 * Build a {@link TimelineHarness} with its own in-memory substrate
 * (journal/bus/inbox). Real session deployments share substrate with
 * the host AppHarness; this factory is for standalone unit tests
 * where the substrate plumbing isn't exercised.
 *
 * `initial` seeds entries eagerly via the genesis seed law — both log and
 * projection start as a live mirror of the supplied array, and nothing is
 * written back to the store.
 *
 * `options` threads through to the harness constructor — pass `{ store }` /
 * `{ writePolicy }` (ADR 49) to exercise durable-backing behavior.
 */
export function stubTimelineHarness(
  initial: readonly TimelineEntry[] = [],
  options: TimelineHarnessOptions = {},
): TimelineHarness {
  const harness = new TimelineHarness(
    `stub:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  if (initial.length > 0) harness.seed(initial);
  return harness;
}

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runTimelineHarnessConformance } from "../conformance.js";
export {
  runTimelineStoreConformance,
  type TimelineStoreConformanceOptions,
} from "../store-conformance.js";
