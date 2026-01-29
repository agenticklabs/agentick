import {
  GoogleGenAI,
  GenerateContentResponse,
  type GenerateContentParameters,
  FinishReason,
} from "@google/genai";

import {
  type EngineModel,
  createLanguageModel,
  type ModelInput,
  type ModelOutput,
} from "@tentickle/core/model";
import { Logger } from "@tentickle/core/core";
import { normalizeModelInput } from "@tentickle/core/utils";
import type { ToolDefinition } from "@tentickle/core/tool";

import {
  type ContentBlock,
  type Message,
  type TextBlock,
  type StreamEvent,
  type ModelStreamEvent,
  type StreamEventBase,
  type ContentDeltaEvent,
  isModelStreamEvent,
  BlockType,
  StopReason,
  AdapterError,
  ValidationError,
} from "@tentickle/shared";
import { type GoogleAdapterConfig, STOP_REASON_MAP } from "./types";

export type GoogleAdapter = EngineModel<ModelInput, ModelOutput>;

const logger = Logger.for("GoogleAdapter");

// ============================================================================
// Event ID Generation
// ============================================================================

let adapterEventIdCounter = 0;
let adapterSequenceCounter = 0;

function generateAdapterEventId(): string {
  return `gevt_${Date.now()}_${++adapterEventIdCounter}`;
}

function createAdapterEventBase(): StreamEventBase {
  return {
    id: generateAdapterEventId(),
    tick: 1, // Default tick, engine will override
    sequence: ++adapterSequenceCounter,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Factory function for creating Google model adapter using createModel
 */
export function createGoogleModel(config: GoogleAdapterConfig = {}): GoogleAdapter {
  const client = config.client ?? new GoogleGenAI(buildClientOptions(config));

  return createLanguageModel<
    ModelInput,
    ModelOutput,
    GenerateContentParameters,
    GenerateContentResponse,
    GenerateContentResponse
  >({
    metadata: {
      id: "google",
      provider: "google",
      model: config.model,
      type: "language" as const,
      capabilities: [
        { stream: true, toolCalls: true, provider: "google" },
        {
          // Google models work best with markdown and user role
          messageTransformation: (_modelId: string, _provider?: string) => ({
            preferredRenderer: "markdown",
            roleMapping: {
              event: "user",
              ephemeral: "user",
            },
            delimiters: {
              useDelimiters: true,
              event: "[Event]",
              ephemeral: "[Context]",
            },
            ephemeralPosition: "flow",
          }),
        },
      ],
    },
    transformers: {
      prepareInput: (input) => prepareInput(input, config),
      processOutput,
      processChunk,
      processStream: processStreamChunks,
    },
    executors: {
      execute: (params) => execute(client, params),
      executeStream: (params) => executeStream(client, params),
    },
  });
}

/**
 * Factory function for creating Google adapter (alias for createGoogleModel)
 */
export function google(config?: GoogleAdapterConfig): GoogleAdapter {
  return createGoogleModel(config);
}

// ============================================================================
// Helper Functions (exported for testing)
// ============================================================================

export function buildClientOptions(config: GoogleAdapterConfig): any {
  const options: any = {};

  // Authentication
  if (config.apiKey) {
    options.apiKey = config.apiKey;
  }

  if (config.vertexai) {
    options.vertexai = true;
    if (config.project) options.project = config.project;
    if (config.location) options.location = config.location;
  }

  // HTTP options
  if (config.timeout || config.baseUrl) {
    options.httpOptions = {};
    if (config.timeout) options.httpOptions.timeout = config.timeout;
    if (config.baseUrl) options.httpOptions.baseUrl = config.baseUrl;
  }

  // Google Auth options
  if (config.googleAuthOptions) {
    options.googleAuthOptions = config.googleAuthOptions;
  }

  if (config.providerOptions?.google) {
    Object.assign(options, config.providerOptions.google);
  }

  return options;
}

/**
 * Map Google FinishReason to normalized StopReason
 */
export function mapGoogleFinishReason(finishReason: FinishReason | undefined): StopReason {
  return finishReason ? STOP_REASON_MAP[finishReason] || StopReason.STOP : StopReason.STOP;
}

/**
 * Convert ContentBlocks to Google GenAI parts
 */
export function convertBlocksToGoogleParts(blocks: ContentBlock[]): any[] {
  const parts: any[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ text: block.text });
        break;

      case "image":
        if (block.source.type === "url") {
          parts.push({
            fileData: {
              mimeType: block.source.mimeType || "image/jpeg",
              fileUri: block.source.url,
            },
          });
        } else if (block.source.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: block.source.mimeType || "image/jpeg",
              data: block.source.data,
            },
          });
        }
        break;

      case "tool_use":
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input,
          },
        });
        break;

      case "tool_result":
        // Google expects functionResponse for tool results
        // The content is an array of ContentBlocks, extract text from them
        const resultText =
          block.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") || JSON.stringify(block.content);

        parts.push({
          functionResponse: {
            id: block.toolUseId, // The unique call ID to match the function call
            name: block.name, // The function name (matches FunctionDeclaration.name)
            response: { result: resultText },
          },
        });
        break;

      default:
        // Unexpected block type - convert to text as fallback
        // This should rarely happen if fromEngineState is working correctly,
        // but provides graceful degradation for unexpected types
        const blockType = (block as any).type || "unknown";
        const blockText = (block as any).text || JSON.stringify(block, null, 2);
        logger.warn(
          `[Google Adapter] Unexpected block type "${blockType}" - converting to text. This should have been converted by fromEngineState.`,
        );
        parts.push({ text: blockText });
        break;
    }
  }

  return parts;
}

