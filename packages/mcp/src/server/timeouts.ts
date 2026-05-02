/**
 * Timeout helpers — translate user-facing "never" sentinel to a numeric
 * timeout the SDK accepts.
 *
 * Node's `setTimeout` clamps positive values above `2_147_483_647` (about
 * 24.8 days) by firing immediately, so we use that as our effectively-
 * indefinite ceiling. For any user-loop interaction (elicitation, slow
 * prompt handlers) this is "never" in practice.
 *
 * @module @agentick/mcp/server/timeouts
 */

/**
 * Node's `setTimeout` upper bound, in milliseconds — ~24.8 days. Used
 * as the "never" sentinel translation: any positive value beyond this
 * causes Node to fire immediately, so we cap exactly here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Public timeout option type. Accepts:
 * - `undefined` — use the framework default
 * - a positive number — that many milliseconds
 * - `0` — disable the timeout (idiomatic — matches axios / XHR / socket)
 * - `"never"` — disable the timeout (explicit, self-documenting)
 *
 * Both `0` and `"never"` resolve to `MAX_TIMEOUT_MS` (~24.8 days,
 * Node's `setTimeout` ceiling). The MCP spec does not mandate timeouts;
 * they're a framework convention.
 */
export type TimeoutOption = number | "never";

/**
 * Resolve a `TimeoutOption` to a numeric millisecond value the SDK can
 * accept. Returns `undefined` (use SDK default) when input is undefined,
 * `MAX_TIMEOUT_MS` when input is `"never"` or `0`, otherwise the input
 * as-is. Negative numbers are also treated as "never" since they would
 * otherwise fire immediately under Node's `setTimeout` semantics.
 */
export function resolveTimeout(opt: TimeoutOption | undefined): number | undefined {
  if (opt === undefined) return undefined;
  if (opt === "never") return MAX_TIMEOUT_MS;
  if (typeof opt === "number" && opt <= 0) return MAX_TIMEOUT_MS;
  return opt;
}

/**
 * Spec-recommended defaults for user-loop interactions. Server-side
 * outbound primitives should pass these when no explicit `timeoutMs` is
 * supplied — the SDK's 60s default is too short when the user has to
 * read, decide, or fill out a form.
 */
export const ELICITATION_FORM_DEFAULT_MS = 5 * 60_000; // 5 minutes
export const ELICITATION_URL_DEFAULT_MS = 30 * 60_000; // 30 minutes (OAuth)
