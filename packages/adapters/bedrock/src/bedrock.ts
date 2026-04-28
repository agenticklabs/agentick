/**
 * AWS Bedrock Adapter
 *
 * Native AWS Bedrock Converse API adapter for use with the engine.
 * Uses createAdapter for minimal boilerplate.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock as BedrockContentBlock,
  type Message as BedrockMessage,
  type SystemContentBlock,
  type Tool,
  type ToolSpecification,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

import {
  createAdapter,
  type AdapterDelta,
  type ModelClass,
  type ModelInput,
  type ModelOutput,
} from "@agentick/core/model";
import { normalizeModelInput } from "@agentick/core/utils";
import type { ToolDefinition } from "@agentick/core/tool";
import {
  type ContentBlock,
  type Message,
  type TextBlock,
  StopReason,
  AdapterError,
} from "@agentick/shared";
import { type BedrockAdapterConfig, STOP_REASON_MAP } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Internal state for tracking tool calls during streaming */
interface ToolCallState {
  id: string;
  name: string;
}

// Stream events are typed as `any` — Bedrock's event shapes are discriminated
// unions where each event has a single key set (messageStart, contentBlockDelta, etc.).
// We handle all shapes in mapBedrockStreamChunk with runtime checks.

// ============================================================================
// Factory Function
// ============================================================================

