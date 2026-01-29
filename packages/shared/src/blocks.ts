/**
 * Content Blocks - Type-safe content block definitions using discriminated unions.
 *
 * Content blocks represent the atomic units of content in messages. They use
 * discriminated unions (the `type` field) for type-safe handling:
 *
 * - **Text** - Plain text content (`TextBlock`)
 * - **Media** - Images, audio, video, documents (`ImageBlock`, `AudioBlock`, etc.)
 * - **Tool** - Tool calls and results (`ToolUseBlock`, `ToolResultBlock`)
 * - **Data** - Structured data (JSON, XML, CSV, HTML, code)
 * - **Events** - User actions, system events, state changes
 *
 * @example Type narrowing with discriminated unions
 * ```typescript
 * function processBlock(block: ContentBlock) {
 *   switch (block.type) {
 *     case 'text':
 *       console.log(block.text); // TypeScript knows this is TextBlock
 *       break;
 *     case 'tool_use':
 *       console.log(block.name, block.input); // ToolUseBlock
 *       break;
 *     case 'image':
 *       console.log(block.source); // ImageBlock
 *       break;
 *   }
 * }
 * ```
 *
 * @see {@link ContentBlock} - The union of all content block types
 * @see {@link BlockType} - Enum of block type discriminators
 *
 * @module
 */

import {
  BlockType,
  MediaSourceType,
  ImageMimeType,
  DocumentMimeType,
  AudioMimeType,
  VideoMimeType,
  CodeLanguage,
} from "./block-types";
import type { ToolExecutor } from "./tools";

/**
 * Base properties shared by all content blocks.
 */
export interface BaseContentBlock {
  /** Discriminator for type narrowing (e.g., 'text', 'image', 'tool_use') */
  readonly type: string | BlockType;
  /** Unique identifier for this block */
  readonly id?: string;
  /** ID of the message containing this block */
  readonly messageId?: string;
  /** ISO 8601 timestamp when this block was created */
  readonly createdAt?: string;
  /** MIME type of the content (for media blocks) */
  readonly mimeType?: string;
  /** Position of this block within the message */
  readonly index?: number;
  /** Additional metadata */
  readonly metadata?: Record<string, any>;
  /** Human-readable summary of the content */
  readonly summary?: string;
}

// ============================================================================
// Media Sources
// ============================================================================

export interface BaseMediaSource extends BaseContentBlock {
  readonly type: string;
  readonly metadata?: Record<string, any>;
}

export interface UrlSource extends BaseMediaSource {
  readonly type: MediaSourceType.URL | "url";
  readonly url: string;
  readonly mimeType?: string;
}

export interface Base64Source extends BaseMediaSource {
  readonly type: MediaSourceType.BASE64 | "base64";
  readonly data: string;
  readonly mimeType?: string;
}

export interface Base64Source extends BaseMediaSource {
  readonly type: MediaSourceType.BASE64 | "base64";
  readonly data: string;
}

export interface FileIdSource extends BaseMediaSource {
  readonly type: MediaSourceType.FILE_ID | "file_id";
  readonly fileId: string;
}

export interface S3Source extends BaseMediaSource {
  readonly type: MediaSourceType.S3 | "s3";
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
}

export interface GCSSource extends BaseMediaSource {
  readonly type: MediaSourceType.GCS | "gcs";
  readonly bucket: string;
  readonly object: string;
  readonly project?: string;
}

export type MediaSource = UrlSource | Base64Source | FileIdSource | S3Source | GCSSource;

// ============================================================================
// Content Blocks
// ============================================================================

/**
 * Text block - Simple text content
 */
interface TextualDataBlock extends BaseContentBlock {
  readonly text: string;
}

export interface TextBlock extends TextualDataBlock {
  readonly type: BlockType.TEXT | "text";
  readonly text: string;
}

/**
 * Image block - Image content with source
 */
export interface ImageBlock extends BaseContentBlock {
  readonly type: BlockType.IMAGE | "image";
  readonly source: MediaSource;
  readonly mimeType?: ImageMimeType;
  readonly altText?: string;
}

