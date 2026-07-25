/**
 * `@agentick/state/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { StateHarness } from "../harness.js";

/**
 * Build a {@link StateHarness} with its own in-memory substrate.
 * `initial` seeds entries eagerly via `importSnapshot`.
 */
export function stubStateHarness(initial: Readonly<Record<string, unknown>> = {}): StateHarness {
  const harness = new StateHarness(
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
export { runStateHarnessConformance } from "../conformance.js";
