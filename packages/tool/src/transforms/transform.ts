/**
 * `ToolTransform<C>` — the core transform primitive.
 *
 * A `ToolTransform` is a named, context-aware mapping over
 * {@link ToolDeclaration} values. Returning `null` drops the tool;
 * returning a new declaration replaces it.
 *
 * Transforms are **stateless and reusable** — create once at module
 * init, apply many times. Composition is associative: order matters
 * (later transforms see what earlier ones produced).
 *
 * **Scope:** transforms operate on `ToolDeclaration` only, not on the
 * full registration bundle. Handler-aware transforms (middleware,
 * retry, logging) require the `CreatedTool` triple
 * (`declaration` + `handler` + `validator`) and are not in this
 * primitive's scope; they ship as `wrapHandler` separately.
 *
 * **Why context is generic.** The MCP server projection passes its
 * `McpRequestContext` (auth principal, session, clientInfo, custom
 * metadata). The tool-executor passes its `ToolHandlerCtx`. Eval-next
 * passes whatever its ablation harness wants. The transform doesn't
 * care; the consumer parameterizes `C` at the call site.
 *
 * Transforms are NOT a place to enforce semantic annotations like
 * `readOnlyHint` / `destructiveHint`. Those are SEMANTIC properties
 * set at `createTool` time — flowing them through projection unchanged
 * is intentional. Lying about destructiveness per-connection is a
 * safety footgun. See ADR 40 §4.
 */

import type { ToolDeclaration } from "@agentick/spec";

export interface ToolTransform<C = unknown> {
  /** Short name used for debugging + transform-trace metadata. */
  readonly name: string;
  /**
   * Map a `ToolDeclaration` to a new declaration, the same instance,
   * or `null` to drop. Pure: must not mutate the input.
   */
  readonly apply: (tool: ToolDeclaration, ctx: C) => ToolDeclaration | null;
}

/**
 * Compose N transforms into one. The composed transform applies each
 * in array order, threading the result through. The first transform
 * that returns `null` short-circuits the chain — subsequent transforms
 * are not invoked.
 *
 * The composed transform's `name` is `"compose(t1,t2,...)"` for
 * diagnostics; production code should not depend on its exact value.
 */
export function composeTransforms<C>(...transforms: readonly ToolTransform<C>[]): ToolTransform<C> {
  if (transforms.length === 0) {
    return { name: "compose()", apply: (tool) => tool };
  }
  if (transforms.length === 1) {
    return transforms[0]!;
  }
  return {
    name: `compose(${transforms.map((t) => t.name).join(",")})`,
    apply: (tool, ctx) => {
      let current: ToolDeclaration | null = tool;
      for (const transform of transforms) {
        if (current === null) return null;
        current = transform.apply(current, ctx);
      }
      return current;
    },
  };
}

/**
 * Apply a transform to a list of tool declarations, dropping any that
 * the transform returns `null` for. Preserves input order.
 *
 * Convenience helper for the common projection use case where the
 * caller has a `ToolDeclaration[]` and wants the projected view.
 */
export function applyTransform<C>(
  transform: ToolTransform<C>,
  tools: readonly ToolDeclaration[],
  ctx: C,
): readonly ToolDeclaration[] {
  const out: ToolDeclaration[] = [];
  for (const tool of tools) {
    const mapped = transform.apply(tool, ctx);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}
