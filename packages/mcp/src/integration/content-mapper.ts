/**
 * Map MCP `CallToolResult.content` blocks to agentick `ContentBlock[]`.
 *
 * The MCP spec ships its own content union (text / image / audio /
 * resource / resourceLink). agentick's `ContentBlock` covers a similar
 * union but with v2-specific shape additions. This mapper handles the
 * overlap losslessly + falls through to a JSON-text representation for
 * shapes outside the agentick set (so nothing silently disappears).
 *
 * Used by the `withMCP` ToolBridge when proxying an MCP tool's
 * response back through the local `ToolExecutor`. Mirrors the inverse
 * direction's `toMCPResult` (in `protocol/errors.ts`) so adopters can
 * reason about the round-trip.
 */

import type { CallToolResult, ResourceContents } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock, ResourceContents as SpecResourceContents } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { mcpResultExtensions } from "../server/wire-extensions.js";

/**
 * A `CallToolResult` mapped into agentick's content model, preserving
 * the three sidecars the bare {@link mcpContentToBlocks} drops:
 *
 *   - `structuredContent` — the tool's typed JSON payload (MCP
 *     2025-11-25+). Distinct from the `content[]` display blocks.
 *   - `isError` — whether the tool signalled a domain-level error
 *     (as opposed to a protocol error, which throws).
 *   - `metadata` — the wire `_meta`, folded into the ONE namespaced
 *     result key (`metadata.mcp.meta`) that agentick's shared substrate
 *     carries MCP payloads under. This is the carriage an MCP-Apps `ui`
 *     descriptor rides, and it is the same key the SERVER-side
 *     projection reads — one convention, both directions.
 *
 * The shape is `ToolResultEnvelope`-compatible on purpose: a tool
 * handler proxying an MCP call returns it directly and the executor
 * carries every field onto the `DispatchResult`.
 *
 * Downstream consumers that only need the display blocks keep using
 * {@link mcpContentToBlocks}; consumers that must round-trip the full
 * result use this.
 */
export interface MappedCallToolResult {
  readonly content: readonly ContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Convert an MCP `CallToolResult.content` array to agentick
 * `ContentBlock[]`. Unknown variants serialize as text JSON so they
 * survive the boundary even though the model won't render them
 * structurally.
 *
 * Embedded `resource` blocks map to the agentick {@link ResourceBlock}
 * (ADR 62) — the content round-trips instead of being flattened to a
 * text JSON blob.
 */
export function mcpContentToBlocks(content: CallToolResult["content"]): readonly ContentBlock[] {
  return content.map(mapBlock);
}

/**
 * Map a full `CallToolResult` — content blocks PLUS the
 * `structuredContent` / `isError` / `_meta` sidecars that
 * {@link mcpContentToBlocks} alone drops. `undefined` sidecars are
 * omitted so the shape stays clean (and journals compactly) — a result
 * that carried none maps to a bare `{ content }`.
 */
export function mapCallToolResult(result: CallToolResult): MappedCallToolResult {
  return {
    content: mcpContentToBlocks(result.content),
    ...omitUndefined({
      structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      isError: result.isError,
      metadata:
        result._meta !== undefined
          ? mcpResultExtensions({ meta: result._meta as Readonly<Record<string, unknown>> })
          : undefined,
    }),
  };
}

/**
 * Map an MCP `resources/read` (or embedded) `ResourceContents` array to
 * the spec {@link SpecResourceContents} shape. The text/blob discriminant
 * and `mimeType` / `_meta` carry through unchanged.
 */
export function mapResourceContents(
  contents: readonly ResourceContents[],
): readonly SpecResourceContents[] {
  return contents.map(mapOneResourceContents);
}

function mapBlock(block: CallToolResult["content"][number]): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          data: block.data,
          mimeType: block.mimeType,
        },
        mimeType: block.mimeType,
      };
    case "audio":
      return {
        type: "audio",
        source: {
          type: "base64",
          data: block.data,
          mimeType: block.mimeType,
        },
        mimeType: block.mimeType,
      };
    case "resource":
      // MCP embedded resource — `.resource: { uri, mimeType?, text | blob }`.
      // Maps to the agentick `resource` content block (ADR 62) so the
      // content round-trips structurally instead of being flattened to
      // a text JSON blob.
      return {
        type: "resource",
        resource: mapOneResourceContents(block.resource),
      };
    case "resource_link":
      return {
        type: "text",
        text: JSON.stringify({ kind: "mcp.resource_link", link: block }),
      };
    default:
      // Forwards-compat — MCP may add new content variants. Fall
      // through as text JSON so callers see *something*.
      return { type: "text", text: JSON.stringify(block) };
  }
}

/**
 * Map one MCP `ResourceContents` (text or blob) to the spec shape,
 * preserving the discriminant + `mimeType` / `_meta`. Shared by the
 * embedded-`resource`-block path and `resources/read` mapping.
 */
function mapOneResourceContents(resource: ResourceContents): SpecResourceContents {
  // `ResourceContents` (base SDK type) carries only uri/mimeType/_meta;
  // the text/blob discriminant lives on the concrete variants. Read it
  // through a loose view so the structural check + narrowing is honest.
  const view = resource as {
    readonly uri: string;
    readonly mimeType?: string;
    readonly _meta?: Record<string, unknown>;
    readonly text?: unknown;
    readonly blob?: unknown;
  };
  const optional = omitUndefined({ mimeType: view.mimeType, _meta: view._meta });
  if (typeof view.text === "string") {
    return { uri: view.uri, ...optional, text: view.text };
  }
  if (typeof view.blob === "string") {
    return { uri: view.uri, ...optional, blob: view.blob };
  }
  // Neither text nor blob (malformed / forwards-compat) — surface an
  // empty text body so the discriminant stays valid rather than
  // producing an untyped shape.
  return { uri: view.uri, ...optional, text: "" };
}
