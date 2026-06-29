/**
 * Name-targeting transforms: explicit rename, prefix, suffix.
 *
 * These rewrite `ToolDeclaration.name` (the model-facing identifier).
 * The `id` field is preserved unchanged — it's the framework-internal
 * primary key; only `name` changes on the wire.
 *
 * **Rename ordering caveat.** When composing rename + prefix:
 *
 *   composeTransforms(rename({ search: "find" }), prefix("api_"))
 *
 * The rename runs first, then prefix is applied to the renamed tool.
 * Result: "search" → "find" → "api_find". Flip the array to flip the
 * order. Reading the composition left-to-right is the rule.
 */

import type { ToolDeclaration } from "@agentick/spec-next";

import type { ToolTransform } from "./transform.js";

/**
 * Rename tools by name. Tools whose name is not in the map flow
 * through unchanged.
 *
 *   rename({ "internal_search": "search", "internal_get": "get" })
 *
 * `false` as a value drops the tool entirely (a sometimes-useful
 * shorthand vs. a separate `filter` call):
 *
 *   rename({ "deprecated_op": false })
 *
 * The map is a snapshot — created once, reused across many calls.
 */
export function rename<C = unknown>(
  map: Readonly<Record<string, string | false>>,
): ToolTransform<C> {
  return {
    name: "rename",
    apply: (tool) => {
      const replacement = map[tool.name];
      if (replacement === undefined) return tool;
      if (replacement === false) return null;
      return { ...tool, name: replacement };
    },
  };
}

/**
 * Prepend a string to every tool's name. Optional `unlessAlready`
 * skips tools whose name already starts with the prefix — useful when
 * a transform pipeline might apply the same prefix twice.
 */
export function prefix<C = unknown>(
  value: string,
  options: { readonly unlessAlready?: boolean } = {},
): ToolTransform<C> {
  return {
    name: `prefix(${value})`,
    apply: (tool) => {
      if (options.unlessAlready && tool.name.startsWith(value)) return tool;
      return { ...tool, name: `${value}${tool.name}` };
    },
  };
}

/**
 * Append a string to every tool's name. Same `unlessAlready` semantics
 * as {@link prefix}.
 */
export function suffix<C = unknown>(
  value: string,
  options: { readonly unlessAlready?: boolean } = {},
): ToolTransform<C> {
  return {
    name: `suffix(${value})`,
    apply: (tool) => {
      if (options.unlessAlready && tool.name.endsWith(value)) return tool;
      return { ...tool, name: `${tool.name}${value}` };
    },
  };
}

/**
 * Re-key tools by an arbitrary projection function. The function MUST
 * return a non-empty string. Returning the input name is a no-op.
 *
 * Less ergonomic than `rename` for static maps; useful when the new
 * name depends on the tool itself (e.g., `${tool.metadata?.namespace}_${tool.name}`).
 */
export function renameBy<C = unknown>(
  fn: (tool: ToolDeclaration, ctx: C) => string,
): ToolTransform<C> {
  return {
    name: "renameBy",
    apply: (tool, ctx) => {
      const next = fn(tool, ctx);
      if (next === tool.name) return tool;
      if (!next) {
        throw new Error(`renameBy: projection returned an empty name for tool "${tool.name}"`);
      }
      return { ...tool, name: next };
    },
  };
}
