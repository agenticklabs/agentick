/**
 * AI SDK Adapter
 *
 * Wraps Vercel AI SDK models for use with the engine.
 * Supports any LanguageModel from AI SDK providers (OpenAI, Anthropic, Google, etc.)
 *
 * Uses createAdapter for minimal boilerplate - the framework handles:
 * - Stream lifecycle (message_start, content_start/delta/end, message_end)
 * - Content accumulation and ModelOutput construction
 * - Event generation with proper timing and IDs
 */

import {
  type ContentBlock,
  type DocumentBlock,
  type ImageBlock,
  type ReasoningBlock,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  type JsonBlock,
  type MediaBlock,
  type Message,
  StopReason,
  // bufferToBase64Source,
  // isUrlString,
} from "@tentickle/shared";

import {
  type ModelInput,
  type ModelToolReference,
  type ModelClass,
  createAdapter,
  type AdapterDelta,
} from "@tentickle/core/model";

import { type LibraryGenerationOptions, type ProviderToolOptions } from "@tentickle/core";

import { Logger } from "@tentickle/core";

import type { ToolDefinition, ExecutableTool } from "@tentickle/core/tool";

import { mergeDeep } from "@tentickle/shared/utils";

import {
  generateText,
  streamText,
  type ModelMessage,
  type ToolSet,
  type GenerateTextResult,
  type ToolResultPart,
  type ToolCallPart,
  type FilePart,
  type ImagePart,
  type TextPart,
  type AssistantContent,
  type ToolContent,
  type ReasoningUIPart,
  type FinishReason,
  type LanguageModel,
  jsonSchema,
  type Tool,
} from "ai";

// ============================================================================
// Types
// ============================================================================

/**
 * AI SDK LanguageModelV2ToolResultOutput type.
 * Matches the expected output format for tool results.
 */
export type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: unknown }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: unknown }
  | {
      type: "content";
      value: Array<
        { type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
      >;
    };

/**
 * Configuration options for the AI SDK adapter
 */
export interface AiSdkAdapterConfig {
  /** The AI SDK language model instance */
  model: LanguageModel;
  /** Default system prompt */
  system?: string;
  /** Default tools (AI SDK ToolSet format) */
  tools?: ToolSet;
  /** Temperature (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Top P sampling */
  topP?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Provider-specific options */
  providerOptions?: Record<string, unknown>;
}

// Module augmentation for type safety
declare module "@tentickle/core" {
  interface LibraryGenerationOptions {
    "ai-sdk"?: Partial<Parameters<typeof generateText>[0]>;
  }

  interface LibraryToolOptions {
    "ai-sdk"?: Partial<Tool>;
  }
}

const logger = Logger.for("AiSdkAdapter");

// ============================================================================
// Stop Reason Mapping
// ============================================================================

export function toStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case "length":
      return StopReason.MAX_TOKENS;
    case "other":
      return StopReason.OTHER;
    case "stop":
      return StopReason.STOP;
    case "content-filter":
      return StopReason.CONTENT_FILTER;
    case "tool-calls":
      return StopReason.TOOL_USE;
    case "error":
      return StopReason.ERROR;
    default:
      return StopReason.UNSPECIFIED;
  }
}

// ============================================================================
// Tool Conversion
// ============================================================================

/**
 * Convert ModelToolReference[] to AI SDK ToolSet format.
 * Tools are passed as definitions only - engine handles execution.
 */
