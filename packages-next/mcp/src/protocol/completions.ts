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
 * The context type is intentionally narrower than v1's
 * `MCPCompletionContext` — server-side handler context (auth, session,
 * etc.) belongs to the future MCP server work; this file only needs
 * `resolvedArguments`.
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
 * Context surfaced to a completion handler. `resolvedArguments` carries
 * the values of any sibling arguments the user has already entered
 * (the protocol's `context.arguments` field).
 */
export interface CompletionContext {
  /**
   * Already-resolved sibling arguments for the same prompt or
   * resource template. Empty object when the request omits
   * `context.arguments`.
   */
  readonly resolvedArguments: Readonly<Record<string, string>>;
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
    ...(result.total !== undefined ? { total: result.total } : {}),
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
