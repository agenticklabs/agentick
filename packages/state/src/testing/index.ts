/**
 * `@agentick/state/testing` — stub factory for tests.
 *
 * Per ADR 27, each harness package ships its own `/testing` subpath
 * with a stub factory.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";

import { StateHarness } from "../harness.js";
import type { StateStore } from "../store.js";

/**
 * How a stub deviates from a self-contained harness. `store` and `scopeId` are
 * what a checkpoint test needs: two harnesses over ONE store, sharing a scope to
 * assert durability across instances or differing to assert isolation.
 */
export interface StubStateHarnessOptions {
  readonly store?: StateStore;
  readonly scopeId?: string;
}

/**
 * Build a {@link StateHarness} with its own in-memory substrate.
 * `initial` seeds entries eagerly via `importSnapshot`.
 */
export function stubStateHarness(
  initial: Readonly<Record<string, unknown>> = {},
  options: StubStateHarnessOptions = {},
): StateHarness {
  const harness = new StateHarness(
    options.scopeId ?? `stub:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    options.store !== undefined ? { store: options.store } : {},
  );
  if (Object.keys(initial).length > 0) {
    harness.importSnapshot(initial);
  }
  return harness;
}

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runStateHarnessConformance } from "../conformance.js";
