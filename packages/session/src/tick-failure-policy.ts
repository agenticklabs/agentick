/**
 * The bundled tick-failure policy (ADR 99 slice 3) — the flippable opinion
 * about which failed ticks are worth re-issuing.
 *
 * A failed tick persists nothing, so a retry is an identical model request.
 * That is promising for nondeterministic model garbage and futile (and billed)
 * for a deterministically bad request, and only the adapter can tell the two
 * apart — which is why this reads the `_tag` the adapters emit.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import type { ExecuteErrorChannel, TickFailureInfo, TickFailurePolicy } from "@agentick/spec";

/** Retries the bundled default allows for one malformed generation. */
const DEFAULT_MALFORMED_RETRIES = 1;

export type TickFailurePredicate = (
  error: ExecuteErrorChannel,
  info: TickFailureInfo,
) => "retry" | "stop";

/**
 * Retry a malformed generation once; stop on everything else.
 *
 * `MalformedModelOutput` is the one class where re-issuing is a real recovery:
 * the request was fine and the model's own output was unusable, so there is
 * nothing coherent to show the model and nothing to repair. Every other class
 * describes a request the provider will refuse identically.
 */
const bundledPolicy: TickFailurePredicate = (error, info) =>
  error._tag === "MalformedModelOutput" && info.consecutiveFailures <= DEFAULT_MALFORMED_RETRIES
    ? "retry"
    : "stop";

/**
 * Normalize the dual-form option into the live predicate (ADR 42 — the
 * config-object form is sugar over the live form, not a third form).
 *
 * A supplied policy REPLACES the bundled default rather than layering under
 * it: a table that omits `MalformedModelOutput` is an adopter saying that
 * class should not retry, and silently keeping the bundled retry would make
 * the option unable to express its own most obvious use.
 */
export function resolveTickFailurePolicy(
  policy: TickFailurePolicy | undefined,
): TickFailurePredicate {
  if (policy === undefined) return bundledPolicy;
  if (typeof policy === "function") return policy;
  return (error, info) =>
    info.consecutiveFailures <= (policy[error._tag] ?? 0) ? "retry" : "stop";
}
