/**
 * Outcome and verdict types.
 *
 * Outcomes are the terminal verdicts of commands. Verdicts are the
 * responses lifecycle handlers / middleware return when participating
 * in a `before`-phase boundary.
 *
 * @see docs/proposals/v2/blueprint/01-harness-principle.md §Outcome vocabulary
 */

/**
 * Terminal command outcome. Six values: success, failure,
 * cancellation, veto, replacement, deferral.
 *
 * Replacement and veto are the result of lifecycle handler / middleware
 * intervention at a `before`-phase boundary. Deferral asks the runtime
 * to retry after a delay.
 *
 * The `outcome` field is populated on envelopes with `phase: "terminal"`.
 */
export type CommandOutcome =
  | "succeeded"
  | "failed"
  | "canceled"
  | "vetoed"
  | "replaced"
  | "deferred";

/**
 * Verdict a lifecycle handler / middleware returns at a `before`-phase
 * boundary. Multiple handlers' verdicts merge per:
 *
 *   veto > replace > defer > proceed
 *
 * First veto wins. First replace wins. Deferreds merge by earliest
 * retry. Multiple proceeds collapse to one.
 *
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md §Verdict merge
 */
export type HandlerVerdict<R = unknown> =
  | { readonly kind: "proceed" }
  | { readonly kind: "defer"; readonly retryAfter?: number }
  | { readonly kind: "veto"; readonly reason?: string }
  | { readonly kind: "replace"; readonly result: R; readonly reason?: string };

/**
 * Terminal envelope. Carried as the `payload` of an
 * `EventEnvelope { phase: "terminal" }`.
 *
 * Discriminated by `outcome`. Success and replacement carry a typed
 * result; failure carries a typed error; cancellation, veto, defer
 * carry optional metadata.
 */
export type TerminalEvent<R = unknown, E = unknown> =
  | { readonly outcome: "succeeded"; readonly result: R }
  | { readonly outcome: "failed"; readonly error: E }
  | { readonly outcome: "canceled"; readonly reason?: string }
  | { readonly outcome: "vetoed"; readonly reason?: string }
  | { readonly outcome: "replaced"; readonly result: R; readonly reason?: string }
  | { readonly outcome: "deferred"; readonly retryAfter?: number };

/**
 * Scope at which a lifecycle handler or middleware is registered.
 *
 * Ordering rule per `01-harness-principle.md`:
 *   before phase   — global → app → session (outer wraps inner)
 *   terminal phase — session → app → global (inner completes first)
 */
export interface HandlerScope {
  readonly scope: "global" | "app" | "session";
  /** Concrete identifier when scope is "app" or "session". */
  readonly scopeId?: string;
}
