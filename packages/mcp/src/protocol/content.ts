/**
 * Outbound content mapping — agentick `ContentBlock[]` → the MCP wire
 * content union.
 *
 * The mirror of `integration/content-mapper.ts` (inbound: an MCP
 * `CallToolResult` folded into agentick blocks). MCP's content union has
 * FIVE members — `text`, `image`, `audio`, `resource_link`, embedded
 * `resource` — while agentick's {@link ContentBlock} has 23. Everything
 * a projection emits crosses that narrowing, so the narrowing is written
 * once, here, and both server projections use it (`tools/call` results
 * and `prompts/get` messages carry the SAME wire union).
 *
 * ## Lossy, but honest
 *
 * Three rules, in order:
 *
 *  1. **Native kinds pass through byte-stable.** `text`, base64 `image` /
 *     `audio`, and `resource` map to their wire twins field-for-field.
 *     A server emitting only MCP-native content produces exactly the
 *     frames it produced before this mapper existed.
 *  2. **A URL-sourced medium becomes a `resource_link`.** MCP's `image` /
 *     `audio` carry base64 payloads only, so a block pointing at a URL is
 *     projected as the link it is rather than being inlined (the
 *     framework will not fetch on a client's behalf) or dropped.
 *  3. **Everything else becomes a `text` block carrying a FENCED payload
 *     whose info string names the projected kind** — `json`, `csv`,
 *     `document`, `tool_use`, … A consumer sees both the content and the
 *     fact that a narrowing happened; nothing disappears silently, and a
 *     model reads a fenced blob without special handling.
 *
 * The fold is {@link foldContentBlock}, so adding a `BlockType` to the
 * spec breaks THIS FILE at compile time instead of silently falling into
 * a default branch.
 *
 * @see integration/content-mapper.ts — the inbound direction.
 */