export function createBedrockModel(config: BedrockAdapterConfig = {}): ModelClass {
  const client = config.client ?? buildClient(config);

  // Stateful tracking of tool calls by content block index (reset per stream)
  let toolCallState = new Map<number, ToolCallState>();

  return createAdapter<ConverseCommandInput, ConverseCommandOutput, any>({
    metadata: {
      id: "bedrock",
      provider: "bedrock",
      model: config.model,
      type: "language" as const,
      capabilities: [
        {
          stream: true,
          toolCalls: true,
          provider: "bedrock",
          messageTransformation: () => ({
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

    prepareInput: async (input: ModelInput) => {
      const normalizedInput = await normalizeModelInput(input, config);

      const { system, messages } = toBedrockMessages(normalizedInput.messages);

      const tools =
        normalizedInput.tools.length > 0
          ? normalizedInput.tools.map((tool) => mapToolDefinition(tool.metadata))
          : [];

      const inferenceConfig: Record<string, unknown> = {
        maxTokens: normalizedInput.maxTokens ?? config.maxTokens ?? 4096,
        temperature: normalizedInput.temperature,
        topP: normalizedInput.topP,
        stopSequences: normalizedInput.stop
          ? Array.isArray(normalizedInput.stop)
            ? normalizedInput.stop
            : [normalizedInput.stop]
          : undefined,
      };

      // Clean undefined values from inferenceConfig
      Object.keys(inferenceConfig).forEach((key) => {
        if (inferenceConfig[key] === undefined) {
          delete inferenceConfig[key];
        }
      });

      const params: ConverseCommandInput = {
        modelId: normalizedInput.model as string,
        messages,
        system: system.length > 0 ? system : undefined,
        inferenceConfig,
        toolConfig: tools.length > 0 ? ({ tools: tools } as ToolConfiguration) : undefined,
      };

      // Clean undefined top-level values
      Object.keys(params).forEach((key) => {
        if ((params as any)[key] === undefined) {
          delete (params as any)[key];
        }
      });

      // providerOptions.bedrock spreads AFTER for user override
      if (normalizedInput.providerOptions?.bedrock) {
        return { ...params, ...normalizedInput.providerOptions.bedrock } as ConverseCommandInput;
      }

      return params;
    },

    mapChunk: (event: any): AdapterDelta | AdapterDelta[] | null => {
      return mapBedrockStreamChunk(event, toolCallState);
    },

    processOutput: async (output: ConverseCommandOutput): Promise<ModelOutput> => {
      return processConverseOutput(output);
    },

    execute: async (params) => {
      return await client.send(new ConverseCommand(params));
    },

    executeStream: async function* (params) {
      toolCallState = new Map();

      const response = await client.send(new ConverseStreamCommand(params as any));
      if (response.stream) {
        for await (const event of response.stream) {
          yield event;
        }
      }
    },

    reconstructRaw: (accumulated) => {
      // Map internal stop reason to Bedrock stopReason
      const stopReason = (() => {
        switch (accumulated.stopReason) {
          case StopReason.STOP:
            return "end_turn";
          case StopReason.MAX_TOKENS:
            return "max_tokens";
          case StopReason.TOOL_USE:
            return "tool_use";
          case StopReason.CONTENT_FILTER:
            return "content_filtered";
          default:
            return "end_turn";
        }
      })();

      // Build content array from accumulated data
      const content: BedrockContentBlock[] = [];

      if (accumulated.text) {
        content.push({ text: accumulated.text });
      }

      for (const tc of accumulated.toolCalls) {
        content.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: tc.input as any,
          },
        });
      }

      const reconstructed: ConverseCommandOutput = {
        output: {
          message: {
            role: "assistant",
            content,
          },
        },
        stopReason,
        usage: {
          inputTokens: accumulated.usage.inputTokens,
          outputTokens: accumulated.usage.outputTokens,
          totalTokens: accumulated.usage.totalTokens,
        },
        metrics: undefined,
        $metadata: {},
      };

      return reconstructed;
    },

    // Forward application-level options to createAdapter
    customBlocks: config.customBlocks as BedrockAdapterConfig["customBlocks"],
    deltaTransform: config.deltaTransform as BedrockAdapterConfig["deltaTransform"],
  });
}

/**
 * Convenience factory for creating Bedrock model.
 *
 * Returns a ModelClass that can be used as:
 * - JSX component: `<model><Agent /></model>`
 * - App config: `createApp(Agent, { model })`
 * - Direct calls: `await model.generate(input)`
 *
 * @example
 * ```typescript
 * const model = bedrock({ model: 'us.anthropic.claude-sonnet-4-20250514-v1:0' });
 *
 * // As JSX
 * <model><MyAgent /></model>
 *
 * // With createApp
 * const app = createApp(MyAgent, { model });
 * ```
 */
export function bedrock(configOrModel?: string | BedrockAdapterConfig): ModelClass {
  if (typeof configOrModel === "string") {
    return createBedrockModel({ model: configOrModel });
  }
  return createBedrockModel(configOrModel);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build a BedrockRuntimeClient from config.
 */
export function buildClient(config: BedrockAdapterConfig): BedrockRuntimeClient {
  const clientConfig: Record<string, unknown> = {
    region:
      config.region ??
      process.env["AWS_REGION"] ??
      process.env["AWS_DEFAULT_REGION"] ??
      "us-east-1",
  };

  if (config.credentials) {
    clientConfig.credentials = config.credentials;
  }

  if (config.profile) {
    // AWS SDK picks up AWS_PROFILE from env, but explicit profile in config
    // can be set via the credential provider chain
    clientConfig.profile = config.profile;
  }

  return new BedrockRuntimeClient(clientConfig);
}

/**
 * Extract image format from MIME type.
 * Bedrock accepts: "png", "jpeg", "gif", "webp"
 */
function mimeToFormat(mimeType: string): "png" | "jpeg" | "gif" | "webp" {
  const mime = mimeType.toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  // Default to jpeg for jpg, jpeg, and anything else
  return "jpeg";
}

/**
 * Convert Agentick Messages to Bedrock format.
 * Returns both system blocks and conversation messages.
 */
export function toBedrockMessages(messages: Message[]): {
  system: SystemContentBlock[];
  messages: BedrockMessage[];
} {
  const system: SystemContentBlock[] = [];
  const bedrockMessages: BedrockMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      // System messages → system content blocks
      for (const block of message.content) {
        if (block.type === "text") {
          system.push({ text: block.text });
        }
      }
      continue;
    }

    const content: BedrockContentBlock[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          content.push({ text: block.text });
          break;

        case "image":
          if (block.source.type === "base64") {
            const format = mimeToFormat(block.source.mimeType ?? block.mimeType ?? "image/jpeg");
            content.push({
              image: {
                format,
                source: {
                  bytes: new Uint8Array(Buffer.from(block.source.data, "base64")),
                },
              },
            });
          } else if (block.source.type === "url") {
            const url = block.source.url;
            // S3 URLs can be passed as s3Location
            if (url.startsWith("s3://")) {
              const format = mimeToFormat(block.source.mimeType ?? block.mimeType ?? "image/jpeg");
              content.push({
                image: {
                  format,
                  source: {
                    s3Location: { uri: url },
                  },
                },
              } as any);
            }
            // Non-S3 URLs: Bedrock doesn't natively support URL images,
            // skip for now (caller should download and pass as base64)
          }
          break;

        case "document":
          if ((block as any).source?.bytes) {
            content.push({
              document: {
                format: (block as any).format ?? "pdf",
                name: (block as any).name ?? "document",
                source: {
                  bytes: (block as any).source.bytes,
                },
              },
            });
          }
          break;

        case "tool_use":
          content.push({
            toolUse: {
              toolUseId: block.toolUseId,
              name: block.name,
              input: (block.input ?? {}) as any,
            },
          });
          break;

        case "tool_result": {
          const resultContent = block.content;
          let resultText: string;

          if (resultContent == null) {
            resultText = "Done";
          } else if (typeof resultContent === "string") {
            resultText = resultContent;
          } else if (Array.isArray(resultContent)) {
            resultText =
              resultContent
                .filter((c: any) => c.type === "text")
                .map((c: any) => (c as TextBlock).text)
                .join("\n") || "Done";
          } else {
            resultText = JSON.stringify(resultContent);
          }

          content.push({
            toolResult: {
              toolUseId: block.toolUseId,
              content: [{ text: resultText }],
              status: block.isError ? "error" : "success",
            },
          });
          break;
        }

        default: {
          // Fallback: serialize unknown blocks as text
          const blockText = (block as any).text || JSON.stringify(block, null, 2);
          content.push({ text: blockText });
          break;
        }
      }
    }

    if (content.length > 0) {
      bedrockMessages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content,
      });
    }
  }

  return { system, messages: bedrockMessages };
}

