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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock } from "@agentick/spec-next";

/**
 * Convert an MCP `CallToolResult.content` array to agentick
 * `ContentBlock[]`. Unknown variants serialize as text JSON so they
 * survive the boundary even though the model won't render them
 * structurally.
 */
export function mcpContentToBlocks(content: CallToolResult["content"]): readonly ContentBlock[] {
  return content.map(mapBlock);
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
      // MCP embedded resource — has `.resource: { uri, mimeType?, text? | blob? }`.
      // We collapse to a text block carrying the URI + best-effort
      // text/blob notation. Future: a dedicated `<resource>` block on
      // the agentick side when the resource harness lands.
      return {
        type: "text",
        text: JSON.stringify({ kind: "mcp.resource", resource: block.resource }),
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
