/**
 * Anthropic Adapter
 *
 * Native Anthropic API adapter for use with the engine.
 * Uses createAdapter for minimal boilerplate.
 */

import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageCreateParams,
  RawMessageStreamEvent,
  TextBlock as AnthropicTextBlock,
  ToolUseBlock as AnthropicToolUseBlock,
  ThinkingBlock as AnthropicThinkingBlock,
  ContentBlock as AnthropicContentBlock,
} from "@anthropic-ai/sdk/resources/messages";

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
  type Message,
  type ContentBlock,
  type TextBlock,
  StopReason,
  AdapterError,
} from "@agentick/shared";
import { type AnthropicAdapterConfig, STOP_REASON_MAP } from "./types.js";

// ============================================================================
// Streaming State
// ============================================================================

/** State tracked per content block during streaming */
interface StreamBlockState {
  type: "tool_use" | "text" | "thinking";
  id: string;
  name: string;
  jsonBuffer: string;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Map an Anthropic streaming event to AdapterDelta(s).
 * Extracted for testability — the block state map is passed in.
 */
export function mapAnthropicChunk(
  event: RawMessageStreamEvent,
  blockState: Map<number, StreamBlockState>,
): AdapterDelta | AdapterDelta[] | null {
  switch (event.type) {
    case "message_start": {
      const deltas: AdapterDelta[] = [{ type: "message_start", model: event.message.model }];
      if (event.message.usage) {
        deltas.push({
          type: "usage",
          usage: {
            inputTokens: event.message.usage.input_tokens ?? 0,
          },
        });
      }
      return deltas.length === 1 ? deltas[0] : deltas;
    }

    case "content_block_start": {
      const index = event.index;
      const block = event.content_block;

      if (block.type === "tool_use") {
        blockState.set(index, {
          type: "tool_use",
          id: block.id,
          name: block.name,
          jsonBuffer: "",
        });
        return {
          type: "tool_call_start",
          id: block.id,
          name: block.name,
        };
      }

      if (block.type === "thinking") {
        blockState.set(index, {
          type: "thinking",
          id: "",
          name: "",
          jsonBuffer: "",
        });
        return null;
      }

      // text block
      blockState.set(index, {
        type: "text",
        id: "",
        name: "",
        jsonBuffer: "",
      });
      return null;
    }

    case "content_block_delta": {
      const index = event.index;
      const delta = event.delta;

      if (delta.type === "text_delta") {
        return { type: "text", delta: delta.text };
      }

      if (delta.type === "input_json_delta") {
        const state = blockState.get(index);
        if (state) {
          state.jsonBuffer += delta.partial_json;
        }
        return {
          type: "tool_call_delta",
          id: state?.id || "",
          delta: delta.partial_json,
        };
      }

      if (delta.type === "thinking_delta") {
        return { type: "reasoning", delta: (delta as any).thinking };
      }

      return null;
    }

    case "content_block_stop": {
      const index = event.index;
      const state = blockState.get(index);

      if (state?.type === "tool_use") {
        let input: unknown;
        try {
          input = state.jsonBuffer ? JSON.parse(state.jsonBuffer) : {};
        } catch {
          input = state.jsonBuffer;
        }
        blockState.delete(index);
        return {
          type: "tool_call_end",
          id: state.id,
          input,
        };
      }

      blockState.delete(index);
      return null;
    }

    case "message_delta": {
      const stopReason = (event.delta as any).stop_reason;
      return {
        type: "message_end",
        stopReason: stopReason
          ? (STOP_REASON_MAP[stopReason] ?? StopReason.OTHER)
          : StopReason.UNSPECIFIED,
        usage: event.usage
          ? {
              inputTokens: 0,
              totalTokens: event.usage.output_tokens,
              outputTokens: event.usage.output_tokens ?? 0,
            }
          : undefined,
      };
    }

    case "message_stop":
      return null;

    default:
      return null;
  }
}

/**
 * Factory function for creating Anthropic model adapter.
 *
 * Returns a ModelClass that can be used both programmatically and as JSX.
 */
export function createAnthropicModel(config: AnthropicAdapterConfig = {}): ModelClass {
  const client = config.client ?? new Anthropic(buildClientOptions(config));

  // Stateful tracking of content blocks during streaming (reset per stream)
  let blockState = new Map<number, StreamBlockState>();

  return createAdapter<MessageCreateParams, AnthropicMessage, RawMessageStreamEvent>({
    metadata: {
      id: "anthropic",
      provider: "anthropic",
      model: config.model,
      type: "language" as const,
      capabilities: [
        { stream: true, toolCalls: true, provider: "anthropic" },
        {
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

    prepareInput: async (input: ModelInput) => {
      const normalizedInput = await normalizeModelInput(input, config);
      const { system, messages } = toAnthropicMessages(normalizedInput.messages);

      const tools =
        normalizedInput.tools.length > 0
          ? normalizedInput.tools.map((tool) => mapToolDefinition(tool.metadata))
          : undefined;

      const baseParams: MessageCreateParams = {
        model: normalizedInput.model as string,
        messages,
        max_tokens: normalizedInput.maxTokens ?? config.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        ...(normalizedInput.temperature !== undefined
          ? { temperature: normalizedInput.temperature }
          : {}),
        ...(normalizedInput.topP !== undefined ? { top_p: normalizedInput.topP } : {}),
        ...(normalizedInput.stop
          ? {
              stop_sequences: Array.isArray(normalizedInput.stop)
                ? normalizedInput.stop
                : [normalizedInput.stop],
            }
          : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      };

      // Clean undefined values
      Object.keys(baseParams).forEach((key) => {
        if ((baseParams as any)[key] === undefined) {
          delete (baseParams as any)[key];
        }
      });

      // providerOptions.anthropic spreads AFTER for user override
      if (normalizedInput.providerOptions?.anthropic) {
        return { ...baseParams, ...normalizedInput.providerOptions.anthropic };
      }

      return baseParams;
    },

    mapChunk: (event: RawMessageStreamEvent): AdapterDelta | AdapterDelta[] | null => {
      return mapAnthropicChunk(event, blockState);
    },

    processOutput: async (output: AnthropicMessage): Promise<ModelOutput> => {
      if (!output.content || output.content.length === 0) {
        throw new AdapterError("anthropic", "No content in Anthropic response", "ADAPTER_RESPONSE");
      }

      const content: ContentBlock[] = [];
      const toolCalls: any[] = [];

      for (const block of output.content) {
        switch (block.type) {
          case "text":
            content.push({ type: "text", text: (block as AnthropicTextBlock).text });
            break;

          case "tool_use": {
            const toolBlock = block as AnthropicToolUseBlock;
            content.push({
              type: "tool_use",
              toolUseId: toolBlock.id,
              name: toolBlock.name,
              input: toolBlock.input as Record<string, unknown>,
            });
            toolCalls.push({
              id: toolBlock.id,
              name: toolBlock.name,
              input: toolBlock.input,
            });
            break;
          }

          case "thinking": {
            const thinkBlock = block as AnthropicThinkingBlock;
            content.push({ type: "reasoning", text: thinkBlock.thinking } as any);
            break;
          }

          default: {
            const blockText = (block as any).text || JSON.stringify(block, null, 2);
            content.push({ type: "text", text: blockText });
            break;
          }
        }
      }

      const messages: Message[] = [{ role: "assistant", content }];

      return {
        model: output.model,
        createdAt: new Date().toISOString(),
        messages,
        get message() {
          return messages.filter((m) => m.role === "assistant").at(-1);
        },
        stopReason: output.stop_reason
          ? (STOP_REASON_MAP[output.stop_reason] ?? StopReason.OTHER)
          : StopReason.UNSPECIFIED,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: output.usage?.input_tokens ?? 0,
          outputTokens: output.usage?.output_tokens ?? 0,
          totalTokens: (output.usage?.input_tokens ?? 0) + (output.usage?.output_tokens ?? 0),
          reasoningTokens: 0,
          cachedInputTokens: (output.usage as any)?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: (output.usage as any)?.cache_creation_input_tokens ?? 0,
        },
        raw: output,
      };
    },

    execute: async (params) => {
      return await client.messages.create({
        ...params,
        stream: false,
      } as Anthropic.MessageCreateParamsNonStreaming);
    },

    executeStream: async function* (params) {
      blockState = new Map();

      const stream = client.messages.stream({
        ...params,
      } as Anthropic.MessageCreateParamsStreaming);

      for await (const event of stream) {
        yield event;
      }
    },

    reconstructRaw: (accumulated) => {
      // Reconstruct an Anthropic Message-like response from streaming data
      const contentBlocks: AnthropicContentBlock[] = [];

      // Add text content
      if (accumulated.text) {
        contentBlocks.push({
          type: "text",
          text: accumulated.text,
        } as AnthropicTextBlock);
      }

      // Add reasoning content
      if (accumulated.reasoning) {
        contentBlocks.push({
          type: "thinking",
          thinking: accumulated.reasoning,
        } as any);
      }

      // Add tool use blocks
      for (const tc of accumulated.toolCalls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        } as AnthropicToolUseBlock);
      }

      // Map internal stop reason to Anthropic stop_reason
      const stopReason = (() => {
        switch (accumulated.stopReason) {
          case StopReason.STOP:
            return "end_turn" as const;
          case StopReason.MAX_TOKENS:
            return "max_tokens" as const;
          case StopReason.TOOL_USE:
            return "tool_use" as const;
          default:
            return "end_turn" as const;
        }
      })();

      const reconstructed: AnthropicMessage = {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: accumulated.model || "unknown",
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: accumulated.usage.inputTokens,
          output_tokens: accumulated.usage.outputTokens,
          cache_read_input_tokens: accumulated.usage.cachedInputTokens ?? 0,
          cache_creation_input_tokens: accumulated.usage.cacheCreationTokens ?? 0,
        },
      };

      return reconstructed;
    },

    // Forward application-level options to createAdapter
    customBlocks: config.customBlocks as AnthropicAdapterConfig["customBlocks"],
    deltaTransform: config.deltaTransform as AnthropicAdapterConfig["deltaTransform"],
  });
}

/**
 * Convenience factory for creating Anthropic model.
 *
 * Returns a ModelClass that can be used as:
 * - JSX component: `<model><Agent /></model>`
 * - App config: `createApp(Agent, { model })`
 * - Direct calls: `await model.generate(input)`
 *
 * @example
 * ```typescript
 * const model = anthropic('claude-sonnet-4-20250514');
 *
 * // As JSX
 * <model><MyAgent /></model>
 *
 * // With createApp
 * const app = createApp(MyAgent, { model });
 * ```
 */
export function anthropic(configOrModel?: string | AnthropicAdapterConfig): ModelClass {
  if (typeof configOrModel === "string") {
    return createAnthropicModel({ model: configOrModel });
  }
  return createAnthropicModel(configOrModel);
}

// ============================================================================
// Helper Functions
// ============================================================================

export function buildClientOptions(config: AnthropicAdapterConfig): ClientOptions {
  const options: ClientOptions = {
    apiKey: config.apiKey ?? process.env["ANTHROPIC_API_KEY"],
    baseURL: config.baseURL ?? process.env["ANTHROPIC_BASE_URL"],
    defaultHeaders: config.headers,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    ...(config.providerOptions?.anthropic || {}),
  };

  Object.keys(options).forEach((key) => {
    if ((options as any)[key] === undefined) {
      delete (options as any)[key];
    }
  });

  return options;
}

/**
 * Convert Agentick Messages to Anthropic format.
 *
 * Anthropic requires:
 * - System messages extracted to a separate `system` parameter
 * - Strict user/assistant alternation (consecutive same-role messages must be coalesced)
 * - Specific content block formats for images, documents, tool_use, tool_result, thinking
 */
export function toAnthropicMessages(messages: Message[]): {
  system: string | undefined;
  messages: Anthropic.MessageCreateParams["messages"];
} {
  const systemParts: string[] = [];
  const anthropicMessages: Anthropic.MessageCreateParams["messages"] = [];

  for (const message of messages) {
    // Extract system messages
    if (message.role === "system") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as TextBlock).text)
        .join("\n\n");
      if (text) systemParts.push(text);
      continue;
    }

    // Map role: Anthropic only supports "user" and "assistant"
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";

    // Convert content blocks
    const content: any[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: block.text });
          break;

        case "image":
          if (block.source.type === "base64") {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: block.source.mimeType ?? block.mimeType ?? "image/png",
                data: block.source.data,
              },
            });
          } else if (block.source.type === "url") {
            content.push({
              type: "image",
              source: {
                type: "url",
                url: block.source.url,
              },
            });
          }
          break;

        case "document":
          if ((block as any).source?.type === "base64") {
            content.push({
              type: "document",
              source: {
                type: "base64",
                media_type: (block as any).source.mimeType ?? "application/pdf",
                data: (block as any).source.data,
              },
            });
          }
          break;

        case "tool_use":
          content.push({
            type: "tool_use",
            id: block.toolUseId,
            name: block.name,
            input: block.input,
          });
          break;

        case "tool_result": {
          const resultContent = block.content;
          const resultParts: any[] = [];

          if (resultContent == null) {
            resultParts.push({ type: "text", text: "Done" });
          } else if (typeof resultContent === "string") {
            resultParts.push({ type: "text", text: resultContent });
          } else if (Array.isArray(resultContent)) {
            if (resultContent.length === 0) {
              resultParts.push({ type: "text", text: "Done" });
            } else {
              for (const c of resultContent) {
                if (c.type === "text") {
                  resultParts.push({ type: "text", text: (c as TextBlock).text });
                } else if (c.type === "image") {
                  const imgBlock = c as any;
                  if (imgBlock.source?.type === "base64") {
                    resultParts.push({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: imgBlock.source.mimeType ?? imgBlock.mimeType ?? "image/png",
                        data: imgBlock.source.data,
                      },
                    });
                  }
                } else {
                  resultParts.push({
                    type: "text",
                    text: JSON.stringify(c),
                  });
                }
              }
            }
          } else {
            resultParts.push({ type: "text", text: JSON.stringify(resultContent) });
          }

          content.push({
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: resultParts,
          });
          break;
        }

        case "reasoning":
          content.push({
            type: "thinking",
            thinking: (block as any).text,
          });
          break;

        default: {
          const blockText = (block as any).text || JSON.stringify(block, null, 2);
          content.push({ type: "text", text: blockText });
          break;
        }
      }
    }

    if (content.length === 0) continue;

    // Enforce strict user/assistant alternation: coalesce consecutive same-role messages
    const lastMessage = anthropicMessages[anthropicMessages.length - 1];
    if (lastMessage && lastMessage.role === role) {
      // Coalesce: append content to the previous message
      const prevContent = lastMessage.content;
      if (Array.isArray(prevContent)) {
        (prevContent as any[]).push(...content);
      } else if (typeof prevContent === "string") {
        // Convert string to array format
        lastMessage.content = [{ type: "text", text: prevContent }, ...content] as any;
      }
    } else {
      anthropicMessages.push({
        role,
        content,
      } as any);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

/**
 * Map tool definition to Anthropic format
 */
export function mapToolDefinition(tool: any): Anthropic.Tool {
  if (typeof tool === "string") {
    return {
      name: tool,
      description: "",
      input_schema: { type: "object" as const },
    } as Anthropic.Tool;
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const baseTool: Anthropic.Tool = {
      name: toolDef.name,
      description: toolDef.description || "",
      input_schema: (toolDef.input || { type: "object" }) as Anthropic.Tool["input_schema"],
    };

    if (toolDef.providerOptions?.anthropic) {
      return {
        ...baseTool,
        ...toolDef.providerOptions.anthropic,
      } as Anthropic.Tool;
    }

    return baseTool;
  }

  const metadata = (tool as any).metadata || tool;
  const rawSchema = metadata?.inputSchema ?? metadata?.input;
  return {
    name: metadata?.id || metadata?.name || "unknown",
    description: metadata?.description || "",
    input_schema: (rawSchema || { type: "object" }) as Anthropic.Tool["input_schema"],
  } as Anthropic.Tool;
}