/**
 * Map a tool definition to Bedrock toolConfig format.
 */
export function mapToolDefinition(tool: any): Tool {
  if (typeof tool === "string") {
    return {
      toolSpec: {
        name: tool,
        description: "",
        inputSchema: { json: {} as any },
      },
    };
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const spec: ToolSpecification = {
      name: toolDef.name ?? "unknown",
      description: toolDef.description || "",
      inputSchema: { json: (toolDef.input ?? {}) as any },
    };

    if (toolDef.providerOptions?.bedrock) {
      const bedrockConfig = toolDef.providerOptions.bedrock;
      return {
        ...bedrockConfig,
        toolSpec: {
          ...spec,
          ...(bedrockConfig.toolSpec || {}),
        },
      } as Tool;
    }

    return { toolSpec: spec };
  }

  // ModelToolReference (with metadata) or raw object
  const metadata = (tool as any).metadata || tool;
  const rawSchema = metadata?.inputSchema ?? metadata?.input;
  return {
    toolSpec: {
      name: metadata?.id || metadata?.name || "unknown",
      description: metadata?.description || "",
      inputSchema: { json: (rawSchema ?? {}) as any },
    },
  };
}

/**
 * Map a Bedrock ConverseStream event to AdapterDelta(s).
 *
 * Bedrock stream events are discriminated unions — each event object has ONE key set:
 * messageStart, contentBlockStart, contentBlockDelta, contentBlockStop, messageStop, metadata.
 */
