/**
 * `runDetached` — run an Effect whose failure is diagnostics, never a
 * process signal.
 *
 * The contract every fire-and-forget site needs and each had hand-rolled
 * (or forgotten): a floating `Effect.runPromise(...)` whose rejection
 * nobody observes is an unhandled rejection, and Node's default for those
 * is process death — one harness's hiccup projected onto the whole
 * server (#315). This is the ONE place a detached effect is allowed to
 * run; `scripts/detached-effect-gate.mjs` holds the line.
 *
 * Loud by default: a sink that swallowed would reintroduce the silent
 * half of the same bug. Harnesses bind their own log facet via
 * `BaseHarness.runDetached`.
 */

import { Effect } from "effect";

export function defaultDetachedSink(error: unknown): void {
  console.error("[agentick] detached effect failed:", error);
}

export function runDetached<A, E>(
  effect: Effect.Effect<A, E, never>,
  onError: (error: unknown) => void = defaultDetachedSink,
): void {
  Effect.runPromise(effect).then(undefined, onError);
}