/**
 * Document block - Document content (PDF, etc.)
 */
export interface DocumentBlock extends BaseContentBlock {
  readonly type: BlockType.DOCUMENT | "document";
  readonly source: MediaSource;
  readonly mimeType?: DocumentMimeType;
  readonly title?: string;
}

/**
 * Audio block - Audio content
 */
export interface AudioBlock extends BaseContentBlock {
  readonly type: BlockType.AUDIO | "audio";
  readonly source: MediaSource;
  readonly mimeType?: AudioMimeType;
  readonly transcript?: string;
}

/**
 * Video block - Video content
 */
export interface VideoBlock extends BaseContentBlock {
  readonly type: BlockType.VIDEO | "video";
  readonly source: MediaSource;
  readonly mimeType?: VideoMimeType;
  readonly transcript?: string;
}

/**
 * Tool use block - Function/tool call request
 */
export interface ToolUseBlock extends BaseContentBlock {
  readonly type: BlockType.TOOL_USE | "tool_use";
  readonly toolUseId: string;
  readonly name: string;
  readonly input: Record<string, any>;
  readonly toolResult?: ToolResultBlock;
}

/**
 * Tool result block - Function/tool call result
 */
export interface ToolResultBlock extends BaseContentBlock {
  readonly type: BlockType.TOOL_RESULT | "tool_result";
  readonly toolUseId: string;
  readonly name: string;
  readonly content: ContentBlock[];
  readonly isError?: boolean;
  /**
   * Who executed this tool.
   * @see ToolExecutor for possible values
   */
  readonly executedBy?: ToolExecutor;
}

/**
 * Reasoning block - Model's internal reasoning
 */
export interface ReasoningBlock extends TextualDataBlock {
  readonly type: BlockType.REASONING | "reasoning";
  readonly signature?: string; // For redacted reasoning
  readonly isRedacted?: boolean;
}

/**
 * JSON block - Structured JSON data
 */
export interface JsonBlock extends TextualDataBlock {
  readonly type: BlockType.JSON | "json";
  readonly data?: any;
}

/**
 * XML block - XML data
 */
export interface XmlBlock extends TextualDataBlock {
  readonly type: BlockType.XML | "xml";
}

/**
 * CSV block - CSV data
 */
export interface CsvBlock extends TextualDataBlock {
  readonly type: BlockType.CSV | "csv";
  readonly headers?: string[];
}

/**
 * HTML block - HTML content
 */
export interface HtmlBlock extends TextualDataBlock {
  readonly type: BlockType.HTML | "html";
}

/**
 * Code block - Code with language
 */
export interface CodeBlock extends TextualDataBlock {
  readonly type: BlockType.CODE | "code";
  readonly language: CodeLanguage;
}

/**
 * Generated image block - AI-generated image
 */
export interface GeneratedImageBlock extends BaseContentBlock {
  readonly type: BlockType.GENERATED_IMAGE | "generated_image";
  readonly data: string; // base64 encoded image
  readonly mimeType: string;
  readonly altText?: string;
}

/**
 * Generated file block - AI-generated file
 */
export interface GeneratedFileBlock extends BaseContentBlock {
  readonly type: BlockType.GENERATED_FILE | "generated_file";
  readonly uri: string;
  readonly mimeType: string;
  readonly displayName?: string;
}

/**
 * Executable code block - AI-generated executable code
 */
export interface ExecutableCodeBlock extends BaseContentBlock {
  readonly type: BlockType.EXECUTABLE_CODE | "executable_code";
  readonly code: string;
  readonly language?: string;
}

/**
 * Code execution result block - Result of AI-executed code
 */
export interface CodeExecutionResultBlock extends BaseContentBlock {
  readonly type: BlockType.CODE_EXECUTION_RESULT | "code_execution_result";
  readonly output: string;
  readonly isError?: boolean;
}

// ============================================================================
// Event Content Blocks (only valid in event messages)
// ============================================================================

