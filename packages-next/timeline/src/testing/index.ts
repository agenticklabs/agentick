/**
 * `@agentick/timeline-next/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory. Adopters compose their test bridges by importing
 * from each harness's testing subpath, or use the convenience
 * `fakeBridges()` from `agentick/testing`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { TimelineEntry } from "@agentick/spec-next";

import { TimelineHarness } from "../harness.js";

/**
 * Build a {@link TimelineHarness} with its own in-memory substrate
 * (journal/bus/inbox). Real session deployments share substrate with
 * the host AppHarness; this factory is for standalone unit tests
 * where the substrate plumbing isn't exercised.
 *
 * `initial` seeds entries eagerly via `importSnapshot({ mode: "as-is" })` —
 * both log and projection start as a live mirror of the supplied array.
 */
export function stubTimelineHarness(initial: readonly TimelineEntry[] = []): TimelineHarness {
  const harness = new TimelineHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  if (initial.length > 0) {
    void harness.importSnapshot({
      persisted: initial,
      projection: initial,
      persistedVersion: initial.length,
      projectionVersion: initial.length,
    });
  }
  return harness;
}
