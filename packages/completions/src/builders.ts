/**
 * The `complete*` sugar family — the five ways to author a completion source,
 * plus the result normalizer.
 *
 * **Lifted from `@agentick/mcp/protocol/completions` with the 100-cap removed.**
 * v1 clamped inside every builder, and v2's mcp package inherited that: a
 * builder called from anywhere silently truncated at 100 because that is what
 * MCP's `completion/complete` allows. MCP's constraint belongs at MCP's wire —
 * `@agentick/mcp/server/projection/completions.ts` applies it to the RESULT — so
 * a builder here returns everything it found. Another wire with a different
 * limit trims to its own; a programmatic caller gets the whole answer.
 *
 * @see docs/proposals/v2/completions.md §4
 * @verifiedBy packages/completions/src/__tests__/builders.spec.ts
 */

import type {
  CompletionCtx,
  CompletionResolver,
  CompletionResult,
  CompletionValues,
} from "@agentick/spec";

// ============================================================================
// Normalization
// ============================================================================

/**
 * Fold a resolver's return value into the full {@link CompletionResult} shape —
 * a bare `string[]` becomes `{ values }`, a full result passes through. The
 * harness's `resolve` runs every answer through this, so a consumer never has to
 * discriminate the sugar.
 */
export function normalizeCompletionResult(raw: CompletionValues): CompletionResult {
  if (Array.isArray(raw)) return { values: [...(raw as readonly string[])] };
  return raw as CompletionResult;
}

/** Default case-sensitive prefix match. Empty input matches everything. */
function prefixMatch(values: readonly string[], typed: string): string[] {
  if (typed === "") return [...values];
  return values.filter((v) => v.startsWith(typed));
}

// ============================================================================
// Sugar builders
// ============================================================================

/**
 * Static list, prefix-filtered case-sensitively. Returns the full list for empty
 * input.
 *
 * ```ts
 * { name: "status", complete: completeFromList(["open", "closed", "in_progress"]) }
 * ```
 */
export function completeFromList(values: readonly string[]): CompletionResolver {
  return (typed) => ({ values: prefixMatch(values, typed) });
}

/**
 * The `options` of a Zod enum (or anything else exposing a readonly string
 * array under that key), prefix-filtered. Structural on purpose — this package
 * has no zod dependency and the shape is identical across Zod 3 and Zod 4.
 *
 * ```ts
 * const Priority = z.enum(["low", "medium", "high"]);
 * { name: "priority", complete: completeFromEnum(Priority) }
 * ```
 */
export function completeFromEnum(schema: {
  readonly options: readonly string[];
}): CompletionResolver {
  return completeFromList(schema.options);
}

/**
 * Lazy loader for the full candidate set; the sugar prefix-filters the result.
 * Loader may be sync or async. Use when the set is expensive to build but small
 * enough to filter in memory.
 *
 * ```ts
 * { name: "projectId", complete: completePrefixMatch(async () => (await db.projects.find()).map((p) => p.id)) }
 * ```
 */
export function completePrefixMatch(
  loader: () => readonly string[] | Promise<readonly string[]>,
): CompletionResolver {
  return async (typed) => ({ values: prefixMatch(await loader(), typed) });
}

/**
 * A resolver that declares which sibling arguments it needs — and carries that
 * declaration as READABLE metadata (see {@link completeDependent}).
 */
export type DependentCompletionResolver<K extends string = string> = CompletionResolver & {
  /** The sibling-argument names that must be filled before this resolver runs. */
  readonly requires: readonly K[];
};

/**
 * Declared sibling dependencies. Any required argument missing from
 * `ctx.resolvedArguments` short-circuits to `{ values: [] }` WITHOUT invoking
 * `fn` — the phases of a job cannot be listed before a job is chosen.
 *
 * `requires` is also **metadata, not just control flow**: it is readable off the
 * returned resolver (`resolver.requires`, narrowed by
 * {@link isDependentResolver}), so a declaration or a client projection can say
 * "phase is not completable until job is filled" instead of issuing a doomed
 * request per keystroke.
 *
 * ```ts
 * { name: "phase", complete: completeDependent({ requires: ["job"] },
 *     (typed, { job }) => phasesApi.search(typed, job)) }
 * ```
 */
export function completeDependent<K extends string>(
  opts: { readonly requires: readonly K[] },
  fn: (
    value: string,
    deps: Record<K, string>,
    ctx: CompletionCtx,
  ) => CompletionValues | Promise<CompletionValues>,
): DependentCompletionResolver<K> {
  const resolver: CompletionResolver = async (typed, ctx) => {
    const deps = {} as Record<K, string>;
    for (const key of opts.requires) {
      const v = ctx.resolvedArguments[key];
      if (v === undefined) return { values: [] };
      deps[key] = v;
    }
    return normalizeCompletionResult(await fn(typed, deps, ctx));
  };
  // Non-enumerable so the metadata never shows up in a spread / JSON projection
  // of a resolver bag; a consumer reads it through the guard below.
  return Object.defineProperty(resolver, "requires", {
    value: Object.freeze([...opts.requires]),
    enumerable: false,
    configurable: false,
    writable: false,
  }) as DependentCompletionResolver<K>;
}

/**
 * Does this resolver declare sibling dependencies? The read door for
 * {@link completeDependent}'s `requires` metadata — a composer calls this to
 * decide whether a slot is completable yet.
 */
export function isDependentResolver(
  resolver: CompletionResolver,
): resolver is DependentCompletionResolver {
  const requires = (resolver as Partial<DependentCompletionResolver>).requires;
  return Array.isArray(requires) && requires.every((r) => typeof r === "string");
}

/**
 * Escape hatch — full control over the answer. Use when you need to set
 * `total` / `hasMore` explicitly, do custom matching, or read
 * `ctx.resolvedArguments` without declaring the dependency upfront.
 *
 * ```ts
 * { name: "job", complete: completeFromAsync(async (value, ctx) =>
 *     (await jobsApi.search(value, ctx)).map((j) => j.name)) }
 * ```
 */
export function completeFromAsync(
  fn: (value: string, ctx: CompletionCtx) => CompletionValues | Promise<CompletionValues>,
): CompletionResolver {
  return async (value, ctx) => normalizeCompletionResult(await fn(value, ctx));
}