export function convertToolsToToolSet(tools?: ModelToolReference[]): ToolSet {
  if (!tools || tools.length === 0) {
    return {} as ToolSet;
  }

  const toolSet: ToolSet = {} as ToolSet;

  for (const toolRef of tools) {
    if (typeof toolRef === "string") {
      logger.warn(`🚨 Tool reference ${toolRef} is a string, skipping`);
      // String reference - can't resolve without registry, skip
      continue;
    } else if ("metadata" in toolRef && "run" in toolRef) {
      const toolDef = toolRef as ExecutableTool;

      const libraryOptions = toolDef.metadata?.libraryOptions || {};
      const libraryProviderOptions = libraryOptions["ai-sdk"]?.providerOptions || {};
      const providerOptions = mergeDeep<ProviderToolOptions>(
        {},
        toolDef.metadata.providerOptions || {},
        libraryProviderOptions || {},
      );

      // ExecutableTool - engine will execute these
      toolSet[toolDef.metadata.name] = {
        description: toolDef.metadata.description || "",
        inputSchema: toolDef.metadata.input, // zod schema already
        ...libraryOptions,
        providerOptions,
        // No execute - engine handles execution
      } as any;
    } else if ("name" in toolRef && "input" in toolRef) {
      const toolDef = toolRef as ToolDefinition;
      const libraryOptions = toolDef.libraryOptions || {};
      const libraryProviderOptions = libraryOptions["ai-sdk"]?.providerOptions || {};
      const providerOptions = mergeDeep<ProviderToolOptions>(
        {},
        toolDef.providerOptions || {},
        libraryProviderOptions || {},
      );
      // ToolDefinition - engine will execute these

      toolSet[toolDef.name] = {
        description: toolDef.description || "",
        inputSchema: jsonSchema(toolDef.input || {}),
        ...libraryOptions,
        providerOptions,
        // No execute - engine handles execution
      } as any;
    }
  }

  return toolSet;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an AI SDK adapter for use with the engine.
 *
 * @example
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = createAiSdkModel({
 *   model: openai('gpt-4o'),
 *   temperature: 0.7,
 * });
 *
 * // As JSX
 * <model><MyAgent /></model>
 *
 * // With createApp
 * const app = createApp(MyAgent, { model });
 * ```
 */
export function createAiSdkModel(config: AiSdkAdapterConfig): ModelClass {
  const { model, system: defaultSystem, tools: defaultTools, ...defaultParams } = config;

  return createAdapter<
    Parameters<typeof generateText>[0],
    Awaited<ReturnType<typeof generateText>>,
    any
  >({
    metadata: {
      id: `ai-sdk:${(model as any).modelId || "unknown"}`,
      provider: (model as any).provider || "ai-sdk",
      type: "language",
      capabilities: [
        { stream: true, toolCalls: true },
        {
          // Dynamic function that inspects the underlying model
          messageTransformation: (modelId: string, provider?: string) => {
            // Determine renderer based on provider/model
            // Anthropic/Claude models work best with XML structure
            const isAnthropic =
              provider === "anthropic" || modelId.toLowerCase().includes("claude");
            const preferredRenderer = isAnthropic ? "xml" : "markdown";

            // Determine role mapping based on provider/model
            const supportsDeveloper =
              provider === "anthropic" ||
              (provider === "openai" &&
                (modelId.startsWith("gpt-4") ||
                  modelId.startsWith("o1") ||
                  modelId.startsWith("gpt-5")));

            return {
              preferredRenderer,
              roleMapping: {
                event: supportsDeveloper ? "developer" : "user",
                ephemeral: supportsDeveloper ? "developer" : "user",
              },
              delimiters: {
                useDelimiters: !supportsDeveloper, // Only use delimiters if no developer role
                event: "[Event]",
                ephemeral: "[Context]",
              },
              ephemeralPosition: "flow",
            };
          },
        },
      ],
    },

    // =========================================================================
    // prepareInput: ModelInput → AI SDK format
    // =========================================================================
    prepareInput: (input: ModelInput): Parameters<typeof generateText>[0] => {
      const { libraryOptions = {}, providerOptions = {}, ...params } = input;
      const sdkOptions = (libraryOptions as LibraryGenerationOptions["ai-sdk"]) || {};
      const { tools: adapterTools, system: adapterSystem, ...restOfLibraryOptions } = sdkOptions;

      // Ensure messages is Message[]
      const messages = Array.isArray(params.messages)
        ? params.messages.filter((m: Message | string): m is Message => typeof m !== "string")
        : [];

      const aiSdkMessages = toAiSdkMessages(messages, adapterSystem, defaultSystem);

      // Merge tools: default -> adapter -> input
      const inputToolSet = convertToolsToToolSet(params.tools);
      const mergedTools: ToolSet = {
        ...defaultTools,
        ...(adapterTools || {}),
        ...inputToolSet,
      } as ToolSet;

      // Map responseFormat to AI SDK options
      let outputMode: "text" | "object" | undefined;
      let outputSchema: unknown;
      const mergedProviderOptions = {
        ...defaultParams.providerOptions,
        ...providerOptions,
        ...(sdkOptions.providerOptions || {}),
      } as Record<string, any>;

      if (params.responseFormat) {
        const rf = params.responseFormat;
        if (rf.type === "json") {
          // Use providerOptions to request JSON mode
          mergedProviderOptions.response_format = { type: "json_object" };
        } else if (rf.type === "json_schema") {
          outputMode = "object";
          outputSchema = jsonSchema(rf.schema);
        }
      }

      const result: Parameters<typeof generateText>[0] = {
        model,
        tools: Object.keys(mergedTools).length > 0 ? mergedTools : undefined,
        messages: aiSdkMessages,
        temperature: params.temperature ?? defaultParams.temperature,
        maxOutputTokens: params.maxTokens ?? defaultParams.maxTokens,
        topP: params.topP ?? defaultParams.topP,
        frequencyPenalty: params.frequencyPenalty ?? defaultParams.frequencyPenalty,
        presencePenalty: params.presencePenalty ?? defaultParams.presencePenalty,
        ...(restOfLibraryOptions as Omit<Parameters<typeof generateText>[0], "model" | "prompt">),
        providerOptions: mergedProviderOptions,
      };

      if (outputMode === "object" && outputSchema) {
        (result as any).output = "object";
        (result as any).schema = outputSchema;
      }

      return result;
    },

    // =========================================================================
    // mapChunk: AI SDK chunk → AdapterDelta (~50 lines vs 240 lines)
    // The framework handles lifecycle (content_start/end) automatically
    // =========================================================================
    mapChunk: (chunk: any): AdapterDelta | null => {
      switch (chunk.type) {
        // Text content
        case "text-delta":
          return { type: "text", delta: chunk.text || "" };

        // Reasoning/thinking
        case "reasoning-delta":
          return { type: "reasoning", delta: chunk.text || "" };

        // Tool calls (streamed)
        case "tool-input-start":
          return { type: "tool_call_start", id: chunk.id || "", name: chunk.toolName || "" };
        case "tool-input-delta":
          return { type: "tool_call_delta", id: chunk.id || "", delta: chunk.delta || "" };
        case "tool-input-end":
          return { type: "tool_call_end", id: chunk.id || "", input: undefined };

        // Tool call (complete)
        case "tool-call":
          return {
            type: "tool_call",
            id: chunk.toolCallId,
            name: chunk.toolName,
            input: (chunk as any).args || (chunk as any).input || {},
          };

        // Message lifecycle
        case "start":
          return { type: "message_start" };
        case "finish": {
          const tu = chunk.totalUsage as Record<string, number> | undefined;
          const inTokens = tu?.inputTokens ?? tu?.promptTokens ?? 0;
          const outTokens = tu?.outputTokens ?? tu?.completionTokens ?? 0;
          const totalTokens = tu?.totalTokens ?? inTokens + outTokens;
          return {
            type: "message_end",
            stopReason: toStopReason(chunk.finishReason),
            usage: tu
              ? {
                  inputTokens: inTokens,
                  outputTokens: outTokens,
                  totalTokens,
                  ...(tu.reasoningTokens !== undefined && { reasoningTokens: tu.reasoningTokens }),
                  ...(tu.cachedInputTokens !== undefined && {
                    cachedInputTokens: tu.cachedInputTokens,
                  }),
                }
              : undefined,
          };
        }

        // Errors
        case "abort":
          return { type: "error", error: "Stream aborted", code: "abort" };
        case "error":
          return {
            type: "error",
            error: chunk.error?.message || "Stream error",
            code: "stream_error",
          };

        // Pass through as raw - sources, files, steps
        case "source":
        case "file":
        case "start-step":
        case "finish-step":
        case "tool-result":
        case "tool-error":
        case "raw":
          return { type: "raw", data: chunk };

        // Lifecycle events we don't need (handled by framework)
        case "text-start":
        case "text-end":
        case "reasoning-start":
        case "reasoning-end":
          return null;

        default:
          // Unknown chunk type - pass through as raw
          return { type: "raw", data: chunk };
      }
    },

    // =========================================================================
    // processOutput: Non-streaming result → ModelOutput
    // =========================================================================
    processOutput: (output: Awaited<ReturnType<typeof generateText>>) => {
      const messages = fromAiSdkMessages(output.response.messages) ?? [];
      return {
        messages,
        get message() {
          return messages.filter((msg) => msg.role === "assistant").at(-1);
        },
        usage: {
          inputTokens: output.usage?.inputTokens ?? 0,
          outputTokens: output.usage?.outputTokens ?? 0,
          totalTokens: output.usage?.totalTokens ?? 0,
          reasoningTokens: (output.usage as any)?.reasoningTokens ?? 0,
          cachedInputTokens: (output.usage as any)?.cachedInputTokens ?? 0,
        },
        toolCalls:
          output.toolCalls?.map((toolCall) => {
            return {
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              input: (toolCall as any).args || (toolCall as any).input || {},
              metadata: (toolCall as any).providerMetadata,
              executedBy: (toolCall as any).providerExecuted ? "provider" : undefined,
            };
          }) || [],
        stopReason: toStopReason(output.finishReason),
        model: output.response.modelId,
        createdAt: output.response.timestamp.toISOString(),
        raw: output,
      };
    },

    // =========================================================================
    // Executors
    // =========================================================================
    execute: (params: Parameters<typeof generateText>[0]) => {
      logger.info({ params }, "execute");
      return generateText(params);
    },
    executeStream: (params: Parameters<typeof streamText>[0]) => {
      logger.info({ params }, "executeStream");
      return streamText(params).fullStream;
    },

    reconstructRaw: (accumulated) => {
      // Reconstruct a GenerateTextResult-like object from streaming data
      // This provides a consistent format regardless of streaming vs non-streaming

      // Build tool calls in AI SDK format (with proper type field and input instead of args)
      const toolCalls = accumulated.toolCalls.map((tc) => ({
        type: "tool-call" as const,
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.input,
      }));

      // Build response messages
      const content: AssistantContent = [];
      if (accumulated.text) {
        content.push({ type: "text" as const, text: accumulated.text });
      }
      if (accumulated.reasoning) {
        content.push({ type: "reasoning" as const, text: accumulated.reasoning } as any);
      }
      for (const tc of toolCalls) {
        content.push({
          type: "tool-call" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        } as any);
      }

      // Map internal stop reason to AI SDK FinishReason
      const finishReason = ((): FinishReason => {
        switch (accumulated.stopReason) {
          case StopReason.STOP:
            return "stop";
          case StopReason.MAX_TOKENS:
            return "length";
          case StopReason.TOOL_USE:
            return "tool-calls";
          case StopReason.CONTENT_FILTER:
            return "content-filter";
          case StopReason.ERROR:
            return "error";
          default:
            return "stop";
        }
      })();

      // Reconstruct the GenerateTextResult format
      const reconstructed: Partial<GenerateTextResult<ToolSet, unknown>> = {
        text: accumulated.text || "",
        toolCalls: toolCalls.length > 0 ? (toolCalls as any) : [],
        finishReason,
        usage: {
          inputTokens: accumulated.usage.inputTokens,
          outputTokens: accumulated.usage.outputTokens,
          totalTokens: accumulated.usage.totalTokens,
        },
        response: {
          id: `gen-${Date.now()}`,
          modelId: accumulated.model,
          timestamp: new Date(),
          messages: [
            {
              role: "assistant" as const,
              content,
            },
          ],
        } as any,
      };

      return reconstructed;
    },
  });
}

/**
 * Shorthand factory for creating AI SDK adapter.
 *
 * @example
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aiSdk({ model: openai('gpt-4o') });
 * ```
 */
export function aiSdk(config: AiSdkAdapterConfig): ModelClass {
  return createAiSdkModel(config);
}

// ============================================================================
// Message Conversion
// ============================================================================

export function toAiSdkMessages(
  messages: Message[],
  adapterSystemPrompt: string = "",
  defaultSystem?: string,
): ModelMessage[] {
  let system: string | undefined;
  const modelMessages: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Extract system message
      system = msg.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
    } else if (msg.role === "tool") {
      // Tool role messages - extract tool_result blocks
      const toolResults = msg.content
        .filter((block): block is ToolResultBlock => block.type === "tool_result")
        .map((block) => ({
          type: "tool-result" as const,
          toolCallId: block.toolUseId,
          toolName: block.name || "unknown",
          output: mapToolResultContent(block.content, block.isError),
        }));

      if (toolResults.length > 0) {
        modelMessages.push({
          role: "tool",
          content: toolResults,
        } as any);
      }
    } else {
      // By this point, fromEngineState should have transformed 'event' to 'user'
      // and ephemeral content has been interleaved as regular messages.
      // This is a safety fallback in case adapter is used directly.
      const role = msg.role === "event" ? "user" : msg.role;
      if (role === "user" || role === "assistant") {
        const content = mapContentBlocksToAiSdkContent(msg.content);
        // Skip messages with empty content - these confuse the model
        if (content.length > 0) {
          modelMessages.push({
            role,
            content: content as any,
          });
        }
      }
    }
  }

  system = system || adapterSystemPrompt || defaultSystem;
  if (system) {
    modelMessages.unshift({
      role: "system" as const,
      content: system,
    });
  }
  return modelMessages;
}