export function mapBedrockStreamChunk(
  event: any,
  toolCallState: Map<number, ToolCallState>,
): AdapterDelta | AdapterDelta[] | null {
  // messageStart — beginning of the response message
  if (event.messageStart) {
    return { type: "message_start", model: event.messageStart.role };
  }

  // contentBlockStart — new content block beginning
  if (event.contentBlockStart) {
    const index = event.contentBlockStart.contentBlockIndex ?? 0;

    const start = event.contentBlockStart.start;
    if (start?.toolUse) {
      // Tool use block starting
      toolCallState.set(index, {
        id: start.toolUse.toolUseId ?? "",
        name: start.toolUse.name ?? "",
      });
      return {
        type: "tool_call_start",
        id: start.toolUse.toolUseId ?? "",
        name: start.toolUse.name ?? "",
      };
    }

    // Text block starting — no delta to emit yet
    return null;
  }

  // contentBlockDelta — incremental content
  if (event.contentBlockDelta) {
    const index = event.contentBlockDelta.contentBlockIndex ?? 0;
    const delta = event.contentBlockDelta.delta;

    if (delta?.text) {
      return { type: "text", delta: delta.text };
    }

    if (delta?.toolUse) {
      const tracked = toolCallState.get(index);
      return {
        type: "tool_call_delta",
        id: tracked?.id ?? "",
        delta: delta.toolUse.input ?? "",
      };
    }

    return null;
  }

  // contentBlockStop — content block finished
  if (event.contentBlockStop != null) {
    const index =
      typeof event.contentBlockStop === "object"
        ? (event.contentBlockStop.contentBlockIndex ?? 0)
        : 0;

    if (toolCallState.has(index)) {
      const tracked = toolCallState.get(index)!;
      toolCallState.delete(index);
      return { type: "tool_call_end", id: tracked.id, input: {} };
    }

    return null;
  }

  // messageStop — end of the response message
  if (event.messageStop) {
    const stopReason = event.messageStop.stopReason ?? "end_turn";
    return {
      type: "message_end",
      stopReason: STOP_REASON_MAP[stopReason] ?? StopReason.OTHER,
    };
  }

  // metadata — usage statistics
  if (event.metadata) {
    const usage = event.metadata.usage;
    if (usage) {
      return {
        type: "usage",
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        },
      };
    }
    return null;
  }

  return null;
}

/**
 * Process a non-streaming ConverseCommand output into ModelOutput.
 */
export function processConverseOutput(output: ConverseCommandOutput): ModelOutput {
  const message = output.output?.message;
  if (!message) {
    throw new AdapterError("bedrock", "No message in Bedrock response", "ADAPTER_RESPONSE");
  }

  const content: ContentBlock[] = [];
  const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];

  for (const block of message.content ?? []) {
    if (block.text) {
      content.push({ type: "text", text: block.text });
    } else if (block.toolUse) {
      const toolUseId = block.toolUse.toolUseId ?? "";
      const name = block.toolUse.name ?? "";
      const input = (block.toolUse.input ?? {}) as Record<string, unknown>;

      content.push({
        type: "tool_use",
        toolUseId,
        name,
        input,
      });

      toolCalls.push({ id: toolUseId, name, input });
    }
  }

  const messages: Message[] = [{ role: "assistant", content }];

  return {
    model: output.$metadata?.requestId ?? "bedrock",
    createdAt: new Date().toISOString(),
    messages,
    get message() {
      return messages.filter((m) => m.role === "assistant").at(-1);
    },
    stopReason: output.stopReason
      ? (STOP_REASON_MAP[output.stopReason] ?? StopReason.OTHER)
      : StopReason.UNSPECIFIED,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: output.usage
      ? {
          inputTokens: output.usage.inputTokens ?? 0,
          outputTokens: output.usage.outputTokens ?? 0,
          totalTokens: (output.usage.inputTokens ?? 0) + (output.usage.outputTokens ?? 0),
          reasoningTokens: 0,
          cachedInputTokens: output.usage.cacheReadInputTokens ?? 0,
          cacheCreationTokens:
            output.usage.cacheDetails
              ?.map((detail) => detail.inputTokens || 0)
              .reduce((a, b) => a + b, 0) ?? 0,
        }
      : {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
    raw: output,
  };
}