import type { ContentBlock as McpWireContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type {
  AudioBlock,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  MediaSource,
  VideoBlock,
} from "@agentick/spec";
import { foldContentBlock } from "@agentick/spec";

/** MIME type stamped on a medium that declares none. MCP requires the field. */
const UNKNOWN_MIME = "application/octet-stream";

/**
 * Map agentick content blocks onto the MCP wire union. Used by the
 * `tools/call` result projection and the `prompts/get` message
 * projection — the two places agentick content reaches an MCP client.
 *
 * @verifiedBy packages/mcp/src/protocol/__tests__/content.spec.ts
 */
export function toWireContent(blocks: readonly ContentBlock[]): McpWireContentBlock[] {
  return blocks.map(toWireContentBlock);
}

/**
 * Map ONE agentick content block onto the MCP wire union. See the module
 * doc-block for the three rules; the per-kind decisions are inline below.
 */
export function toWireContentBlock(block: ContentBlock): McpWireContentBlock {
  return foldContentBlock<McpWireContentBlock>(block, {
    // ─── Native: byte-stable ───
    text: (b) => wireText(b.text),
    resource: (b) => ({ type: "resource", resource: b.resource }),
    image: (b) => media(b, "image"),
    audio: (b) => media(b, "audio"),

    // ─── Media with no MCP twin: link when addressable, else fenced ───
    document: (b) => media(b, "document"),
    video: (b) => media(b, "video"),
    // A generated image already IS base64 + mimeType — the native shape.
    generated_image: (b) => ({ type: "image", data: b.data, mimeType: b.mimeType }),
    // A generated file is addressable by uri, which is exactly a link.
    generated_file: (b) => ({
      type: "resource_link",
      uri: b.uri,
      name: b.displayName ?? uriName(b.uri),
      mimeType: b.mimeType,
    }),

    // ─── Text-bearing: fenced, info string = the kind (or its language) ───
    reasoning: (b) => fenced("reasoning", b.text),
    json: (b) => fenced("json", b.text ?? JSON.stringify(b.data ?? null)),
    xml: (b) => fenced("xml", b.text),
    csv: (b) => fenced("csv", b.text),
    html: (b) => fenced("html", b.text),
    code: (b) => fenced(b.language, b.text),
    executable_code: (b) => fenced(b.language ?? "executable_code", b.code),
    code_execution_result: (b) => fenced("code_execution_result", b.output),

    // ─── Structured: fenced JSON of the block's own payload fields ───
    tool_use: (b) =>
      projected("tool_use", { toolUseId: b.toolUseId, name: b.name, input: b.input }),
    tool_result: (b) =>
      projected("tool_result", {
        toolUseId: b.toolUseId,
        name: b.name,
        // Recurse: the nested blocks narrow by the same rules, so a text
        // result reads as text rather than as an opaque object graph.
        content: toWireContent(b.content),
        ...(b.isError !== undefined ? { isError: b.isError } : {}),
      }),
    task_ref: (b) =>
      projected("task_ref", { taskId: b.taskId, status: b.status, statusMessage: b.statusMessage }),
    user_action: (b) =>
      projected("user_action", {
        action: b.action,
        actor: b.actor,
        target: b.target,
        ...b.details,
      }),
    system_event: (b) => projected("system_event", { event: b.event, source: b.source, ...b.data }),
    state_change: (b) =>
      projected("state_change", { entity: b.entity, field: b.field, from: b.from, to: b.to }),
    custom: (b) => projected(b.tag, { tag: b.tag, attrs: b.attrs, content: b.content }),
  });
}

// ============================================================================
// Wire constructors
// ============================================================================

function wireText(text: string): McpWireContentBlock {
  return { type: "text", text };
}

/**
 * A fenced text block. The info string names WHAT was projected, so a
 * consumer reading the frame can tell a `csv` narrowing from an `xml`
 * one — the distinction the five-member wire union cannot carry.
 */
function fenced(info: string, body: string): McpWireContentBlock {
  return wireText(`\`\`\`${info}\n${body}\n\`\`\``);
}

/** A fenced JSON payload — the fallback for blocks with no textual body. */
function projected(kind: string, payload: Readonly<Record<string, unknown>>): McpWireContentBlock {
  return fenced(kind, JSON.stringify(payload));
}

/**
 * Project a medium (image / audio / document / video) by its SOURCE:
 *
 *   - `base64` → the native `image` / `audio` frame when MCP has one for
 *     this kind; otherwise fenced JSON (MCP models no document/video).
 *   - `url`    → `resource_link` (rule 2 — the link is the honest
 *     projection of an addressable payload).
 *   - `reference` → fenced JSON. A `fileId` is in the ADOPTER's
 *     namespace, so no wire frame can resolve it; emitting the id
 *     verbatim tells the truth rather than inventing a uri.
 */
function media(
  block: ImageBlock | AudioBlock | DocumentBlock | VideoBlock,
  kind: "image" | "audio" | "document" | "video",
): McpWireContentBlock {
  const source: MediaSource = block.source;
  const mimeType = block.mimeType ?? source.mimeType ?? UNKNOWN_MIME;
  if (source.type === "url") {
    return {
      type: "resource_link",
      uri: source.url,
      name: mediaName(block) ?? uriName(source.url),
      mimeType,
    };
  }
  if (source.type === "base64") {
    if (kind === "image") return { type: "image", data: source.data, mimeType };
    if (kind === "audio") return { type: "audio", data: source.data, mimeType };
    return projected(kind, { mimeType, data: source.data });
  }
  return projected(kind, {
    mimeType,
    fileId: source.fileId,
    fileName: source.fileName,
    size: source.size,
  });
}

/** The medium's own display label, when its block type carries one. */
function mediaName(
  block: ImageBlock | AudioBlock | DocumentBlock | VideoBlock,
): string | undefined {
  if (block.type === "image") return block.altText;
  if (block.type === "document") return block.title;
  return undefined;
}

/**
 * Last path segment of a uri — the name a `resource_link` needs when the
 * block carried no label. Falls back to the whole uri (MCP requires a
 * non-empty `name`, and a uri is a truthful one).
 */
function uriName(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  const segment = withoutQuery.split("/").filter(Boolean).pop();
  return segment !== undefined && segment.length > 0 ? segment : uri;
}
