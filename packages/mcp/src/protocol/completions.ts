import type { McpRequestExtras, OperationCtx } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

/**
 * Completion sugar builders for prompt/template argument completion
 * handlers.
 *
 * MCP spec caps `completion/complete` responses at 100 values per
 * request. All builders here enforce that automatically: when the
 * underlying source produces more, the result is truncated and
 * `hasMore: true` is set.
 *
 * **v1 origin:** ported from `packages/mcp/src/protocol/completions.ts`.
 * The context type extends the framework spine ({@link OperationCtx}) with
 * `resolvedArguments` (ADR 91 §2): a completion handler now reads the trunk
 * (sessionId / `mcp.user` identity) plus the `log` / `trace` / `run` facets
 * off the SAME ctx it reads sibling arguments from — so a DB-backed
 * completion can scope its query to the authenticated principal. The
 * completions projection derives it per-request via `deriveContext`; the new
 * facet/trunk fields are additive, so existing `CompletionHandler`
 * implementations (which read only `resolvedArguments`) are unchanged.
 */

/** Spec-mandated max values per `completion/complete` response. */
export const COMPLETION_MAX_VALUES = 100;

// ============================================================================
// Types
// ============================================================================

/**
 * Result shape for a `completion/complete` response. Servers MUST cap
 * `values` at 100; the sugar builders below enforce this
 * automatically.
 */
export interface CompletionResult {
  readonly values: readonly string[];
  readonly total?: number;
  readonly hasMore?: boolean;
}

/**
 * Context surfaced to a completion handler. Extends the framework spine
 * ({@link OperationCtx}, ADR 91 §2) — the trunk (sessionId / opId / the
 * `mcp.user` authenticated identity) plus the `log` / `trace` / `metrics` /
 * `run` facets — with `resolvedArguments`, the sibling-argument values the
 * user has already entered (the protocol's `context.arguments` field). A
 * DB-backed completion reads `ctx.user` / the MCP identity to scope its
 * query; a simple prefix-match handler ignores everything but
 * `resolvedArguments`.
 */
export interface CompletionContext extends OperationCtx {
  /**
   * Already-resolved sibling arguments for the same prompt or
   * resource template. Empty object when the request omits
   * `context.arguments`.
   */
  readonly resolvedArguments: Readonly<Record<string, string>>;
  /**
   * The MCP boundary facet — the SAME `ctx.mcp` a tool handler reads
   * (connection id, transport kind, client info, and the FULL authenticated
   * user record the `Authenticator` resolved).
   *
   * **This is the credential's legitimate home.** `ctx.identity` on the trunk
   * is the REDACTED projection: it is stamped on the crossing's `EventScope`
   * and therefore journaled, so it carries identifiers only (see
   * `McpServerOptions.identityProjection`). This facet is ctx-only — never
   * serialized, never on an `EventScope` — so a completion handler that must
   * call a downstream API on the caller's behalf reads the live credential
   * here: `ctx.mcp?.user?.token`.
   *
   * `undefined` when the handler was invoked outside an MCP crossing.
   */
  readonly mcp?: McpRequestExtras;
}

/**
 * Handler signature for argument completion. Receives the partial
 * value the user has typed so far and a context with already-resolved
 * sibling arguments. Returns a typed `CompletionResult` or a plain
 * `string[]` (legacy shape, coerced).
 */
export type CompletionHandler = (
  value: string,
  ctx: CompletionContext,
) => CompletionResult | readonly string[] | Promise<CompletionResult | readonly string[]>;

// ============================================================================
// Internal helpers
// ============================================================================

function clamp(result: CompletionResult): CompletionResult {
  if (result.values.length <= COMPLETION_MAX_VALUES) return result;
  return {
    values: result.values.slice(0, COMPLETION_MAX_VALUES),
    ...omitUndefined({ total: result.total }),
    hasMore: true,
  };
}

/**
 * Coerce raw handler output (legacy `string[]` shape or
 * `CompletionResult`) into a normalized `CompletionResult`, then
 * apply the 100-cap.
 */
