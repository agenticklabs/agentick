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

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { KnobPrimitive } from "@agentick/spec";

import { KnobsHarness, type KnobsHarnessOptions } from "../harness.js";

/**
 * Build a {@link KnobsHarness} with its own in-memory substrate
 * (journal/bus/inbox). `initial` seeds values eagerly via `importSnapshot`.
 *
 * `opts.store` + `opts.scope` are what a checkpoint test needs: pass one store
 * and one scope to two successive stubs and `persist()` on the first is visible
 * to `hydrate()` on the second, exactly as an evict/resume cycle behaves.
 */
export function stubKnobsHarness(
  initial: Readonly<Record<string, KnobPrimitive>> = {},
  opts: { readonly store?: KnobsHarnessOptions["store"]; readonly scope?: string } = {},
): KnobsHarness {
  const harness = new KnobsHarness(
    opts.scope ?? `stub:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    undefined,
    opts.store !== undefined ? { store: opts.store } : {},
  );
  if (Object.keys(initial).length > 0) {
    harness.importSnapshot(initial);
  }
  return harness;
}

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runKnobsHarnessConformance } from "../conformance.js";