/**
 * Map tool definition to Google format
 */
export function mapToolDefinition(tool: any): any {
  if (typeof tool === "string") {
    return {
      functionDeclarations: [
        {
          name: tool,
          description: "",
          parameters: {},
        },
      ],
    };
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const baseTool = {
      functionDeclarations: [
        {
          name: toolDef.name,
          description: toolDef.description || "",
          parameters: toolDef.input || {}, // Map Tentickle 'input' to Google 'parameters'
        },
      ],
    };

    if (toolDef.providerOptions?.google) {
      const googleConfig = toolDef.providerOptions.google;
      return {
        ...baseTool,
        ...googleConfig,
        functionDeclarations: googleConfig.functionDeclarations || baseTool.functionDeclarations,
      };
    }

    return baseTool;
  }

  // ModelToolReference shape (with metadata)
  const metadata = (tool as any).metadata || tool;
  return {
    functionDeclarations: [
      {
        name: metadata?.id || metadata?.name || "unknown",
        description: metadata?.description || "",
        parameters: metadata?.inputSchema || {},
      },
    ],
  };
}

/**
 * Convert ModelInput to Google GenerateContentParameters
 *
 * Note: The @google/genai SDK uses a flat structure:
 * {
 *   model: string,
 *   contents: Content[],
 *   config?: GenerateContentConfig  // All options go here
 * }
 */