export function normalizeCompletionResult(
  raw: CompletionResult | readonly string[],
): CompletionResult {
  if (Array.isArray(raw)) {
    return clamp({ values: [...(raw as readonly string[])] });
  }
  return clamp(raw as CompletionResult);
}

/** Default case-sensitive prefix match. */
function prefixMatch(values: readonly string[], typed: string): string[] {
  if (typed === "") return [...values];
  return values.filter((v) => v.startsWith(typed));
}

// ============================================================================
// Sugar builders
// ============================================================================

/**
 * Static array of values. Prefix-filters case-sensitively against the
 * typed input; returns the full list when input is empty.
 *
 * ```ts
 * complete: { status: completeFromList(["open", "closed", "in_progress"]) }
 * ```
 */
export function completeFromList(values: readonly string[]): CompletionHandler {
  return (typed) => clamp({ values: prefixMatch(values, typed) });
}

/**
 * Extracts options from a Zod enum (or any object exposing an
 * `options` string array) and prefix-filters them.
 *
 * ```ts
 * const Priority = z.enum(["low", "medium", "high"]);
 * complete: { priority: completeFromEnum(Priority) }
 * ```
 *
 * Structural typing keeps this compatible across Zod 3 / Zod 4.
 */
export function completeFromEnum(schema: {
  readonly options: readonly string[];
}): CompletionHandler {
  return completeFromList(schema.options);
}

/**
 * Lazy loader returning the full candidate set. Sugar prefix-filters
 * the result against the typed input. Loader can be sync or async.
 *
 * ```ts
 * complete: {
 *   projectId: completePrefixMatch(async () => {
 *     const projects = await db.projects.find();
 *     return projects.map((p) => p.id);
 *   }),
 * }
 * ```
 */
export function completePrefixMatch(
  loader: () => readonly string[] | Promise<readonly string[]>,
): CompletionHandler {
  return async (typed) => {
    const all = await loader();
    return clamp({ values: prefixMatch(all, typed) });
  };
}

/**
 * Declares which sibling arguments must be resolved before this
 * completion runs. If any required arg is missing from
 * `ctx.resolvedArguments`, returns empty without invoking the loader.
 *
 * ```ts
 * complete: {
 *   contractId: completeDependent(
 *     { requires: ["projectId"] },
 *     async (typed, { projectId }) => {
 *       const contracts = await db.contracts.find({ projectId });
 *       return contracts.map((c) => c.id);
 *     },
 *   ),
 * }
 * ```
 */
export function completeDependent<K extends string>(
  opts: { readonly requires: readonly K[] },
  fn: (
    value: string,
    deps: Record<K, string>,
  ) => readonly string[] | CompletionResult | Promise<readonly string[] | CompletionResult>,
): CompletionHandler {
  return async (typed, ctx) => {
    const deps = {} as Record<K, string>;
    for (const key of opts.requires) {
      const v = ctx.resolvedArguments[key];
      if (v === undefined) return { values: [] };
      deps[key] = v;
    }
    const raw = await fn(typed, deps);
    return normalizeCompletionResult(raw);
  };
}

/**
 * Escape hatch — full control over the response. Use when you need
 * to set `total`/`hasMore` explicitly, do custom matching, or read
 * from `ctx.resolvedArguments` without declaring the dependency
 * upfront. Output is still clamped to 100 values.
 *
 * ```ts
 * complete: {
 *   tag: completeFromAsync(async (value, ctx) => {
 *     const tags = await db.tags.find({ name: { $like: `${value}%` } });
 *     return {
 *       values: tags.map((t) => t.name),
 *       total: tags.totalCount,
 *       hasMore: tags.hasNext,
 *     };
 *   }),
 * }
 * ```
 */
export function completeFromAsync(
  fn: (
    value: string,
    ctx: CompletionContext,
  ) => CompletionResult | readonly string[] | Promise<CompletionResult | readonly string[]>,
): CompletionHandler {
  return async (value, ctx) => {
    const raw = await fn(value, ctx);
    return normalizeCompletionResult(raw);
  };
}
