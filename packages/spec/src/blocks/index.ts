/**
 * Constructors for `@agentick/spec` content blocks — one per block interface.
 *
 * Required fields are positional, in the order you would say them; every
 * optional field the spec allows (the block's own and {@link BaseContentBlock}'s)
 * rides the trailing `extra` bag, so the escape hatch is exactly the spec and a
 * field it does not allow fails to compile. Keys whose value is `undefined` are
 * dropped, so a constructed block deep-equals a wire block.
 *
 * Opinions, each with its hatch: `custom` self-closes when its content is empty
 * (`extra.selfClosing` wins); `toolResult` takes the same currency a tool
 * handler returns (a string, blocks, or an envelope) and normalizes it the way
 * dispatch does; `json` takes `data` and never derives `text`; `text` is
 * exactly `{ type, text }`.
 */

import type {
  AudioBlock,
  Base64Source,
  CodeBlock,
  CodeExecutionResultBlock,
  CodeLanguage,
  ContentBlock,
  CsvBlock,
  CustomContentBlock,
  DocumentBlock,
  ExecutableCodeBlock,
  FileReferenceSource,
  GeneratedFileBlock,
  GeneratedImageBlock,
  HtmlBlock,
  ImageBlock,
  JsonBlock,
  MediaSource,
  ReasoningBlock,
  ResourceBlock,
  ResourceContents,
  StateChangeBlock,
  SystemEventBlock,
  TaskRefBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UrlSource,
  UserActionBlock,
  VideoBlock,
  XmlBlock,
} from "../data/content-blocks.js";
import type { ToolResultEnvelope, ToolResultInput } from "../data/tool-result.js";
import { normalizeToolResult } from "../data/tool-result.js";

/** Every field of `B` the constructor does not take positionally. */
export type Extra<B extends ContentBlock, K extends keyof B = never> = Partial<Omit<B, "type" | K>>;

function defined<T extends object>(extra: T | undefined): Partial<T> {
  if (extra === undefined) return {};
  const out: Partial<T> = {};
  for (const key of Object.keys(extra) as (keyof T)[]) {
    if (extra[key] !== undefined) out[key] = extra[key];
  }
  return out;
}

// ────────── Textual ──────────

export const text = (text: string, extra?: Extra<TextBlock, "text">): TextBlock => ({
  type: "text",
  text,
  ...defined(extra),
});

export const reasoning = (text: string, extra?: Extra<ReasoningBlock, "text">): ReasoningBlock => ({
  type: "reasoning",
  text,
  ...defined(extra),
});

export const json = (data: unknown, extra?: Extra<JsonBlock, "data">): JsonBlock => ({
  type: "json",
  data,
  ...defined(extra),
});

export const xml = (text: string, extra?: Extra<XmlBlock, "text">): XmlBlock => ({
  type: "xml",
  text,
  ...defined(extra),
});

export const csv = (text: string, extra?: Extra<CsvBlock, "text">): CsvBlock => ({
  type: "csv",
  text,
  ...defined(extra),
});

export const html = (text: string, extra?: Extra<HtmlBlock, "text">): HtmlBlock => ({
  type: "html",
  text,
  ...defined(extra),
});

export const code = (
  text: string,
  language: CodeLanguage,
  extra?: Extra<CodeBlock, "text" | "language">,
): CodeBlock => ({ type: "code", text, language, ...defined(extra) });

// ────────── Media ──────────

export const image = (source: MediaSource, extra?: Extra<ImageBlock, "source">): ImageBlock => ({
  type: "image",
  source,
  ...defined(extra),
});

export const document = (
  source: MediaSource,
  extra?: Extra<DocumentBlock, "source">,
): DocumentBlock => ({ type: "document", source, ...defined(extra) });

export const audio = (source: MediaSource, extra?: Extra<AudioBlock, "source">): AudioBlock => ({
  type: "audio",
  source,
  ...defined(extra),
});

export const video = (source: MediaSource, extra?: Extra<VideoBlock, "source">): VideoBlock => ({
  type: "video",
  source,
  ...defined(extra),
});

