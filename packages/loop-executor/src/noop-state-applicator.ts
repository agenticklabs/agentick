/**
 * `NoopStateApplicator` — placeholder used when no session harness is
 * present.
 *
 * The loop executor's contract requires a `StateApplicator` to write
 * its results back to session state. Until the session harness (Phase 4e)
 * lands, callers without a session can plug this in: every apply call
 * is a no-op.
 *
 * Note: with NoopStateApplicator, multi-tick runs do NOT reflect prior
 * ticks' tool results in the next render (because nothing writes to the
 * timeline the React tree consumes). Tests and the example demonstrate
 * single-tick and bounded-by-maxTicks scenarios; richer multi-tick
 * scenarios with timeline feedback arrive with the session harness.
 */

import { Effect } from "effect";

import type { StateApplicator, StateApplicatorFx } from "@agentick/spec";

export class NoopStateApplicator implements StateApplicator {
  /** No-op fx twins — compose in the loop's fiber, write nothing. */
  readonly fx: StateApplicatorFx = {
    applyExecutorResult: () => Effect.void,
    applyToolResults: () => Effect.void,
  };
  async applyExecutorResult(): Promise<void> {
    // intentional no-op
  }
  async applyToolResults(): Promise<void> {
    // intentional no-op
  }
  async appendEntry(): Promise<void> {
    // intentional no-op
  }
}
