/**
 * Content block taxonomy — wire-format primitives shared by every harness.
 *
 * Promoted from v1's `@agentick/shared` (`blocks.ts` + `block-types.ts`).
 * Shape preserved; `any` bags tightened to `unknown`; enums collapsed to
 * string literal unions (zero runtime cost). Runtime helpers (Buffer ↔
 * base64, type guards) stay in `@agentick/shared`.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §Content blocks
 */

// ============================================================================
// Discriminators (string literal unions)
// ============================================================================

/**
 * Discriminator for the {@link ContentBlock} union.
 */
export type BlockType =
  | "text"
  | "reasoning"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "tool_use"
  | "tool_result"
  | "task_ref"
  | "resource"
  | "json"
  | "xml"
  | "csv"
  | "html"
  | "code"
  | "generated_image"
  | "generated_file"
  | "executable_code"
  | "code_execution_result"
  | "user_action"
  | "system_event"
  | "state_change"
  | "custom";

/**
 * Agentick semantic role on a {@link MessageEntry}. Open string; canonical
 * roles are mapped to provider role vocabulary by the executor harness.
 */
export type MessageRole = "user" | "assistant" | "system" | "tool" | "event" | (string & {});

/**
 * Discriminator for {@link MediaSource}.
 */
export type MediaSourceType = "url" | "base64" | "reference" | "s3" | "gcs";

// Common MIME hints — open strings, but typed for ergonomics.
export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | (string & {});
export type DocumentMimeType = "application/pdf" | "text/plain" | "text/markdown" | (string & {});
export type AudioMimeType = "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/mp4" | (string & {});
export type VideoMimeType = "video/mp4" | "video/webm" | (string & {});

export type CodeLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "csharp"
  | "go"
  | "rust"
  | "cpp"
  | "c"
  | "php"
  | "ruby"
  | "swift"
  | "kotlin"
  | "sql"
  | "shell"
  | "json"
  | "other"
  | (string & {});

// ============================================================================
// Base shape
// ============================================================================

/**
 * Base properties shared by all content blocks.
 */
export interface BaseContentBlock {
  readonly type: BlockType;
  readonly id?: string;
  readonly messageId?: string;
  /** ISO 8601 timestamp. */
  readonly createdAt?: string;
  readonly mimeType?: string;
  readonly index?: number;
  readonly metadata?: Record<string, unknown>;
  readonly summary?: string;
  /**
   * Provider-specific metadata that must round-trip through the
   * pipeline on this specific block. Keyed by provider namespace
   * (`google`, `anthropic`, `openai`).
   *
   * Two distinct uses:
   * 1. **Model-produced opaque data** that has to be sent back
   *    verbatim on subsequent turns — e.g. Gemini 3+
   *    `thoughtSignature` on a `tool_use` block.
   * 2. **Adopter-stamped per-block knobs** that affect how the
   *    block is rendered to the provider — e.g. Anthropic
   *    `cacheControl: { type: "ephemeral" }` to mark THIS block as
   *    a prompt-cache breakpoint.
   *
   * Keyed by provider namespace so multiple adapters can decorate
   * the same block without colliding.
   */
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  /**
   * Source citations annotating this block — the EDGES from spans of this block
   * to the {@link Source}s in {@link sources}. Cross-cutting provenance: any
   * content can be cited, not only text (a web-search answer span, a grounded
   * claim, a generated image's source, a document reference). Populated by
   * adapters from provider citation / grounding data (see {@link Citation}).
   * Absent when the block carries no citations. {@link Citation.range} (character
   * offsets) is meaningful only for text blocks; a citation on a non-text block
   * omits it and cites the block as a whole.
   */
  readonly citations?: readonly Citation[];
  /**
   * The {@link Source} entities this block's {@link citations} reference, carried
   * ON the block so a citation resolves WITHOUT its enclosing message — a block
   * lifted out of its turn (compaction, a rendered fragment) keeps its citations
   * resolvable. Deduped, each with a turn-stable {@link Source.id}. The message
   * aggregates every block's `sources` (plus orphans) into
   * {@link import("./streaming.js").AssistantMessage.sources}. Absent when the
   * block cites nothing.
   */
  readonly sources?: readonly Source[];
}

// ============================================================================
// Media sources
// ============================================================================