/**
 * User action block - Records a user-initiated action
 *
 * The `text` field provides a human-readable formatted representation,
 * typically populated via JSX children. Model config uses this for output
 * while preserving semantic info (action, actor, etc.) for delimiter targeting.
 */
export interface UserActionBlock extends BaseContentBlock {
  readonly type: BlockType.USER_ACTION | "user_action";
  readonly action: string;
  readonly actor?: string;
  readonly target?: string;
  readonly details?: Record<string, any>;
  /** Formatted text representation (from JSX children) */
  readonly text?: string;
}

/**
 * System event block - Records a system/application event
 *
 * The `text` field provides a human-readable formatted representation,
 * typically populated via JSX children.
 */
export interface SystemEventBlock extends BaseContentBlock {
  readonly type: BlockType.SYSTEM_EVENT | "system_event";
  readonly event: string;
  readonly source?: string;
  readonly data?: Record<string, any>;
  /** Formatted text representation (from JSX children) */
  readonly text?: string;
}

/**
 * State change block - Records a state transition
 *
 * The `text` field provides a human-readable formatted representation,
 * typically populated via JSX children.
 */
export interface StateChangeBlock extends BaseContentBlock {
  readonly type: BlockType.STATE_CHANGE | "state_change";
  readonly entity: string;
  readonly field?: string;
  readonly from: any;
  readonly to: any;
  readonly trigger?: string;
  /** Formatted text representation (from JSX children) */
  readonly text?: string;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * Union of all content block types.
 *
 * Use the `type` discriminator field for type narrowing:
 *
 * @example
 * ```typescript
 * function handleBlock(block: ContentBlock) {
 *   if (block.type === 'text') {
 *     console.log(block.text);
 *   } else if (block.type === 'tool_use') {
 *     console.log(block.name, block.input);
 *   }
 * }
 * ```
 *
 * @see {@link isTextBlock}, {@link isToolUseBlock}, etc. - Type guard functions
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | AudioBlock
  | VideoBlock
  | ToolUseBlock
  | ToolResultBlock
  | ReasoningBlock
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
  | StateChangeBlock;

/** Union of media content blocks (image, document, audio, video) */
export type MediaBlock = ImageBlock | DocumentBlock | AudioBlock | VideoBlock;

/** Union of tool-related blocks (tool call and result) */
export type ToolBlock = ToolUseBlock | ToolResultBlock;

/** Union of structured data blocks (JSON, XML, CSV, HTML, code) */
export type DataBlock = JsonBlock | XmlBlock | CsvBlock | HtmlBlock | CodeBlock;

/** Union of event content blocks (user action, system event, state change) */
export type EventBlock = UserActionBlock | SystemEventBlock | StateChangeBlock;

// Role-specific content block restrictions
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
  | CodeExecutionResultBlock;
export type EventAllowedBlock = TextBlock | UserActionBlock | SystemEventBlock | StateChangeBlock;

// ============================================================================
// Helper Functions
// ============================================================================

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

export function isMediaBlock(block: ContentBlock): block is MediaBlock {
  return (
    block.type === "image" ||
    block.type === "document" ||
    block.type === "audio" ||
    block.type === "video"
  );
}

export function isEventBlock(block: ContentBlock): block is EventBlock {
  return (
    block.type === "user_action" || block.type === "system_event" || block.type === "state_change"
  );
}

export function isUserActionBlock(block: ContentBlock): block is UserActionBlock {
  return block.type === "user_action";
}

export function isSystemEventBlock(block: ContentBlock): block is SystemEventBlock {
  return block.type === "system_event";
}

export function isStateChangeBlock(block: ContentBlock): block is StateChangeBlock {
  return block.type === "state_change";
}

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("\n");
}

export function extractToolUses(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter(isToolUseBlock);
}

// ============================================================================
// Media Source Helpers
// ============================================================================