/** The three places bytes come from, named the way a block names them. */
export const source = {
  url: (url: string, extra?: Partial<Omit<UrlSource, "type" | "url">>): UrlSource => ({
    type: "url",
    url,
    ...defined(extra),
  }),
  base64: (
    data: string,
    mimeType: string,
    extra?: Partial<Omit<Base64Source, "type" | "data" | "mimeType">>,
  ): Base64Source => ({ type: "base64", data, mimeType, ...defined(extra) }),
  reference: (
    fileId: string,
    extra?: Partial<Omit<FileReferenceSource, "type" | "fileId">>,
  ): FileReferenceSource => ({ type: "reference", fileId, ...defined(extra) }),
} as const;

// ────────── Tools ──────────

export const toolUse = (
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  extra?: Extra<ToolUseBlock, "toolUseId" | "name" | "input">,
): ToolUseBlock => ({ type: "tool_use", toolUseId, name, input, ...defined(extra) });

/**
 * The answer to a tool call, from what the tool returned. An envelope's
 * `isError` lands on the block; its `structuredContent` and `metadata` are
 * dispatch-level and do not ride the block, as in the session harness.
 */
export const toolResult = (
  toolUseId: string,
  name: string,
  result: ToolResultInput,
  extra?: Extra<ToolResultBlock, "toolUseId" | "name" | "content">,
): ToolResultBlock => {
  const normalized = normalizeToolResult(result);
  return {
    type: "tool_result",
    toolUseId,
    name,
    content: normalized.content,
    ...(normalized.isError !== undefined ? { isError: normalized.isError } : {}),
    ...defined(extra),
  };
};

/** What a tool handler returns: content plus the dispatch-level facts about it. */
export const envelope = (
  content: string | readonly ContentBlock[],
  extra?: Partial<Omit<ToolResultEnvelope, "content">>,
): ToolResultEnvelope => ({ content, ...defined(extra) });

export const taskRef = (
  taskId: string,
  status: string,
  extra?: Extra<TaskRefBlock, "taskId" | "status">,
): TaskRefBlock => ({ type: "task_ref", taskId, status, ...defined(extra) });

export const resource = (
  resource: ResourceContents,
  extra?: Extra<ResourceBlock, "resource">,
): ResourceBlock => ({ type: "resource", resource, ...defined(extra) });

// ────────── Generated ──────────

export const generatedImage = (
  data: string,
  mimeType: string,
  extra?: Extra<GeneratedImageBlock, "data" | "mimeType">,
): GeneratedImageBlock => ({ type: "generated_image", data, mimeType, ...defined(extra) });

export const generatedFile = (
  uri: string,
  mimeType: string,
  extra?: Extra<GeneratedFileBlock, "uri" | "mimeType">,
): GeneratedFileBlock => ({ type: "generated_file", uri, mimeType, ...defined(extra) });

export const executableCode = (
  code: string,
  extra?: Extra<ExecutableCodeBlock, "code">,
): ExecutableCodeBlock => ({ type: "executable_code", code, ...defined(extra) });

export const codeExecutionResult = (
  output: string,
  extra?: Extra<CodeExecutionResultBlock, "output">,
): CodeExecutionResultBlock => ({ type: "code_execution_result", output, ...defined(extra) });

// ────────── Events ──────────

export const userAction = (
  action: string,
  extra?: Extra<UserActionBlock, "action">,
): UserActionBlock => ({ type: "user_action", action, ...defined(extra) });

export const systemEvent = (
  event: string,
  extra?: Extra<SystemEventBlock, "event">,
): SystemEventBlock => ({ type: "system_event", event, ...defined(extra) });

export const stateChange = (
  entity: string,
  from: unknown,
  to: unknown,
  extra?: Extra<StateChangeBlock, "entity" | "from" | "to">,
): StateChangeBlock => ({ type: "state_change", entity, from, to, ...defined(extra) });

// ────────── Custom ──────────

export const custom = (
  tag: string,
  attrs: Record<string, string> = {},
  content = "",
  extra?: Extra<CustomContentBlock, "tag" | "attrs" | "content">,
): CustomContentBlock => ({
  type: "custom",
  tag,
  attrs,
  content,
  selfClosing: content === "",
  ...defined(extra),
});
