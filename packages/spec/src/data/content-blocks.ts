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
export type DocumentMimeType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | (string & {});
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
  /**
   * Provider-specific metadata that must round-trip through the pipeline.
   * Keyed by provider namespace (e.g., `google`, `anthropic`, `openai`).
   */
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
}

export interface ToolResultBlock extends BaseContentBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly name: string;
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
  readonly executedBy?: ToolExecutor;
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

export type EventAllowedBlock =
  | TextBlock
  | UserActionBlock
  | SystemEventBlock
  | StateChangeBlock;
