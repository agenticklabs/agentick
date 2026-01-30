/**
 * AI SDK Adapter
 *
 * Wraps Vercel AI SDK models for use with the engine.
 * Supports any LanguageModel from AI SDK providers (OpenAI, Anthropic, Google, etc.)
 */

import {
  type AudioBlock,
  type ContentBlock,
  type DocumentBlock,
  type ImageBlock,
  type ReasoningBlock,
  type TextBlock,
  type ToolResultBlock,
  type VideoBlock,
  type ToolUseBlock,
  type JsonBlock,
  type MediaBlock,
  type Message,
  type StreamEvent,
  type ModelStreamEvent,
  type StreamEventBase,
  isModelStreamEvent,
  type ContentStartEvent,
  type ContentDeltaEvent,
  type ContentEndEvent,
  type ReasoningStartEvent,
  type ReasoningDeltaEvent,
  type ReasoningEndEvent,
  type ToolCallStartEvent,
  type ToolCallDeltaEvent,
  type ToolCallEndEvent,
  type ToolCallEvent,
  type MessageStartEvent,
  type MessageEndEvent,
  type StreamErrorEvent,
  StopReason,
  BlockType,
  bufferToBase64Source,
  isUrlString,
} from "@tentickle/shared";

import {
  type ModelInput,
  type ModelOutput,
  type ModelToolReference,
  type EngineModel,
  createLanguageModel,
} from "@tentickle/core/model";

import { type LibraryGenerationOptions, type ProviderToolOptions } from "@tentickle/core";

import type { COMInput, COMTimelineEntry, EngineInput } from "@tentickle/core/com";

import { Logger } from "@tentickle/core/core";

import type { ToolDefinition, ExecutableTool, ToolClass } from "@tentickle/core/tool";

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

// ============================================================================
// Event Helpers
// ============================================================================

let adapterEventIdCounter = 0;
let adapterSequenceCounter = 0;

/**
 * Generate a unique event ID for adapter stream events
 */
function generateAdapterEventId(): string {
  return `aievt_${Date.now()}_${++adapterEventIdCounter}`;
}

/**
 * Create base event fields for ModelStreamEvent
 * Adapter layer always uses tick=1 since it doesn't have engine context
 */
function createAdapterEventBase(): StreamEventBase {
  return {
    id: generateAdapterEventId(),
    tick: 1,
    sequence: ++adapterSequenceCounter,
    timestamp: new Date().toISOString(),
  };
}

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

