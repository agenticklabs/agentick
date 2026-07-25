/**
 * Metadata transforms: merge / replace `metadata` on tools by name.
 *
 * `metadata` is the open-ended `Record<string, unknown>` slot on
 * `ToolDeclaration`. Display-metadata sugar (`setTitle`, `setIcons`)
 * lives in `./describe.ts` and writes to specific well-known keys.
 * This file ships the general primitive for arbitrary keys.
 */

import type { ToolTransform } from "./transform.js";

/**
 * Merge metadata into tools by name (shallow). Keys in the patch
 * overwrite the same keys on the tool; other tool metadata is
 * preserved. Tools whose name is not in the map flow through
 * unchanged.
 *
 *   setMetadata({
 *     "search": { audit: true, priority: "high" },
 *   })
 *
 * The merge is shallow: nested objects are replaced, not merged. For
 * deep merges, write a custom transform using `mergeLayered`.
 */
export function setMetadata<C = unknown>(
  map: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ToolTransform<C> {
  return {
    name: "setMetadata",
    apply: (tool) => {
      const patch = map[tool.name];
      if (patch === undefined) return tool;
      return {
        ...tool,
        metadata: { ...(tool.metadata ?? {}), ...patch },
      };
    },
  };
}

/**
 * Replace metadata wholesale for tools by name. Use when you need to
 * fully reset a tool's metadata under projection — uncommon, but
 * supported.
 *
 * Pass `null` to remove the metadata field entirely:
 *
 *   replaceMetadata({ "scrubbed_tool": null })
 */
export function replaceMetadata<C = unknown>(
  map: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>,
): ToolTransform<C> {
  return {
    name: "replaceMetadata",
    apply: (tool) => {
      const replacement = map[tool.name];
      if (replacement === undefined) return tool;
      if (replacement === null) {
        const { metadata: _drop, ...rest } = tool;
        return rest;
      }
      return { ...tool, metadata: replacement };
    },
  };
}
