/**
 * Completion sugar builders for `MCPPromptDefinition.complete` and
 * `MCPResourceTemplateDefinition.complete`.
 *
 * MCP spec 2025-11-25 caps completion responses at 100 values per
 * request. All builders here enforce that automatically: when the
 * underlying source produces more than 100, the result is truncated
 * and `hasMore: true` is set.
 *
 * @module @agentick/mcp/completions
 */

import type { CompletionHandler, CompletionResult, MCPCompletionContext } from "./types.js";

/** Spec-mandated max values per `completion/complete` response. */
export const COMPLETION_MAX_VALUES = 100;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Apply the 100-value cap, setting `hasMore` when truncation occurs.
 * Preserves caller-supplied `total` and `hasMore` when present, but
 * never lets `values.length` exceed the cap.
 */
function clamp(result: CompletionResult): CompletionResult {
  if (result.values.length <= COMPLETION_MAX_VALUES) return result;
  return {
    values: result.values.slice(0, COMPLETION_MAX_VALUES),
    total: result.total,
    hasMore: true,
  };
}

/**
 * Coerce raw handler output (string[] legacy shape or CompletionResult)
 * into a normalized CompletionResult, then apply the 100-cap.
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
 * typed input. Returns the full list when input is empty.
 *
 * ```ts
 * complete: { status: completeFromList(["open", "closed", "in_progress"]) }
 * ```
 */
export function completeFromList(values: readonly string[]): CompletionHandler {
  return (typed) => clamp({ values: prefixMatch(values, typed) });
}

/**
 * Extracts options from a Zod enum (or any object exposing an `options`
 * string array) and prefix-filters them.
 *
 * ```ts
 * const Priority = z.enum(["low", "medium", "high"]);
 * complete: { priority: completeFromEnum(Priority) }
 * ```
 *
 * Structural typing keeps this compatible across Zod 3 / Zod 4 — both
 * versions expose `.options` on a `ZodEnum` instance.
 */
export function completeFromEnum(schema: { options: readonly string[] }): CompletionHandler {
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
 *     return projects.map(p => p.id);
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
 *       return contracts.map(c => c.id);
 *     },
 *   ),
 * }
 * ```
 */
export function completeDependent<K extends string>(
  opts: { requires: readonly K[] },
  fn: (
    value: string,
    deps: Record<K, string>,
  ) => readonly string[] | CompletionResult | Promise<readonly string[] | CompletionResult>,
): CompletionHandler {
  return async (typed, ctx) => {
    const deps = {} as Record<K, string>;
    for (const key of opts.requires) {
      const v = ctx.resolvedArguments[key];
      if (v === undefined) {
        return { values: [] };
      }
      deps[key] = v;
    }
    const raw = await fn(typed, deps);
    return normalizeCompletionResult(raw);
  };
}

/**
 * Escape hatch — full control over the response. Use when you need to
 * set `total`/`hasMore` explicitly, do custom matching, or read from
 * `ctx.resolvedArguments` without declaring the dependency upfront.
 * Output is still clamped to 100 values.
 *
 * ```ts
 * complete: {
 *   tag: completeFromAsync(async (value, ctx) => {
 *     const tags = await db.tags.find({ name: { $like: `${value}%` } });
 *     return {
 *       values: tags.map(t => t.name),
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
    ctx: MCPCompletionContext,
  ) => CompletionResult | string[] | Promise<CompletionResult | string[]>,
): CompletionHandler {
  return async (value, ctx) => {
    const raw = await fn(value, ctx);
    return normalizeCompletionResult(raw);
  };
}
