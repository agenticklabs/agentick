/**
 * `@agentick/knobs/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory. Adopters compose their test bridges by importing
 * from each harness's testing subpath, or use the convenience
 * `fakeBridges()` from `agentick/testing`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { KnobPrimitive } from "@agentick/spec";

import { KnobsHarness } from "../harness.js";

/**
 * Build a {@link KnobsHarness} with its own in-memory substrate
 * (journal/bus/inbox). `initial` seeds values eagerly via
 * `importSnapshot`.
 */
export function stubKnobsHarness(
  initial: Readonly<Record<string, KnobPrimitive>> = {},
): KnobsHarness {
  const harness = new KnobsHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  if (Object.keys(initial).length > 0) {
    harness.importSnapshot(initial);
  }
  return harness;
}

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runKnobsHarnessConformance } from "../conformance.js";