async function prepareInput(
  input: ModelInput,
  config: GoogleAdapterConfig,
): Promise<GenerateContentParameters> {
  const normalizedInput = normalizeModelInput(input, config);
  // Convert messages to Google format
  const contents: any[] = [];
  let systemInstruction: string | undefined;

  for (const message of normalizedInput.messages) {
    if (message.role === "system") {
      // Google handles system messages separately via config.systemInstruction
      systemInstruction = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as TextBlock).text)
        .join("\n\n");
      continue;
    }

    const parts = convertBlocksToGoogleParts(message.content);

    // Skip messages with no parts (would cause Google API error)
    if (parts.length === 0) {
      logger.warn(
        `🔧 [Google] Skipping message with empty parts: role=${message.role}, content types=${message.content.map((c: any) => c.type).join(",")}`,
      );
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  // Build config object (all options go in config for new SDK)
  const generateConfig: any = {
    temperature: normalizedInput.temperature,
    maxOutputTokens: normalizedInput.maxTokens,
    topP: normalizedInput.topP,
    stopSequences: normalizedInput.stop,
  };

  // Add system instruction to config
  if (systemInstruction) {
    generateConfig.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  // Add tools to config
  // Google expects ALL function declarations in a SINGLE tool object
  if (normalizedInput.tools.length > 0) {
    const allFunctionDeclarations = normalizedInput.tools.flatMap((tool) => {
      const mapped = mapToolDefinition(tool.metadata);
      return mapped.functionDeclarations || [];
    });

    generateConfig.tools = [
      {
        functionDeclarations: allFunctionDeclarations,
      },
    ];
  }

  // Clean undefined values from config
  Object.keys(generateConfig).forEach((key) => {
    if (generateConfig[key] === undefined) {
      delete generateConfig[key];
    }
  });

  // Merge provider-specific options if available
  // providerOptions.google can contain any GenerateContentConfig options
  const googleOptions = normalizedInput.providerOptions?.google || {};

  // Extract model override if provided in providerOptions
  const { model: providerModel, ...providerConfigOptions } = googleOptions as any;

  // Merge provider config options into generateConfig
  const finalConfig = {
    ...generateConfig,
    ...providerConfigOptions,
  };

  // Validate contents before building request
  if (contents.length === 0) {
    throw new ValidationError(
      "contents",
      "No valid contents to send to Google. All messages were either system messages or had empty parts.",
    );
  }

  // Build request parameters with new SDK structure
  const requestParams: any = {
    model: providerModel || normalizedInput.model || config.model || "gemini-2.5-flash",
    contents,
    config: finalConfig,
  };

  return requestParams;
}

/**
 * Convert Google GenerateContentResponse to ModelOutput
 */
async function processOutput(output: GenerateContentResponse): Promise<ModelOutput> {
  const candidate = output.candidates?.[0];
  if (!candidate) {
    throw new AdapterError("google", "No candidates in Google response", "ADAPTER_RESPONSE");
  }

  const content: ContentBlock[] = [];

  // Process all parts in the response
  for (const part of candidate.content?.parts || []) {
    if (part.text) {
      // Regular text content
      content.push({
        type: "text",
        text: part.text || "",
      });
    } else if (part.functionCall) {
      // Function calls
      content.push({
        type: "tool_use",
        toolUseId: part.functionCall.name || "",
        name: part.functionCall.name || "",
        input: part.functionCall.args || {},
      });
    }
    // Note: Google supports other part types (inlineData, fileData, etc.) but we focus on core functionality
  }

  const toolCalls = content
    .filter((block) => block.type === "tool_use")
    .map((block: any) => ({
      id: block.toolUseId,
      name: block.name,
      input: block.input,
    }));

  const messages: Message[] = [
    {
      role: "assistant",
      content,
    },
  ];

  return {
    model: output.modelVersion || "unknown",
    createdAt: new Date().toISOString(),
    messages: messages,
    get message() {
      return messages.filter((message) => message.role === "assistant").at(-1);
    },
    stopReason: mapGoogleFinishReason(candidate.finishReason),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: output.usageMetadata
      ? {
          inputTokens: output.usageMetadata.promptTokenCount || 0,
          outputTokens: output.usageMetadata.candidatesTokenCount || 0,
          totalTokens: output.usageMetadata.totalTokenCount || 0,
          reasoningTokens: output.usageMetadata.thoughtsTokenCount || 0,
          cachedInputTokens: output.usageMetadata.cachedContentTokenCount || 0,
        }
      : {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
    raw: output,
  };
}

/**
 * Convert Google streaming chunk to ModelStreamEvent
 */
function processChunk(chunk: any): ModelStreamEvent {
  const base = createAdapterEventBase();
  const candidate = chunk.candidates?.[0];

  if (!candidate) {
    return {
      ...base,
      type: "content_delta",
      blockType: BlockType.TEXT,
      blockIndex: 0,
      delta: "",
      raw: chunk,
    } as ContentDeltaEvent;
  }

  const delta = candidate.content?.parts?.[0];
  if (!delta) {
    return {
      ...base,
      type: "content_delta",
      blockType: BlockType.TEXT,
      blockIndex: 0,
      delta: "",
      raw: chunk,
    } as ContentDeltaEvent;
  }

  // Skip finish_reason chunks (handled in processStream)
  if (candidate.finishReason) {
    return {
      ...base,
      type: "content_delta",
      blockType: BlockType.TEXT,
      blockIndex: 0,
      delta: "",
      raw: chunk,
    } as ContentDeltaEvent;
  }

  // Content delta
  if (delta.text) {
    return {
      ...base,
      type: "content_delta",
      blockType: BlockType.TEXT,
      blockIndex: 0,
      delta: delta.text,
      raw: chunk,
    } as ContentDeltaEvent;
  }

  return {
    ...base,
    type: "content_delta",
    blockType: BlockType.TEXT,
    blockIndex: 0,
    delta: "",
    raw: chunk,
  } as ContentDeltaEvent;
}

/**
 * Aggregate stream events into final ModelOutput
 */
async function processStreamChunks(events: any[] | StreamEvent[]): Promise<ModelOutput> {
  if (events.length === 0) {
    throw new AdapterError("google", "No events to process", "ADAPTER_RESPONSE");
  }

  // Check if events are ModelStreamEvents (from engine) or raw Google chunks
  const isStreamEventType = (event: any): event is ModelStreamEvent => isModelStreamEvent(event);

  // If ModelStreamEvents, we need to reconstruct from raw data
  if (isStreamEventType(events[0])) {
    const googleChunks = events
      .map((e) => (e as ModelStreamEvent).raw)
      .filter((c) => c && typeof c === "object" && "candidates" in c);

    if (googleChunks.length === 0) {
      throw new AdapterError(
        "google",
        "No valid Google chunks found in stream events",
        "ADAPTER_RESPONSE",
      );
    }

    return processStreamChunks(googleChunks);
  }

  // Events are raw Google chunks
  const googleChunks = events as any[];
  const firstChunk = googleChunks[0];
  const lastChunk = googleChunks[googleChunks.length - 1];

  // Find chunk with usage information
  const usageChunk = googleChunks.find((chunk) => chunk.usageMetadata) || lastChunk;

  // Accumulate content
  let accumulatedContent = "";
  const toolCalls: any[] = [];
  let finishReason: FinishReason | undefined;

  for (const chunk of googleChunks) {
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.text) {
        accumulatedContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name || "",
          name: part.functionCall.name || "",
          input: part.functionCall.args || {},
        });
      }
    }

    if (candidate.finishReason) {
      finishReason = candidate.finishReason;
    }
  }

  // Build message content
  const content: ContentBlock[] = [];
  if (accumulatedContent) {
    content.push({ type: "text", text: accumulatedContent });
  }

  // Add tool calls to content
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
    model: firstChunk.modelVersion || "unknown",
    createdAt: new Date().toISOString(),
    messages: messages,
    get message() {
      return messages.filter((message) => message.role === "assistant").at(-1);
    },
    stopReason: finishReason ? mapGoogleFinishReason(finishReason) : StopReason.UNSPECIFIED,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usageChunk.usageMetadata
      ? {
          inputTokens: usageChunk.usageMetadata.promptTokenCount || 0,
          outputTokens: usageChunk.usageMetadata.candidatesTokenCount || 0,
          totalTokens: usageChunk.usageMetadata.totalTokenCount || 0,
          reasoningTokens: usageChunk.usageMetadata.thoughtsTokenCount || 0,
          cachedInputTokens: usageChunk.usageMetadata.cachedContentTokenCount || 0,
        }
      : {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
    raw: googleChunks,
  };
}

