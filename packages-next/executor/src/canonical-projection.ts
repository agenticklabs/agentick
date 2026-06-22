/**
 * Canonical `ProjectInput → LanguageModelInput` projection.
 *
 * Used as the default by `BaseLanguageModelExecutor.projectImpl` and by
 * `defineExecutor`'s `CallbackLanguageModelExecutor`. Concrete provider
 * executors override `projectImpl` when their system-message or
 * tool-declaration shape requires it (e.g., Anthropic preserves
 * per-section `providerMetadata` by emitting one text part per section).
 *
 * The fold:
 *   - All `section` entries → a single system message (markdown-flavored).
 *   - All `message` entries → corresponding chat messages.
 *   - All `tool` declarations with `model` exposure → `tools[]`.
 *
 * Pure / deterministic. No provider dependencies.
 */

import type {
  ContentBlock,
  ContextEntry,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelParameters,
  LanguageModelTool,
  MediaSource,
  ProjectInput,
  RenderedTree,
  SectionEntry,
  ToolDeclaration,
} from "@agentick/spec-next";
import { toJsonSchema } from "@agentick/spec-next";

export function defaultProject(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  // Tools come from `input.tools` — the loop's per-tick compile result
  // (precedence-resolved across gateway/app/session/execution/extension/
  // reconciler). The IR's `compiled.declarations.tools` records what
  // the reconciler emitted but is NOT the canonical source for the
  // model's visible tool list. See `ProjectInput.tools` for context.
  const tools = buildTools(input.tools);
  const parameters = buildParameters(input.compiled);
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

/**
 * Lift `tree.config` (generation params) into `LanguageModelParameters`.
 * Returns `undefined` when `tree.config` is absent or empty so callers
 * spread conditionally — `LanguageModelInput.parameters` is only set
 * when it's meaningful.
 */
export function buildParameters(tree: RenderedTree): LanguageModelParameters | undefined {
  const cfg = tree.config;
  if (!cfg) return undefined;
  const params: {
    temperature?: number;
    maxOutputTokens?: number;
    responseFormat?: {
      type: "text" | "json" | "json_schema";
      schema?: Record<string, unknown>;
    };
  } = {};
  if (cfg.temperature !== undefined) params.temperature = cfg.temperature;
  if (cfg.maxOutputTokens !== undefined) params.maxOutputTokens = cfg.maxOutputTokens;
  if (cfg.responseFormat !== undefined) {
    if (cfg.responseFormat.type === "json_schema") {
      params.responseFormat = {
        type: "json_schema",
        schema: cfg.responseFormat.schema as Record<string, unknown>,
      };
    } else {
      params.responseFormat = { type: cfg.responseFormat.type };
    }
  }
  return Object.keys(params).length > 0 ? (params as LanguageModelParameters) : undefined;
}

export function buildMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  const messages: LanguageModelMessage[] = [];
  const systemText = collectSectionText(tree.context.entries);
  if (systemText.length > 0) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: systemText }],
    });
  }
  for (const entry of tree.context.entries) {
    if (entry.kind !== "message") continue;
    messages.push({
      role: entry.role as LanguageModelMessage["role"],
      content: entry.content.map(messagePartFromBlock),
    });
  }
  return messages;
}

export function collectSectionText(entries: ReadonlyArray<ContextEntry>): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind !== "section") continue;
    const text = sectionText(e);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

export function sectionText(section: SectionEntry): string {
  const lines: string[] = [];
  if (section.title !== undefined) lines.push(`# ${section.title}`);
  for (const block of section.content) {
    if (block.type === "text") lines.push(block.text);
  }
  return lines.join("\n");
}

export function messagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  const pm =
    block.providerMetadata !== undefined ? { providerMetadata: block.providerMetadata } : {};
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...pm };
    case "image":
      return {
        type: "image",
        imageUrl: imageUrlFromSource(block.source, block.mimeType),
        ...(block.mimeType !== undefined ? { mediaType: block.mimeType } : {}),
        ...pm,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input,
        ...pm,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content.map(messagePartFromBlock),
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
        ...pm,
      };
    default:
      return {
        type: "text",
        text:
          "text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block),
      };
  }
}

export function imageUrlFromSource(source: MediaSource, mimeType: string | undefined): string {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64": {
      const mt = source.mimeType ?? mimeType ?? "image/png";
      return `data:${mt};base64,${source.data}`;
    }
    case "reference":
      return source.fileId;
    case "s3":
      return `s3://${source.bucket}/${source.key}`;
    case "gcs":
      return `gs://${source.bucket}/${source.object}`;
  }
}

/**
 * Project `ToolDeclaration[]` to the wire-shape `LanguageModelTool[]`.
 * Filters to model-exposed tools and projects `inputSchema` /
 * `outputSchema` through `toJsonSchema()` for the provider.
 *
 * Adopters: prefer the canonical `ProjectInput.tools` source rather
 * than re-reading `compiled.declarations.tools` — the IR slot is the
 * reconciler's record; the canonical source is the loop's compile
 * (which folds gateway/app/session/execution/extension/reconciler
 * with correct precedence). Provider-specific executors that need to
 * stay aligned with the canonical fold should call this helper.
 */
export function buildTools(tools: readonly ToolDeclaration[]): ReadonlyArray<LanguageModelTool> {
  return tools
    .filter((t) => t.exposure.includes("model"))
    .map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: toJsonSchema(t.inputSchema) as Record<string, unknown>,
      ...(t.outputSchema !== undefined
        ? { outputSchema: toJsonSchema(t.outputSchema) as Record<string, unknown> }
        : {}),
      ...(t.providerOptions !== undefined ? { providerOptions: t.providerOptions } : {}),
    }));
}