/**
 * Convert tool result content blocks to AI SDK LanguageModelV2ToolResultOutput format.
 *
 * The output must be one of:
 * - { type: 'text', value: string }
 * - { type: 'json', value: JSONValue }
 * - { type: 'error-text', value: string }
 * - { type: 'error-json', value: JSONValue }
 * - { type: 'content', value: Array<{ type: 'text', text: string } | { type: 'media', data: string, mediaType: string }> }
 */
export function mapToolResultContent(content: ContentBlock[], isError?: boolean): ToolResultOutput {
  if (!content || content.length === 0) {
    return isError
      ? { type: "error-text" as const, value: "Tool execution failed" }
      : { type: "text" as const, value: "Tool execution succeeded" };
  }

  // Single text block
  if (content.length === 1 && content[0].type === "text") {
    const text = (content[0] as TextBlock).text;
    return isError
      ? { type: "error-text" as const, value: text }
      : { type: "text" as const, value: text };
  }

  // Single JSON block
  if (content.length === 1 && content[0].type === "json") {
    const jsonBlock = content[0] as JsonBlock;
    const data = jsonBlock.data ?? JSON.parse(jsonBlock.text);
    return isError
      ? { type: "error-json" as const, value: data }
      : { type: "json" as const, value: data };
  }

  // Multiple blocks → use 'content' type with array
  const value: Array<
    { type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
  > = content
    .map((block) => {
      if (block.type === "text") {
        const textBlock = block as TextBlock;
        // Skip empty text blocks to avoid AI SDK validation errors
        if (!textBlock.text) return null;
        return { type: "text" as const, text: textBlock.text };
      } else if (block.type === "json") {
        const jsonBlock = block as JsonBlock;
        // JSON blocks can have either data (object) or text (string)
        const jsonText = jsonBlock.text || JSON.stringify(jsonBlock.data, null, 2);
        // Skip if both are empty/undefined
        if (!jsonText) return null;
        return { type: "text" as const, text: jsonText };
      } else if (block.type === "image") {
        const mediaBlock = block as MediaBlock;
        if (mediaBlock.source.type === "base64") {
          return {
            type: "media" as const,
            data: mediaBlock.source.data,
            mediaType: mediaBlock.mimeType || "image/png",
          };
        } else if (mediaBlock.source.type === "url") {
          return { type: "text" as const, text: mediaBlock.source.url };
        } else if (mediaBlock.source.type === "s3") {
          return {
            type: "text" as const,
            text: `s3://${mediaBlock.source.bucket}/${mediaBlock.source.key}`,
          };
        } else if (mediaBlock.source.type === "gcs") {
          return {
            type: "text" as const,
            text: `gs://${mediaBlock.source.bucket}/${mediaBlock.source.object}`,
          };
        }
        // file_id source fallback to text
        return {
          type: "text" as const,
          text: `file_id:${mediaBlock.source.fileId}`,
        };
      }
      // Fallback: serialize as text
      return { type: "text" as const, text: JSON.stringify(block) };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return { type: "content" as const, value };
}

export function fromAiSdkMessages(
  messages: GenerateTextResult<ToolSet, unknown>["response"]["messages"] | undefined,
): Message[] {
  if (!messages || messages.length === 0) {
    return []; // Return empty array - no fake empty assistant messages
  }

  return messages
    .map((msg) => ({
      role: msg.role as Message["role"],
      content: mapAiSdkContentToContentBlocks(msg.content),
    }))
    .filter((msg): msg is Message => msg.content.length > 0); // Only keep messages with content
}

// ============================================================================
// Content Block Conversion: Engine → AI SDK
// ============================================================================

export function mapContentBlocksToAiSdkContent(
  content: ContentBlock[],
): (TextPart | ImagePart | FilePart | ReasoningUIPart | ToolCallPart | ToolResultPart)[] {
  return content
    .map((block) => mapContentBlockToAiSdkPart(block))
    .filter((part): part is NonNullable<typeof part> => part !== undefined);
}

export function mapContentBlockToAiSdkPart(
  block: ContentBlock,
): TextPart | ImagePart | FilePart | ReasoningUIPart | ToolCallPart | ToolResultPart | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };

    case "reasoning":
      return {
        type: "reasoning",
        text: (block as ReasoningBlock).text,
      } as ReasoningUIPart;

    case "image": {
      const imageBlock = block as ImageBlock;
      const source = imageBlock.source;
      if (source.type === "url") {
        return {
          type: "image",
          image: source.url,
          mediaType: imageBlock.mimeType,
        } as ImagePart;
      } else if (source.type === "base64") {
        return {
          type: "image",
          image: source.data,
          mediaType: imageBlock.mimeType,
        } as ImagePart;
      }
      return undefined;
    }

    case "document": {
      const docBlock = block as DocumentBlock;
      const source = docBlock.source;
      if (source.type === "url") {
        return {
          type: "file",
          data: source.url,
          mediaType: docBlock.mimeType,
        } as FilePart;
      } else if (source.type === "base64") {
        return {
          type: "file",
          data: source.data,
          mediaType: docBlock.mimeType,
        } as FilePart;
      }
      return undefined;
    }

    case "audio": {
      const audioBlock = block as MediaBlock;
      const source = audioBlock.source;
      if (source.type === "url") {
        return {
          type: "file",
          data: source.url,
          mediaType: audioBlock.mimeType,
        } as FilePart;
      } else if (source.type === "base64") {
        return {
          type: "file",
          data: source.data,
          mediaType: audioBlock.mimeType,
        } as FilePart;
      }
      return undefined;
    }

    case "video": {
      const videoBlock = block as MediaBlock;
      const source = videoBlock.source;
      if (source.type === "url") {
        return {
          type: "file",
          data: source.url,
          mediaType: videoBlock.mimeType,
        } as FilePart;
      } else if (source.type === "base64") {
        return {
          type: "file",
          data: source.data,
          mediaType: videoBlock.mimeType,
        } as FilePart;
      }
      return undefined;
    }

    case "tool_use": {
      const toolUseBlock = block as ToolUseBlock;
      return {
        type: "tool-call",
        toolCallId: toolUseBlock.toolUseId,
        toolName: toolUseBlock.name,
        input: toolUseBlock.input,
      } as unknown as ToolCallPart;
    }

    case "tool_result": {
      const toolResultBlock = block as ToolResultBlock;
      return {
        type: "tool-result",
        toolCallId: toolResultBlock.toolUseId,
        toolName: toolResultBlock.name || "unknown",
        output: mapToolResultContent(toolResultBlock.content, toolResultBlock.isError),
      } as ToolResultPart;
    }

    default:
      // Fallback: serialize as text
      return { type: "text", text: JSON.stringify(block) };
  }
}