/**
 * Browser-compatible base64 encoding helper.
 * Uses Buffer in Node.js, browser APIs in browser.
 * Uses globalThis to avoid requiring @types/node in browser environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Node.js environment - use Buffer if available (via globalThis to avoid type dependency)
  const BufferConstructor = (globalThis as any).Buffer;
  if (BufferConstructor && typeof BufferConstructor.from === "function") {
    return BufferConstructor.from(bytes).toString("base64");
  }

  // Browser environment - use btoa with binary string conversion
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Browser-compatible base64 decoding helper.
 * Uses Buffer in Node.js, browser APIs in browser.
 * Uses globalThis to avoid requiring @types/node in browser environments.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  // Node.js environment - use Buffer if available (via globalThis to avoid type dependency)
  const BufferConstructor = (globalThis as any).Buffer;
  if (BufferConstructor && typeof BufferConstructor.from === "function") {
    return new Uint8Array(BufferConstructor.from(base64, "base64"));
  }

  // Browser environment - use atob
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert a Buffer or Uint8Array to a serializable Base64Source.
 *
 * Browser-compatible: works in both Node.js and browser environments.
 * Uses globalThis to avoid requiring @types/node in browser environments.
 *
 * @example
 * ```typescript
 * // Node.js
 * const imageBuffer = await fs.readFile('image.png');
 * const imageBlock: ImageBlock = {
 *   type: 'image',
 *   source: bufferToBase64Source(imageBuffer, 'image/png'),
 * };
 *
 * // Browser
 * const response = await fetch('image.png');
 * const arrayBuffer = await response.arrayBuffer();
 * const uint8Array = new Uint8Array(arrayBuffer);
 * const imageBlock: ImageBlock = {
 *   type: 'image',
 *   source: bufferToBase64Source(uint8Array, 'image/png'),
 * };
 * ```
 */
export function bufferToBase64Source(
  buffer: Uint8Array | { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
  mimeType?: string,
): Base64Source {
  // Convert Buffer-like object to Uint8Array if needed (Node.js)
  // Check via globalThis to avoid requiring @types/node
  const BufferConstructor = (globalThis as any).Buffer;
  let bytes: Uint8Array;

  if (
    BufferConstructor &&
    typeof BufferConstructor.isBuffer === "function" &&
    BufferConstructor.isBuffer(buffer)
  ) {
    // It's a Node.js Buffer - extract underlying ArrayBuffer
    bytes = new Uint8Array(
      (buffer as any).buffer,
      (buffer as any).byteOffset,
      (buffer as any).byteLength,
    );
  } else {
    // It's already a Uint8Array
    bytes = buffer as Uint8Array;
  }

  const data = uint8ArrayToBase64(bytes);

  return {
    type: "base64",
    data,
    mimeType: mimeType,
  };
}

/**
 * Convert a Base64Source back to a Uint8Array.
 *
 * Browser-compatible: returns Uint8Array which works in both Node.js and browser.
 * In Node.js, you can convert to Buffer if needed: `Buffer.from(uint8Array)`
 *
 * @example
 * ```typescript
 * if (imageBlock.source.type === 'base64') {
 *   const uint8Array = base64SourceToBuffer(imageBlock.source);
 *
 *   // In Node.js, convert to Buffer if needed:
 *   // const buffer = Buffer.from(uint8Array);
 *
 *   // In browser, use directly:
 *   // const blob = new Blob([uint8Array], { type: 'image/png' });
 * }
 * ```
 */
export function base64SourceToBuffer(source: Base64Source): Uint8Array {
  return base64ToUint8Array(source.data);
}

/**
 * Check if a string looks like a URL (http:// or https://).
 * Useful for determining source type from string data.
 */
export function isUrlString(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

/**
 * Create a MediaSource from a string (auto-detects URL vs base64).
 *
 * @example
 * ```typescript
 * const source = stringToMediaSource('https://example.com/image.png');
 * // { type: 'url', url: 'https://example.com/image.png' }
 *
 * const source = stringToMediaSource('iVBORw0KGgo...');
 * // { type: 'base64', data: 'iVBORw0KGgo...' }
 * ```
 */
export function stringToMediaSource(str: string, mimeType?: string): UrlSource | Base64Source {
  if (isUrlString(str)) {
    return { type: "url", url: str, mimeType };
  }
  return { type: "base64", data: str, mimeType };
}
