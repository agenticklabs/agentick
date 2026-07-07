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
 * Executor identity for tool execution (who ran the tool).
 * Open string — recognized values: "agentick", "provider:openai",
 * "provider:anthropic", "provider:google", "mcp:<server>", etc.
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