// ============================================================================
// Content Block Conversion: AI SDK → Engine
// ============================================================================

export function mapAiSdkContentToContentBlocks(
  content: AssistantContent | ToolContent,
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((part) => mapAiSdkPartToContentBlock(part))
    .filter((block): block is ContentBlock => block !== undefined);
}

export function mapAiSdkPartToContentBlock(
  part: AssistantContent[number] | ToolContent[number],
): ContentBlock | undefined {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (!("type" in part)) {
    return undefined;
  }

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };

    case "reasoning":
      return { type: "reasoning", text: (part as any).text } as ReasoningBlock;

    case "tool-call":
      return {
        type: "tool_use",
        toolUseId: (part as any).toolCallId,
        name: (part as any).toolName,
        input: ((part as any).args || (part as any).input) as Record<string, unknown>,
      } as ToolUseBlock;

    case "tool-result": {
      const toolResultPart = part as any;
      return {
        type: "tool_result",
        toolUseId: toolResultPart.toolCallId,
        name: toolResultPart.toolName || "unknown",
        content: mapToolResultOutputToContentBlocks(toolResultPart.output as ToolResultOutput),
        isError:
          toolResultPart.output &&
          "type" in toolResultPart.output &&
          toolResultPart.output.type.startsWith("error"),
      } as unknown as ContentBlock;
    }

    default:
      return undefined;
  }
}

function mapToolResultOutputToContentBlocks(output: ToolResultOutput | unknown): ContentBlock[] {
  if (!output || typeof output !== "object") {
    return [{ type: "text", text: String(output) }];
  }

  const typedOutput = output as ToolResultOutput;

  switch (typedOutput.type) {
    case "text":
    case "error-text":
      return [{ type: "text", text: typedOutput.value }];

    case "json":
    case "error-json":
      return [{ type: "json", data: typedOutput.value, text: "" } as JsonBlock];

    case "content":
      return typedOutput.value.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text } as TextBlock;
        }
        // media type
        return {
          type: "image",
          mimeType: item.mediaType,
          source: { type: "base64", data: item.data, mimeType: item.mediaType },
        } as ImageBlock;
      });

    default:
      return [{ type: "text", text: JSON.stringify(output) }];
  }
}
