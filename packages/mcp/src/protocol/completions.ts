/**
 * MCP's edge of the completions seam — the ctx an MCP-origin completion handler
 * sees, and the sugar family re-exported from where it now lives.
 *
 * ## The builders moved out (and lost their cap)
 *
 * `completeFromList` / `completeFromEnum` / `completePrefixMatch` /
 * `completeDependent` / `completeFromAsync` + `normalizeCompletionResult` live in
 * **`@agentick/completions`** — they are not MCP's, they are the framework's
 * (native prompts, the agentick wire, and this projection all want the same
 * five). They are re-exported here so a server adopter keeps building
 * `completions` handlers from the same import path as the harness.
 *
 * The lift stripped v1's 100-value clamp from inside every builder. That cap is
 * MCP's constraint on `completion/complete`, and **wire constraints live at the
 * wire**: `COMPLETION_MAX_VALUES` + the truncation now live in
 * `../server/projection/completions.ts`, applied to the RESULT after the handler
 * runs. Net behavior on the MCP wire is unchanged (≤100 values, `hasMore` on
 * truncation); a builder called directly no longer truncates.
 *
 * @see docs/proposals/v2/completions.md §2.4
 * @see ../server/projection/completions.ts — where the cap is enforced
 */

import type { CompletionCtx, CompletionValues, McpRequestExtras } from "@agentick/spec";

// ============================================================================
// The MCP-origin completion ctx
// ============================================================================

/**
 * Context surfaced to an MCP completion handler: spec's {@link CompletionCtx}
 * (the ADR 91 trunk + `log`/`trace`/`metrics`/`run` facets +
 * `resolvedArguments` + `signal`) with ONE boundary facet MCP adds.
 *
 * A DB-backed completion reads the identity to scope its query; a simple
 * prefix-match handler ignores everything but `resolvedArguments`.
 */
export interface CompletionContext extends CompletionCtx {
  /**
   * The MCP boundary facet — the SAME `ctx.mcp` a tool handler reads (connection
   * id, transport kind, client info, and the FULL authenticated user record the
   * `Authenticator` resolved).
   *
   * **This is the credential's legitimate home.** `ctx.identity` on the trunk is
   * the REDACTED projection: it is stamped on the crossing's `EventScope` and
   * therefore journaled, so it carries identifiers only (see
   * `McpServerOptions.identityProjection`). This facet is ctx-only — never
   * serialized, never on an `EventScope` — so a completion handler that must call
   * a downstream API on the caller's behalf reads the live credential here:
   * `ctx.mcp?.user?.token`.
   *
   * `undefined` when the handler was invoked outside an MCP crossing.
   */
  readonly mcp?: McpRequestExtras;
}

/**
 * Handler signature for MCP argument completion — spec's `CompletionResolver`
 * narrowed to {@link CompletionContext}. A resolver built with the `complete*`
 * family (typed against the broader `CompletionCtx`) is assignable here.
 */
export type CompletionHandler = (
  value: string,
  ctx: CompletionContext,
) => CompletionValues | Promise<CompletionValues>;

// ============================================================================
// Re-exports — the sugar family + the result currency
// ============================================================================

export {
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  isDependentResolver,
  normalizeCompletionResult,
  type DependentCompletionResolver,
} from "@agentick/completions";
export type { CompletionResult } from "@agentick/spec";