// ============================================================================
// Executor Functions
// ============================================================================

/**
 * Execute non-streaming request
 */
async function execute(
  client: GoogleGenAI,
  params: GenerateContentParameters,
): Promise<GenerateContentResponse> {
  // Extract model from params if present, otherwise use default
  const model = (params as any).model || "gemini-1.5-flash";
  const { model: _, ...requestParams } = params as any;

  return await client.models.generateContent({
    model,
    ...requestParams,
  });
}

/**
 * Execute streaming request
 */
async function* executeStream(
  client: GoogleGenAI,
  params: GenerateContentParameters,
): AsyncIterable<any> {
  // Extract model from params if present, otherwise use default
  const model = (params as any).model || "gemini-1.5-flash";
  const { model: _, ...requestParams } = params as any;

  logger.debug("🔧 [Google] executeStream - model:", model);
  const toolNames =
    requestParams.config?.tools?.[0]?.functionDeclarations?.map((f: any) => f.name) || [];
  logger.debug("🔧 [Google] executeStream - tools:", toolNames);
  // logger.debug('🔧 [Google] executeStream - full request:', JSON.stringify({ model, ...requestParams }, null, 2));

  try {
    const stream = await client.models.generateContentStream({
      model,
      ...requestParams,
    });

    let hasToolCalls = false;
    for await (const chunk of stream) {
      // Debug: Check for function calls in response
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          hasToolCalls = true;
          logger.debug("🔧 [Google] FUNCTION CALL:", JSON.stringify(part.functionCall, null, 2));
        }
      }
      if (chunk.candidates?.[0]?.finishReason) {
        logger.debug(
          "🔧 [Google] finishReason:",
          chunk.candidates[0].finishReason,
          "hasToolCalls:",
          hasToolCalls,
        );
      }
      yield chunk;
    }
  } catch (error) {
    logger.error("🔧 [Google] Error executing stream:", error);
    throw error;
  }
}
