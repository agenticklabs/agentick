import type { HarnessFx } from "@agentick/spec";

/**
 * Conformance suite for BaseHarness implementations.
 *
 * Stub: signature only. Bodies populated in Phase 3.
 *
 * Invariants the suite will validate (per `01-harness-principle.md`,
 * `19-foundation.md`):
 *
 *   Phase contract:
 *     - Every command emits exactly one `requested` and exactly one `terminal`
 *     - `before` emitted iff command is interceptable
 *     - `delta` emissions only between `requested` and `terminal`
 *
 *   Surface integrity:
 *     - Lifecycle handlers (.onX) registered run in registration order
 *     - Middleware (.use) composes outer-wraps-inner
 *     - Inbox handlers dispatch by typed message discriminator
 *     - Events publish to bus per JournalingPolicy
 *     - Same opId returns cached terminal (idempotent replay)
 *
 *   Verdict merge:
 *     - veto > replace > defer > proceed across handlers
 *
 *   Outcome consistency:
 *     - Failed body → terminal:failed with typed error
 *     - Throw in handler → handler error path
 *     - Cancellation signal → terminal:canceled
 */
export function runHarnessConformance(
  // factory: () => BaseHarness,  // typed once BaseHarness lands in runtime
  _factory: () => unknown,
): void {
  // TODO(phase-3): implement after BaseHarness lands in @agentick/runtime
  // and one concrete harness (tool executor) is implemented to drive the suite.
  throw new Error("runHarnessConformance: not yet implemented (Phase 3)");
}

/**
 * The inert `HarnessFx` primitives (ADR 96) — every `.fx` surface carries
 * `use` and `guard`, and a protocol stub that only needs its operation twins
 * spreads these rather than restating them:
 *
 * ```ts
 * fx: { ...stubHarnessFx(), renderTree: () => Effect.succeed(tree) }
 * ```
 *
 * Both registers succeed and return an `Unsubscribe` that removes nothing —
 * the stub has no chain to register on.
 */
export function stubHarnessFx(): HarnessFx {
  return { use: () => () => {}, guard: () => () => {} };
}