export type AiSdkAdapter = EngineModel<ModelInput, ModelOutput>;

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
 * ```
 */
export function createAiSdkModel(config: AiSdkAdapterConfig): AiSdkAdapter {
  const { model, system: defaultSystem, tools: defaultTools, ...defaultParams } = config;

  return createLanguageModel<
    ModelInput,
    ModelOutput,
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

    transformers: {
      prepareInput: (input): Parameters<typeof generateText>[0] => {
        const { libraryOptions = {}, providerOptions = {}, ...params } = input;
        const sdkOptions = (libraryOptions as LibraryGenerationOptions["ai-sdk"]) || {};
        const { tools: adapterTools, system: adapterSystem, ...restOfLibraryOptions } = sdkOptions;

        // Ensure messages is Message[]
        const messages = Array.isArray(params.messages)
          ? params.messages.filter((m): m is Message => typeof m !== "string")
          : [];

        const aiSdkMessages = toAiSdkMessages(messages, adapterSystem, defaultSystem);

        // Merge tools: default -> adapter -> input
        const inputToolSet = convertToolsToToolSet(params.tools);
        const mergedTools: ToolSet = {
          ...defaultTools,
          ...(adapterTools || {}),
          ...inputToolSet,
        } as ToolSet;

        return {
          model,
          tools: Object.keys(mergedTools).length > 0 ? mergedTools : undefined,
          messages: aiSdkMessages,
          temperature: params.temperature ?? defaultParams.temperature,
          maxOutputTokens: params.maxTokens ?? defaultParams.maxTokens,
          topP: params.topP ?? defaultParams.topP,
          frequencyPenalty: params.frequencyPenalty ?? defaultParams.frequencyPenalty,
          presencePenalty: params.presencePenalty ?? defaultParams.presencePenalty,
          ...(restOfLibraryOptions as Omit<Parameters<typeof generateText>[0], "model" | "prompt">),
          providerOptions: {
            ...defaultParams.providerOptions,
            ...providerOptions,
            ...(sdkOptions.providerOptions || {}),
          },
        };
      },

      processOutput: (output) => {
        const messages = fromAiSdkMessages(output.response.messages) ?? [];
        const result = {
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

        return result;
      },

      processChunk: (chunk: any): ModelStreamEvent => {
        const base = createAdapterEventBase();

        // AI SDK TextStreamPart types - see ai/dist/index.d.ts
        switch (chunk.type) {
          // Text content
          case "text-start":
            return {
              type: "content_start",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentStartEvent;
          case "text-delta":
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: chunk.text || "",
            } as ContentDeltaEvent;
          case "text-end":
            return {
              type: "content_end",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentEndEvent;

          // Reasoning/thinking
          case "reasoning-start":
            return {
              type: "reasoning_start",
              ...base,
              blockIndex: 0,
            } as ReasoningStartEvent;
          case "reasoning-delta":
            return {
              type: "reasoning_delta",
              ...base,
              blockIndex: 0,
              delta: chunk.text || "",
            } as ReasoningDeltaEvent;
          case "reasoning-end":
            return {
              type: "reasoning_end",
              ...base,
              blockIndex: 0,
            } as ReasoningEndEvent;

          // Tool calls
          case "tool-input-start":
            return {
              type: "tool_call_start",
              ...base,
              callId: chunk.id || generateAdapterEventId(),
              name: chunk.toolName || "",
              blockIndex: 0,
            } as ToolCallStartEvent;
          case "tool-input-delta":
            return {
              type: "tool_call_delta",
              ...base,
              callId: chunk.id || "",
              blockIndex: 0,
              delta: chunk.delta || "",
            } as ToolCallDeltaEvent;
          case "tool-input-end":
            return {
              type: "tool_call_end",
              ...base,
              callId: chunk.id || "",
              blockIndex: 0,
            } as ToolCallEndEvent;
          case "tool-call":
            return {
              type: "tool_call",
              ...base,
              callId: chunk.toolCallId,
              name: chunk.toolName,
              input: (chunk as any).args || (chunk as any).input || {},
              blockIndex: 0,
              startedAt: base.timestamp,
              completedAt: base.timestamp,
            } as ToolCallEvent;
          case "tool-result":
            // Provider-executed tool result - emit as content_delta with raw data
            // (tool_result is an OrchestrationStreamEvent, not ModelStreamEvent)
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: {
                type: "tool_result",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                result: chunk.result,
                providerExecuted: true,
              },
            } as ContentDeltaEvent;
          case "tool-error":
            return {
              type: "error",
              ...base,
              error: {
                message: chunk.error?.message || "Tool error",
                code: "tool_error",
              },
            } as StreamErrorEvent;

          // Sources and files - pass through as content_delta with raw
          case "source":
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: { type: "source", ...chunk },
            } as ContentDeltaEvent;
          case "file":
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: { type: "file", file: chunk.file },
            } as ContentDeltaEvent;

          // Step lifecycle - pass through as content_delta with raw
          case "start-step":
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: {
                type: "step_start",
                stepRequest: chunk.request,
                stepWarnings: chunk.warnings || [],
              },
            } as ContentDeltaEvent;
          case "finish-step": {
            // AI SDK provides inputTokens/outputTokens OR promptTokens/completionTokens
            const su = chunk.usage as Record<string, number> | undefined;
            const stepInTokens = su?.inputTokens ?? su?.promptTokens ?? 0;
            const stepOutTokens = su?.outputTokens ?? su?.completionTokens ?? 0;
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: {
                type: "step_end",
                stepResponse: chunk.response,
                usage: su
                  ? {
                      inputTokens: stepInTokens,
                      outputTokens: stepOutTokens,
                      totalTokens: su?.totalTokens ?? stepInTokens + stepOutTokens,
                    }
                  : undefined,
                stopReason: toStopReason(chunk.finishReason),
              },
            } as ContentDeltaEvent;
          }

          // Stream lifecycle
          case "start":
            return {
              type: "message_start",
              ...base,
              role: "assistant",
            } as MessageStartEvent;
          case "finish": {
            // AI SDK provides inputTokens/outputTokens OR promptTokens/completionTokens
            // depending on the provider. Handle both cases.
            const tu = chunk.totalUsage as Record<string, number> | undefined;
            const inTokens = tu?.inputTokens ?? tu?.promptTokens ?? 0;
            const outTokens = tu?.outputTokens ?? tu?.completionTokens ?? 0;
            const totalTokens = tu?.totalTokens ?? inTokens + outTokens;
            const reasoningTokens = tu?.reasoningTokens;
            const cachedInputTokens = tu?.cachedInputTokens;

            return {
              type: "message_end",
              ...base,
              stopReason: toStopReason(chunk.finishReason),
              usage: tu
                ? {
                    inputTokens: inTokens,
                    outputTokens: outTokens,
                    totalTokens,
                    ...(reasoningTokens !== undefined && { reasoningTokens }),
                    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
                  }
                : undefined,
            } as MessageEndEvent;
          }
          case "abort":
            return {
              type: "error",
              ...base,
              error: { message: "Stream aborted", code: "abort" },
            } as StreamErrorEvent;
          case "error":
            return {
              type: "error",
              ...base,
              error: {
                message: chunk.error?.message || "Stream error",
                code: "stream_error",
              },
            } as StreamErrorEvent;
          case "raw":
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: chunk.rawValue,
            } as ContentDeltaEvent;

          default:
            // Unknown chunk type - pass through as content_delta
            return {
              type: "content_delta",
              ...base,
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "",
              raw: chunk,
            } as ContentDeltaEvent;
        }
      },

      processStream: async (events: StreamEvent[]) => {
        // Aggregate stream events into ModelOutput
        let text = "";
        let reasoning = "";
        const toolCalls: any[] = [];
        let stopReason: StopReason = StopReason.UNSPECIFIED;
        let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

        const modelEvents = events.filter(isModelStreamEvent);

        for (const event of modelEvents) {
          if (event.type === "content_delta") {
            text += (event as ContentDeltaEvent).delta;
          }
          if (event.type === "reasoning_delta") {
            reasoning += (event as ReasoningDeltaEvent).delta;
          }
          if (event.type === "tool_call") {
            const tc = event as ToolCallEvent;
            toolCalls.push({ id: tc.callId, name: tc.name, input: tc.input });
          }
          if (event.type === "message_end") {
            const endEvent = event as MessageEndEvent;
            stopReason = endEvent.stopReason;
            if (endEvent.usage) {
              usage = endEvent.usage;
            }
          }
        }

        const content: ContentBlock[] = [];
        // Add reasoning block first if present
        if (reasoning) {
          content.push({ type: "reasoning", text: reasoning } as ContentBlock);
        }
        if (text) {
          content.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            toolUseId: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }

        const messages: Message[] = [
          {
            role: "assistant",
            content,
          },
        ];

        return {
          messages,
          get message() {
            return messages[0];
          },
          usage,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
          model: (model as any).modelId || "unknown",
          createdAt: new Date().toISOString(),
          raw: events,
        };
      },
    },

    executors: {
      execute: (params) => {
        logger.info({ params }, "execute");
        return generateText(params);
      },
      executeStream: (params) => {
        logger.info({ params }, "executeStream");
        return streamText(params).fullStream;
      },
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
export function aiSdk(config: AiSdkAdapterConfig): AiSdkAdapter {
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
      const audioBlock = block as AudioBlock;
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
      const videoBlock = block as VideoBlock;
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
        toolName: toolResultBlock.name,
        output: mapContentBlocksToToolResultOutput(
          toolResultBlock.content,
          toolResultBlock.isError,
        ),
      } as unknown as ToolResultPart;
    }

    default:
      // Unexpected block type - convert to text as fallback
      // This should rarely happen if fromEngineState is working correctly,
      // but provides graceful degradation for unexpected types
      const blockType = (block as any).type || "unknown";
      const blockText = (block as any).text || JSON.stringify(block, null, 2);
      logger.warn(
        `[AI SDK Adapter] Unexpected block type "${blockType}" - converting to text. This should have been converted by fromEngineState.`,
      );
      return { type: "text", text: blockText };
  }
}

/**
 * Convert ContentBlock[] to LanguageModelV2ToolResultOutput format.
 * Used in mapContentBlockToAiSdkPart for tool_result blocks.
 */
export function mapContentBlocksToToolResultOutput(
  content: ContentBlock[],
  isError?: boolean,
): ToolResultPart["output"] {
  // Empty content
  if (!content || content.length === 0) {
    return isError
      ? { type: "error-text" as const, value: "Tool execution failed" }
      : { type: "text" as const, value: "Tool execution succeeded" };
  }

  // Single text block
  if (content.length === 1 && content[0].type === "text") {
    const text = content[0].text;
    return isError
      ? { type: "error-text" as const, value: text }
      : { type: "text" as const, value: text };
  }

  // Single JSON block
  if (content.length === 1 && content[0].type === "json") {
    const jsonBlock = content[0] as JsonBlock;
    const data = jsonBlock.data || JSON.parse(jsonBlock.text);
    return isError
      ? { type: "error-json" as const, value: data }
      : { type: "json" as const, value: data };
  }

  // Multiple blocks → use 'content' type
  return {
    type: "content" as const,
    value: content
      .map((block) => {
        if (block.type === "text") {
          // Skip empty text blocks to avoid AI SDK validation errors
          if (!block.text) return null;
          return { type: "text" as const, text: block.text };
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
          // URL images fallback to text
          return {
            type: "text" as const,
            text: `file_id:${mediaBlock.source.fileId}`,
          };
        }
        // Fallback: serialize as text
        return { type: "text" as const, text: JSON.stringify(block) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
  };
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

  return content
    .map(mapAiSdkPartToContentBlock)
    .filter((block): block is ContentBlock => block !== undefined);
}

export function mapAiSdkPartToContentBlock(
  part: TextPart | ImagePart | FilePart | ReasoningUIPart | ToolCallPart | ToolResultPart,
): ContentBlock | undefined {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text } as TextBlock;

    case "reasoning":
      return { type: "reasoning", text: part.text } as ReasoningBlock;

    case "image": {
      const imageData = part.image;

      if (typeof imageData === "string") {
        return {
          type: "image",
          source: isUrlString(imageData)
            ? { type: "url", url: imageData }
            : { type: "base64", data: imageData },
          mimeType: part.mediaType,
        } as ImageBlock;
      } else if (imageData instanceof Uint8Array || Buffer.isBuffer(imageData)) {
        return {
          type: "image",
          source: bufferToBase64Source(imageData, part.mediaType),
        } as ImageBlock;
      }
      return undefined;
    }

    case "file": {
      const fileData = part.data;

      if (typeof fileData === "string") {
        return {
          type: "document",
          source: isUrlString(fileData)
            ? { type: "url", url: fileData }
            : { type: "base64", data: fileData },
          mimeType: part.mediaType,
        } as DocumentBlock;
      } else if (fileData instanceof Uint8Array || Buffer.isBuffer(fileData)) {
        return {
          type: "document",
          source: bufferToBase64Source(fileData, part.mediaType),
        } as DocumentBlock;
      }
      return undefined;
    }

    case "tool-call":
      return {
        type: "tool_use",
        toolUseId: part.toolCallId,
        name: part.toolName,
        input: (part as any).args || (part as any).input || {},
      } as ToolUseBlock;

    case "tool-result": {
      const output = (part as any).output || (part as any).result;
      return {
        type: "tool_result",
        toolUseId: part.toolCallId,
        name: part.toolName,
        content: mapToolResultToContentBlocks(output),
        isError: typeof output === "object" && output !== null && "error" in output,
      } as ToolResultBlock;
    }

    default:
      return undefined;
  }
}

export function mapToolResultToContentBlocks(result: any): ContentBlock[] {
  if (result === undefined || result === null) {
    return [{ type: "text", text: "[No result]" }];
  }

  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }

  if (Array.isArray(result)) {
    const blocks: ContentBlock[] = [];
    for (const item of result) {
      if (typeof item === "string") {
        blocks.push({ type: "text", text: item } as TextBlock);
      } else if (item && typeof item === "object" && "type" in item) {
        if (item.type === "text" && "text" in item) {
          blocks.push({ type: "text", text: item.text } as TextBlock);
        } else if (item.type === "image" && "data" in item) {
          blocks.push({
            type: "image",
            source: { type: "base64", data: item.data },
            mimeType: (item as any).mediaType || "image/png",
          } as ImageBlock);
        } else {
          // Unknown type, serialize as JSON
          blocks.push({
            type: "json",
            text: JSON.stringify(item),
            data: item,
          } as JsonBlock);
        }
      } else {
        // Fallback: serialize as JSON
        blocks.push({
          type: "json",
          text: JSON.stringify(item),
          data: item,
        } as JsonBlock);
      }
    }
    return blocks;
  }

  // Object result → JSON block
  return [{ type: "json", text: JSON.stringify(result), data: result } as JsonBlock];
}

// ============================================================================
// Compiler Integration Helpers
// ============================================================================

/**
 * Convert AI SDK input messages to our Message[] format.
 * This is the inverse of toAiSdkMessages.
 *
 * Use this when receiving messages in AI SDK format and need to process
 * them with our internal systems.
 */
export function fromAiSdkInputMessages(messages: ModelMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      result.push({
        role: "system",
        content: [{ type: "text", text }],
      });
    } else if (msg.role === "user" || msg.role === "assistant") {
      const content =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : Array.isArray(msg.content)
            ? mapAiSdkContentToContentBlocks(msg.content as any)
            : [];

      if (content.length > 0) {
        result.push({ role: msg.role, content });
      }
    } else if (msg.role === "tool") {
      const content = Array.isArray(msg.content)
        ? (msg.content as any[]).map((part: any) => ({
            type: "tool_result" as const,
            toolUseId: part.toolCallId,
            name: part.toolName || "unknown",
            content: mapToolResultToContentBlocks(part.result ?? part.output),
            isError: part.isError,
          }))
        : [];

      if (content.length > 0) {
        result.push({ role: "tool", content });
      }
    }
  }

  return result;
}

/**
 * Convert our Message[] to EngineInput format.
 * Wraps messages in COMTimelineEntry structures.
 */
export function messagesToEngineInput(messages: Message[]): EngineInput {
  const timeline: COMTimelineEntry[] = messages.map((msg) => ({
    kind: "message" as const,
    message: msg,
  })) as COMTimelineEntry[];

  return { timeline, sections: {} };
}

/**
 * Convert AI SDK messages directly to EngineInput.
 * Convenience function that chains fromAiSdkInputMessages → messagesToEngineInput.
 */
export function aiSdkMessagesToEngineInput(messages?: ModelMessage[]): EngineInput {
  if (!messages || messages.length === 0) {
    return { timeline: [], sections: {} };
  }

  return messagesToEngineInput(fromAiSdkInputMessages(messages));
}

/**
 * Convert compiled output (COMInput) to AI SDK CompiledInput format.
 * Used by the compiler adapter to produce library-native output.
 */
export function toAiSdkCompiledInput(
  formatted: COMInput,
  tools: (ToolClass | ExecutableTool)[],
  tick: number,
  extractedModel?: LanguageModel,
): {
  messages: ModelMessage[];
  tools?: ToolSet;
  system?: string;
  model?: LanguageModel;
  tick: number;
} {
  // Extract messages and system from timeline
  const messages: ModelMessage[] = [];
  let system: string | undefined;

  for (const entry of formatted.timeline || []) {
    if (entry.kind === "message") {
      const msg = entry.message as Message;

      if (msg.role === "system") {
        // Accumulate system messages
        const text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        system = system ? `${system}\n\n${text}` : text;
      } else if (msg.role === "user" || msg.role === "assistant") {
        const content = mapContentBlocksToAiSdkContent(msg.content);
        if (content.length > 0) {
          messages.push({ role: msg.role, content } as any);
        }
      } else if (msg.role === "tool") {
        const toolResults = msg.content
          .filter((block: any): block is ToolResultBlock => block.type === "tool_result")
          .map((block) => ({
            type: "tool-result" as const,
            toolCallId: block.toolUseId,
            toolName: block.name || "unknown",
            output: mapToolResultContent(block.content, block.isError),
          }));

        if (toolResults.length > 0) {
          messages.push({ role: "tool", content: toolResults } as any);
        }
      }
    }
  }

  // Convert tools to ToolSet (definitions only, no execute)
  const toolSet: ToolSet | undefined =
    tools && tools.length > 0
      ? tools.reduce((acc, tool) => {
          if ("metadata" in tool) {
            acc[tool.metadata.name] = {
              description: tool.metadata.description,
              parameters: tool.metadata.input, // AI SDK expects 'parameters'
            } as any;
          }
          return acc;
        }, {} as ToolSet)
      : undefined;

  return {
    messages,
    tools: toolSet,
    system,
    model: extractedModel,
    tick,
  };
}
