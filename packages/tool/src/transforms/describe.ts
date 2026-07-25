/**
 * Description + display-metadata transforms.
 *
 * Description is a first-class field on `ToolDeclaration`. Title and
 * icons are MCP-wire-level display metadata — v2 spec doesn't carry
 * them on `ToolDeclaration` directly; they live under
 * `metadata.title` / `metadata.icons` by convention. The MCP server
 * projection reads them from that location when building the wire
 * `Tool` record.
 *
 * Adopters can wire other display metadata through the same convention
 * (`metadata.color`, `metadata.shortcut`, ...) — the projection passes
 * unknown metadata through unchanged, modulo redaction.
 */

import type { ToolTransform } from "./transform.js";

/**
 * Override descriptions by tool name. Tools whose name is not in the
 * map flow through unchanged. Use to localize, simplify, or tighten
 * descriptions for a specific audience without touching the original
 * declaration.
 *
 *   describe({ "search": "Find documents matching a query." })
 */
export function describe<C = unknown>(map: Readonly<Record<string, string>>): ToolTransform<C> {
  return {
    name: "describe",
    apply: (tool) => {
      const replacement = map[tool.name];
      if (replacement === undefined) return tool;
      return { ...tool, description: replacement };
    },
  };
}

/**
 * Set the MCP-wire `title` for tools by name. Stored under
 * `metadata.title` — the projection reads it when building the wire
 * `Tool` record. Unaffected tools flow through unchanged.
 *
 *   setTitle({ "internal_search": "Search Knowledge Base" })
 */
export function setTitle<C = unknown>(map: Readonly<Record<string, string>>): ToolTransform<C> {
  return {
    name: "setTitle",
    apply: (tool) => {
      const title = map[tool.name];
      if (title === undefined) return tool;
      return {
        ...tool,
        metadata: { ...(tool.metadata ?? {}), title },
      };
    },
  };
}

/**
 * Icon descriptor matching MCP spec (`Tool.icons[i]`).
 *
 *   {
 *     src: "https://example.com/icon.png" | "data:image/svg+xml;base64,...",
 *     sizes?: "16x16 32x32",          // space-separated WxH list per W3C
 *     mimeType?: "image/png",
 *     theme?: "light" | "dark"        // adopter convention; not in MCP core
 *   }
 */
export interface IconDescriptor {
  readonly src: string;
  readonly sizes?: string;
  readonly mimeType?: string;
  readonly theme?: "light" | "dark";
  readonly [key: string]: unknown;
}

/**
 * Set MCP-wire icons for tools by name. Stored under `metadata.icons`
 * as an array of icon descriptors. Clients select the best-fit icon by
 * size/theme/mime.
 *
 *   setIcons({
 *     "search": [
 *       { src: "/icons/search.svg", sizes: "any", mimeType: "image/svg+xml" },
 *       { src: "/icons/search-64.png", sizes: "64x64", mimeType: "image/png" },
 *     ],
 *   })
 */
export function setIcons<C = unknown>(
  map: Readonly<Record<string, readonly IconDescriptor[]>>,
): ToolTransform<C> {
  return {
    name: "setIcons",
    apply: (tool) => {
      const icons = map[tool.name];
      if (icons === undefined) return tool;
      return {
        ...tool,
        metadata: { ...(tool.metadata ?? {}), icons },
      };
    },
  };
}