export interface UrlSource {
  readonly type: "url";
  readonly url: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Base64Source {
  readonly type: "base64";
  readonly data: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FileReferenceSource {
  readonly type: "reference";
  readonly fileId: string;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly size?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface S3Source {
  readonly type: "s3";
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GCSSource {
  readonly type: "gcs";
  readonly bucket: string;
  readonly object: string;
  readonly project?: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export type MediaSource = UrlSource | Base64Source | FileReferenceSource | S3Source | GCSSource;

// ============================================================================
// Citations
// ============================================================================

/**
 * A source the model consulted — a web page or a request document — as an
 * ENTITY with a stable {@link id} that {@link Citation}s reference. The
 * normalized form of the three providers' source shapes (OpenAI `url_citation` /
 * `file_citation`, Anthropic `web_search_result_location` /
 * `char`|`page`|`content_block_location`, Google `groundingChunks[].web`)
 * without inventing a taxonomy above what they emit: a flat bag where `url`
 * present ⇒ a WEB source and `documentIndex` present ⇒ a DOCUMENT / file source
 * (a client branches on presence).
 *
 * Sources are modeled as entities (not embedded per citation) so a numbered
 * "Sources" footer has stable identity, a source cited by many spans is stored
 * once, and a source the model consulted but cited in NO span (an orphan) still
 * has a home on {@link import("./streaming.js").AssistantMessage.sources}. See
 * {@link BaseContentBlock.sources} (the per-block set citations resolve against)
 * and `AssistantMessage.sources` (the turn's full consulted set).
 */
export interface Source {
  /**
   * Identifier STABLE WITHIN THE TURN — the same consulted source carries the
   * same `id` across every {@link BaseContentBlock.sources} that holds it and on
   * the message-level aggregate, so {@link Citation.sourceId} references and the
   * dedupe roll-up line up. Turn-scoped, not global.
   */
  readonly id: string;
  /** The cited web resource. Present ⇒ a web/grounding source. */
  readonly url?: string;
  /** Human-legible source title, when the provider supplies one. */
  readonly title?: string;
  /**
   * Index of the cited document among the request's documents. Present ⇒ a
   * document/file source (Anthropic document citations, OpenAI `file_citation`).
   * Mutually informative with {@link url}, not exclusive — a provider may supply
   * both.
   */
  readonly documentIndex?: number;
}

/**
 * A normalized reference from a span of the assistant's text to a {@link Source}
 * that supports it — the EDGE in the source/citation model (sources are the
 * entities, citations the edges). Adapters map each provider's citation format
 * onto this shape and attach the results to the block the citations annotate
 * (via {@link BaseContentBlock.citations}); the referenced sources ride the same
 * block's {@link BaseContentBlock.sources}, so a citation resolves without its
 * message context.
 *
 * `[V1-REFINED]` of v1's flat `ContentCitation { text, url?, title?, startIndex?,
 * endIndex? }`: v1's `text` conflated the source snippet with the annotated span,
 * and every citation embedded its own source (no shared identity). Here the two
 * are distinct — {@link range} is the span in the ASSISTANT's text, {@link
 * citedText} is the snippet of the SOURCE — and the source is factored out into a
 * referenced {@link Source} entity.
 */
export interface Citation {
  /**
   * The {@link Source.id} this citation references. Resolves against the same
   * block's {@link BaseContentBlock.sources} (falling back to the message-level
   * aggregate) — both carry the source under this id.
   */
  readonly sourceId: string;
  /**
   * The snippet of the SOURCE that supports the claim (Anthropic `cited_text`,
   * Google `groundingSupports[].segment.text`), when the provider returns it.
   */
  readonly citedText?: string;
  /**
   * Character range in a TEXT block's `text` that the citation annotates
   * (OpenAI annotation `start_index`/`end_index`, Anthropic char indices, Google
   * `segment` start/end). Meaningful only for text blocks; omitted when the
   * citation hangs on a non-text block or cites a block as a whole.
   */
  readonly range?: { readonly start: number; readonly end: number };
  /**
   * Provider-supplied confidence in `[0, 1]` that the span is supported by the
   * source (Google `groundingSupports[].confidenceScores`), when given.
   */
  readonly confidence?: number;
}

// ============================================================================
// Textual blocks
// ============================================================================

export interface TextBlock extends BaseContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningBlock extends BaseContentBlock {
  readonly type: "reasoning";
  readonly text: string;
  /** Provider-supplied opaque signature for redacted reasoning. */
  readonly signature?: string;
  readonly isRedacted?: boolean;
}

export interface JsonBlock extends BaseContentBlock {
  readonly type: "json";
  readonly text?: string;
  readonly data?: unknown;
}

export interface XmlBlock extends BaseContentBlock {
  readonly type: "xml";
  readonly text: string;
}

export interface CsvBlock extends BaseContentBlock {
  readonly type: "csv";
  readonly text: string;
  readonly headers?: readonly string[];
}

export interface HtmlBlock extends BaseContentBlock {
  readonly type: "html";
  readonly text: string;
}

export interface CodeBlock extends BaseContentBlock {
  readonly type: "code";
  readonly text: string;
  readonly language: CodeLanguage;
}

// ============================================================================
// Media blocks
// ============================================================================

export interface ImageBlock extends BaseContentBlock {
  readonly type: "image";
  readonly source: MediaSource;
  readonly mimeType?: ImageMimeType;
  readonly altText?: string;
}

export interface DocumentBlock extends BaseContentBlock {
  readonly type: "document";
  readonly source: MediaSource;
  readonly mimeType?: DocumentMimeType;
  readonly title?: string;
}

export interface AudioBlock extends BaseContentBlock {
  readonly type: "audio";
  readonly source: MediaSource;
  readonly mimeType?: AudioMimeType;
  readonly transcript?: string;
}

export interface VideoBlock extends BaseContentBlock {
  readonly type: "video";
  readonly source: MediaSource;
  readonly mimeType?: VideoMimeType;
  readonly transcript?: string;
}

// ============================================================================
// Tool blocks
// ============================================================================

/**
 * Executor identity stamped on a {@link ToolResultBlock} — WHO ran the tool.
 * One provenance axis for all four execution sources the client switches on:
 *
 *   - `"agentick"`            — SERVER-handled: the framework's tool executor
 *                               dispatched a local handler (`handlerRef`).
 *   - `"client"`             — CLIENT-handled (declaration carries no
 *                               `handlerRef`; the executor relayed the call
 *                               to the client, stage 1).
 *   - `"provider:openai"` |
 *     `"provider:anthropic"` |
 *     `"provider:google"`     — PROVIDER-executed: the provider ran the tool
 *                               INSIDE the model call (OpenAI `web_search` /
 *                               `code_interpreter`, Anthropic
 *                               `server_tool_use`, Google grounding). The
 *                               result rides THIS field on the `tool_result`
 *                               block folded into the timeline the client
 *                               reads — NOT a separate event, NOT the tool-
 *                               executor dispatch stream (provider tools emit
 *                               no `tool:dispatch` lifecycle; see
 *                               {@link import("./declarations.js").ProviderToolDeclaration}).
 *   - `"mcp:<server>"`        — dispatched through the MCP harness to the
 *                               named server.
 *
 * Open string — the set above is the recognized vocabulary, not a closed
 * union; adapters populate the `provider:*` stamps in the adapter pass.
 */
export type ToolExecutor = string;

export interface ToolUseBlock extends BaseContentBlock {
  readonly type: "tool_use";
  readonly toolUseId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly toolResult?: ToolResultBlock;
}

export interface ToolResultBlock extends BaseContentBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly name: string;
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
  readonly executedBy?: ToolExecutor;
}

/**
 * Structured reference to a {@link TasksHarnessProtocol} task,
 * emitted by the tool executor when a tool resolves to a task handle
 * rather than a terminal value (Pattern B — the model receives the
 * ref immediately and follows up via `session_tasks_get` /
 * `session_tasks_await` / `session_tasks_cancel`).
 *
 * **Why a first-class block type and not text-with-JSON?**
 * The framework's primitives table treats tasks as a foundational
 * concept; their wire representation deserves a typed slot. Adopters
 * inspect blocks via the `type` discriminator (devtools UI rendering,
 * substrate journaling, gateway projection, MCP outbound translation)
 * — text-with-JSON forces every consumer to `JSON.parse` and sniff
 * for a magic `_kind` field. The block-type discriminator collapses
 * that to a normal switch.
 *
 * Adapter projections fall back to a text block carrying the
 * historical JSON payload (`{ _kind: "session_task_ref", taskId,
 * status, … }`) so models continue to see drop-in-compatible content
 * until providers learn task-aware projections.
 *
 * @see canonical-projection.ts (`messagePartFromBlock`) for the
 *      drop-in text fallback.
 */
export interface TaskRefBlock extends BaseContentBlock {
  readonly type: "task_ref";
  readonly taskId: string;
  /**
   * Lifecycle status of the referenced task at the moment the block
   * was emitted. Mirrors `TaskInfo.status` (working / completed /
   * failed / cancelled / input_required). The model uses this to
   * decide whether to await, get, or cancel.
   */
  readonly status: string;
  /** Human-readable status hint, mirrors `TaskInfo.statusMessage`. */
  readonly statusMessage?: string;
  /** Server-declared TTL (ms) before the task expires. `null` = none. */
  readonly ttl?: number;
  /** Suggested minimum gap (ms) between `tasks/get` polls. */
  readonly pollInterval?: number;
}

// ============================================================================
// Resource block (MCP embedded resources + resource reads — ADR 62)
// ============================================================================

/**
 * Contents of a single resource read — the text/blob union MCP uses
 * for `resources/read` results and embedded `resource` content blocks.
 * Mirrors the MCP `ResourceContents` wire shape (`TextResourceContents`
 * / `BlobResourceContents`) so a read round-trips without loss.
 *
 * `blob` is base64-encoded binary; `text` is UTF-8. Exactly one is
 * present — the discriminant is structural (`"text" in c` /
 * `"blob" in c`), matching the wire.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md §Resource content block
 */
export interface TextResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
  readonly _meta?: Record<string, unknown>;
}

export interface BlobResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  /** Base64-encoded binary payload. */
  readonly blob: string;
  readonly _meta?: Record<string, unknown>;
}

export type ResourceContents = TextResourceContents | BlobResourceContents;

/**
 * Embedded resource content block. Carries a resolved {@link ResourceContents}
 * inline so an MCP tool/prompt result's embedded resource — and a
 * `ResourcesHarness` read (ADR 62) — round-trips through agentick's
 * content model instead of being flattened to a `text` JSON blob.
 *
 * Distinct from a `resource_link` (a URI reference the consumer would
 * fetch): a `resource` block carries the CONTENT, not just a pointer.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */
export interface ResourceBlock extends BaseContentBlock {
  readonly type: "resource";
  readonly resource: ResourceContents;
}

// ============================================================================
// AI-generated blocks
// ============================================================================

export interface GeneratedImageBlock extends BaseContentBlock {
  readonly type: "generated_image";
  /** Base64-encoded image payload. */
  readonly data: string;
  readonly mimeType: string;
  readonly altText?: string;
}

export interface GeneratedFileBlock extends BaseContentBlock {
  readonly type: "generated_file";
  readonly uri: string;
  readonly mimeType: string;
  readonly displayName?: string;
}

export interface ExecutableCodeBlock extends BaseContentBlock {
  readonly type: "executable_code";
  readonly code: string;
  readonly language?: CodeLanguage;
}

export interface CodeExecutionResultBlock extends BaseContentBlock {
  readonly type: "code_execution_result";
  readonly output: string;
  readonly isError?: boolean;
}

// ============================================================================
// Event blocks (valid only on event-role messages)
// ============================================================================

export interface UserActionBlock extends BaseContentBlock {
  readonly type: "user_action";
  readonly action: string;
  readonly actor?: string;
  readonly target?: string;
  readonly details?: Record<string, unknown>;
  readonly text?: string;
}

export interface SystemEventBlock extends BaseContentBlock {
  readonly type: "system_event";
  readonly event: string;
  readonly source?: string;
  readonly data?: Record<string, unknown>;
  readonly text?: string;
}

export interface StateChangeBlock extends BaseContentBlock {
  readonly type: "state_change";
  readonly entity: string;
  readonly field?: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly trigger?: string;
  readonly text?: string;
}

// ============================================================================
// Custom block (parser-emitted application-defined tags)
// ============================================================================

export interface CustomContentBlock extends BaseContentBlock {
  readonly type: "custom";
  readonly tag: string;
  readonly content: string;
  readonly attrs: Record<string, string>;
  readonly selfClosing?: boolean;
}

// ============================================================================
// Unions
// ============================================================================

/**
 * Union of all wire-format content blocks. Use the `type` discriminator for
 * narrowing. Type guards live in `@agentick/shared`.
 */
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | DocumentBlock
  | AudioBlock
  | VideoBlock
  | ToolUseBlock
  | ToolResultBlock
  | TaskRefBlock
  | ResourceBlock
  | JsonBlock
  | XmlBlock
  | CsvBlock
  | HtmlBlock
  | CodeBlock
  | GeneratedImageBlock
  | GeneratedFileBlock
  | ExecutableCodeBlock
  | CodeExecutionResultBlock
  | UserActionBlock
  | SystemEventBlock
  | StateChangeBlock
  | CustomContentBlock;

export type MediaBlock = ImageBlock | DocumentBlock | AudioBlock | VideoBlock;
export type ToolBlock = ToolUseBlock | ToolResultBlock;
export type DataBlock = JsonBlock | XmlBlock | CsvBlock | HtmlBlock | CodeBlock;
export type EventBlock = UserActionBlock | SystemEventBlock | StateChangeBlock;

// ============================================================================
// Role-scoped allow lists (preserved from v1)
// ============================================================================

export type SystemAllowedBlock = TextBlock;

export type UserAllowedBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | AudioBlock
  | VideoBlock
  | JsonBlock
  | XmlBlock
  | CsvBlock
  | HtmlBlock
  | CodeBlock;

export type ToolAllowedBlock = ToolResultBlock;

export type AssistantAllowedBlock =
  | TextBlock
  | ToolUseBlock
  | ReasoningBlock
  | GeneratedImageBlock
  | GeneratedFileBlock
  | ExecutableCodeBlock
  | CodeExecutionResultBlock
  | CustomContentBlock;

export type EventAllowedBlock = TextBlock | UserActionBlock | SystemEventBlock | StateChangeBlock;

// ============================================================================
// Exhaustive fold — the safety net for the discriminated union
// ============================================================================
//
// `ContentBlock` is dispatched by ~30 hand-rolled `switch (block.type)` sites
// across adapters, formatters, projections, etc. Most carry a swallowing
// `default:`, so adding a member to `BlockType` compiles fine everywhere and
// is SILENTLY DROPPED at every site that didn't explicitly handle it — a
// silent-correctness bug the type system cannot catch (a `default:` defeats
// exhaustiveness). These folds centralize that risk.
//
// **House rule — no silent drop.** Content-block dispatch must never silently
// drop a block. Either be exhaustive ({@link foldContentBlock}), or degrade
// EXPLICITLY — a text-ifying `default:` / {@link foldContentBlockWith} fallback
// is fine and often correct (the model-input normalizer `messagePartFromBlock`
// does exactly this: an unhandled block becomes text, never vanishes). The
// exhaustive fold is a TOOL for the rare site that wants compile-time totality
// (a wire codec with no sane text degrade), NOT a blanket mandate — 23 handlers
// per call site is too heavy where a text degrade is the right answer.

/**
 * Handler map for {@link foldContentBlock} — exactly one handler PER
 * {@link BlockType}. Every key is required, so adding a member to `BlockType`
 * breaks every exhaustive fold at compile time (missing key).
 */
export type ContentBlockFold<R> = {
  [K in BlockType]: (block: Extract<ContentBlock, { readonly type: K }>) => R;
};

/**
 * Exhaustively fold a {@link ContentBlock} — the safety net. A `BlockType`
 * addition forces every call site to add its handler (a guided compile sweep)
 * instead of silently dropping the new block. Use for content-preserving
 * conversions (model input, wire).
 */
export function foldContentBlock<R>(block: ContentBlock, fold: ContentBlockFold<R>): R {
  // The fold has a handler for every discriminant; dispatch is total.
  return (fold[block.type] as (b: ContentBlock) => R)(block);
}

/**
 * Partial fold with an EXPLICIT `fallback` — for narrow sites that handle only
 * a few block types. Unlike {@link foldContentBlock}, a new `BlockType` does
 * NOT break this (the fallback catches it), so `fallback` is a deliberate,
 * greppable "ignore the rest" — not a silent `default:`. Prefer the exhaustive
 * form wherever a dropped block loses content.
 */
export function foldContentBlockWith<R>(
  block: ContentBlock,
  handlers: Partial<ContentBlockFold<R>>,
  fallback: (block: ContentBlock) => R,
): R {
  const handler = handlers[block.type] as ((b: ContentBlock) => R) | undefined;
  return handler ? handler(block) : fallback(block);
}

// ============================================================================
// Content currency — the string ⇄ ContentBlock[] normalizer
// ============================================================================

/**
 * Normalize the message-input content currency `string | ContentBlock[]`
 * to `ContentBlock[]`. A bare string becomes exactly one {@link TextBlock};
 * an array passes through unchanged (identity — same reference).
 *
 * This is the CANONICAL string→text-block normalizer. The tool-result
 * currency ({@link import("./tool-result.js").normalizeToolResult}) and any
 * surface that accepts `string | ContentBlock[]` reuse it — do NOT hand-roll
 * a second. Pure, allocation-free on the array path.
 */
export function toContentBlocks(input: string | readonly ContentBlock[]): readonly ContentBlock[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}
