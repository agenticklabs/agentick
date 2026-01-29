/**
 * Content Block Types
 *
 * Discriminated union types for all content blocks.
 * Normalized across providers.
 */

export enum BlockType {
  // Text content
  TEXT = "text",

  // Media
  IMAGE = "image",
  DOCUMENT = "document",
  AUDIO = "audio",
  VIDEO = "video",

  // Tool calling
  TOOL_USE = "tool_use",
  TOOL_RESULT = "tool_result",

  // Reasoning/thinking (for models that support it)
  REASONING = "reasoning",

  // Structured data
  JSON = "json",
  XML = "xml",
  CSV = "csv",
  HTML = "html",
  CODE = "code",

  // AI-generated content
  GENERATED_IMAGE = "generated_image",
  GENERATED_FILE = "generated_file",
  EXECUTABLE_CODE = "executable_code",
  CODE_EXECUTION_RESULT = "code_execution_result",

  // Event content (only valid in event messages)
  USER_ACTION = "user_action",
  SYSTEM_EVENT = "system_event",
  STATE_CHANGE = "state_change",
}

export type BlockTypes =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "tool_use"
  | "tool_result"
  | "reasoning"
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
  | "state_change";

export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  SYSTEM = "system",
  TOOL = "tool",
  EVENT = "event",
}

export type MessageRoles = "user" | "assistant" | "system" | "tool" | "event" | MessageRole;

export enum MediaSourceType {
  URL = "url",
  BASE64 = "base64",
  FILE_ID = "file_id", // Reference to uploaded file
  S3 = "s3",
  GCS = "gcs",
}

export enum ImageMimeType {
  JPEG = "image/jpeg",
  PNG = "image/png",
  GIF = "image/gif",
  WEBP = "image/webp",
}

export enum DocumentMimeType {
  PDF = "application/pdf",
  TEXT = "text/plain",
  MARKDOWN = "text/markdown",
}

export enum AudioMimeType {
  MP3 = "audio/mpeg",
  WAV = "audio/wav",
  OGG = "audio/ogg",
  M4A = "audio/mp4",
}

export enum VideoMimeType {
  MP4 = "video/mp4",
  WEBM = "video/webm",
}

export enum CodeLanguage {
  TYPESCRIPT = "typescript",
  JAVASCRIPT = "javascript",
  PYTHON = "python",
  JAVA = "java",
  CSHARP = "csharp",
  GO = "go",
  RUST = "rust",
  CPP = "cpp",
  C = "c",
  PHP = "php",
  RUBY = "ruby",
  SWIFT = "swift",
  KOTLIN = "kotlin",
  SQL = "sql",
  SHELL = "shell",
  JSON = "json",
  OTHER = "other",
}
