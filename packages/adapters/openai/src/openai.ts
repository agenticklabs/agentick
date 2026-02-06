/**
 * OpenAI Adapter
 *
 * Native OpenAI API adapter for use with the engine.
 * Uses createAdapter for minimal boilerplate.
 */

import { OpenAI, type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import {
  createAdapter,
  type AdapterDelta,
  type ModelClass,
  type ModelInput,
  type ModelOutput,
} from "@tentickle/core/model";
// import { Logger } from "@tentickle/core";
import { normalizeModelInput } from "@tentickle/core/utils";
import type { ToolDefinition } from "@tentickle/core/tool";
import {
  type Message,
  type ContentBlock,
  type TextBlock,
  StopReason,
  AdapterError,
} from "@tentickle/shared";
import { type OpenAIAdapterConfig, STOP_REASON_MAP } from "./types";

// const logger = Logger.for("OpenAIAdapter");

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Factory function for creating OpenAI model adapter.
 *
 * Returns a ModelClass that can be used both programmatically and as JSX.
 */
export function createOpenAIModel(config: OpenAIAdapterConfig = {}): ModelClass {
  const client = config.client ?? new OpenAI(buildClientOptions(config));

  // Stateful tracking of tool call IDs by index (reset per stream)
  // OpenAI only sends the id on the first chunk, subsequent chunks only have index
  let toolCallIdByIndex = new Map<number, string>();

  return createAdapter<
    OpenAI.Chat.Completions.ChatCompletionCreateParams,
    ChatCompletion,
    ChatCompletionChunk
  >({
    metadata: {
      id: "openai",
      provider: "openai",
      model: config.model,
      type: "language" as const,
      capabilities: [
        { stream: true, toolCalls: true, provider: "openai" },
        {
          messageTransformation: (modelId: string, _provider?: string) => {
            const isGPT4 = modelId.includes("gpt-4") || modelId.includes("o1");
            const supportsDeveloper = isGPT4;

            return {
              preferredRenderer: "markdown",
              roleMapping: {
                event: supportsDeveloper ? "developer" : "user",
                ephemeral: supportsDeveloper ? "developer" : "user",
              },
              delimiters: {
                useDelimiters: !supportsDeveloper,
                event: "[Event]",
                ephemeral: "[Context]",
              },
              ephemeralPosition: "flow",
            };
          },
        },
      ],
    },

    prepareInput: async (input: ModelInput) => {
      const normalizedInput = normalizeModelInput(input, config);

      const messages: ChatCompletionMessageParam[] = [];
      for (const message of normalizedInput.messages) {
        messages.push(...toOpenAIMessages(message));
      }

      const openAITools =
        normalizedInput.tools.length > 0
          ? normalizedInput.tools.map((tool) => mapToolDefinition(tool.metadata))
          : undefined;

      const baseParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: normalizedInput.model as string,
        messages,
        temperature: normalizedInput.temperature,
        max_tokens: normalizedInput.maxTokens,
        top_p: normalizedInput.topP,
        frequency_penalty: normalizedInput.frequencyPenalty,
        presence_penalty: normalizedInput.presencePenalty,
        stop: normalizedInput.stop,
        tools: openAITools && openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools && openAITools.length > 0 ? "auto" : undefined,
      };

      // Clean undefined values
      Object.keys(baseParams).forEach((key) => {
        if ((baseParams as any)[key] === undefined) {
          delete (baseParams as any)[key];
        }
      });

      if (normalizedInput.providerOptions?.openai) {
        return { ...baseParams, ...normalizedInput.providerOptions.openai };
      }

      return baseParams;
    },

    mapChunk: (chunk: ChatCompletionChunk): AdapterDelta | null => {
      // Usage-only chunks (no choices) - emit usage event, not message_end
      // OpenAI sends usage in a separate final chunk after finish_reason
      if (!chunk.choices || chunk.choices.length === 0) {
        if (chunk.usage) {
          // Emit usage event (not message_end) to avoid duplicate end events
          return {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
            },
          };
        }
        return null;
      }

      const choice = chunk.choices[0];

      if (!choice || !choice.delta) {
        return null;
      }

      const delta = choice.delta;

      // Check finish_reason FIRST - the final chunk has both finish_reason and empty content
      if (choice.finish_reason) {
        return {
          type: "message_end",
          stopReason: STOP_REASON_MAP[choice.finish_reason] ?? StopReason.OTHER,
          usage: chunk.usage
            ? {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens: chunk.usage.total_tokens ?? 0,
              }
            : undefined,
        };
      }

      // Text content - only emit if non-empty (empty deltas are noise)
      if (delta.content) {
        return { type: "text", delta: delta.content };
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;

          // Track id by index (OpenAI only sends id on first chunk)
          if (toolCall.id) {
            toolCallIdByIndex.set(index, toolCall.id);
          }

          // Get the tracked id for this tool call
          const id = toolCallIdByIndex.get(index) || "";

          if (toolCall.function) {
            // Tool call start (has name)
            if (toolCall.function.name) {
              return {
                type: "tool_call_start",
                id,
                name: toolCall.function.name,
              };
            }
            // Tool call delta (has arguments)
            if (toolCall.function.arguments) {
              return {
                type: "tool_call_delta",
                id,
                delta: toolCall.function.arguments,
              };
            }
          }
        }
      }

      return null;
    },

    processOutput: async (output: ChatCompletion): Promise<ModelOutput> => {
      const choice = output.choices?.[0];
      const openaiMessage = choice?.message;

      if (!openaiMessage) {
        throw new AdapterError("openai", "No message in OpenAI response", "ADAPTER_RESPONSE");
      }

      const content: ContentBlock[] = [];

      if (openaiMessage.content) {
        content.push({ type: "text", text: openaiMessage.content });
      }

      const toolCalls: any[] = [];
      if (openaiMessage.tool_calls) {
        for (const toolCall of openaiMessage.tool_calls) {
          if (toolCall.type === "function" && "function" in toolCall) {
            let parsedInput: any;
            try {
              parsedInput = JSON.parse(toolCall.function.arguments);
            } catch {
              parsedInput = toolCall.function.arguments;
            }

            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              input: parsedInput,
            });

            content.push({
              type: "tool_use",
              toolUseId: toolCall.id,
              name: toolCall.function.name,
              input: parsedInput,
            });
          }
        }
      }

      const messages: Message[] = [{ role: "assistant", content }];

      return {
        model: output.model,
        createdAt: output.created.toString(),
        messages,
        get message() {
          return messages.filter((m) => m.role === "assistant").at(-1);
        },
        stopReason: choice?.finish_reason
          ? (STOP_REASON_MAP[choice.finish_reason] ?? StopReason.OTHER)
          : StopReason.UNSPECIFIED,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: output.usage?.prompt_tokens ?? 0,
          outputTokens: output.usage?.completion_tokens ?? 0,
          totalTokens: output.usage?.total_tokens ?? 0,
          reasoningTokens: 0,
          cachedInputTokens: output.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        raw: output,
      };
    },

    execute: async (params) => {
      return await client.chat.completions.create({
        ...params,
        stream: false,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    },

    executeStream: async function* (params) {
      // Reset tool call tracking for new stream
      toolCallIdByIndex = new Map();

      const stream = await client.chat.completions.create({
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      for await (const chunk of stream) {
        yield chunk;
      }
    },

    reconstructRaw: (accumulated) => {
      // Reconstruct a ChatCompletion-like response from streaming data
      // This allows consumers to treat the streaming response as if it were non-streaming
      const chunks = accumulated.chunks as ChatCompletionChunk[];
      const firstChunk = chunks[0];

      // Map internal stop reason to OpenAI finish_reason
      const finishReason = (() => {
        switch (accumulated.stopReason) {
          case StopReason.STOP:
            return "stop" as const;
          case StopReason.MAX_TOKENS:
            return "length" as const;
          case StopReason.TOOL_USE:
            return "tool_calls" as const;
          case StopReason.CONTENT_FILTER:
            return "content_filter" as const;
          default:
            return "stop" as const;
        }
      })();

      // Build tool_calls array if present
      const toolCalls =
        accumulated.toolCalls.length > 0
          ? accumulated.toolCalls.map((tc, _index) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            }))
          : undefined;

      // Reconstruct the ChatCompletion format
      const reconstructed: ChatCompletion = {
        id: firstChunk?.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion" as const,
        created: firstChunk?.created || Math.floor(Date.now() / 1000),
        model: accumulated.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: accumulated.text || null,
              refusal: null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: accumulated.usage.inputTokens,
          completion_tokens: accumulated.usage.outputTokens,
          total_tokens: accumulated.usage.totalTokens,
        },
      };

      return reconstructed;
    },
  });
}

/**
 * Convenience factory for creating OpenAI model.
 *
 * Returns a ModelClass that can be used as:
 * - JSX component: `<model temperature={0.9}><Agent /></model>`
 * - App config: `createApp(Agent, { model })`
 * - Direct calls: `await model.generate(input)`
 *
 * @example
 * ```typescript
 * const model = openai({ model: 'gpt-4o' });
 *
 * // As JSX
 * <model><MyAgent /></model>
 *
 * // With createApp
 * const app = createApp(MyAgent, { model });
 * ```
 */
export function openai(config?: OpenAIAdapterConfig): ModelClass {
  return createOpenAIModel(config);
}

// ============================================================================
// Helper Functions
// ============================================================================

export function buildClientOptions(config: OpenAIAdapterConfig): ClientOptions {
  const options: ClientOptions = {
    apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"],
    baseURL: config.baseURL ?? process.env["OPENAI_BASE_URL"],
    organization: config.organization ?? process.env["OPENAI_ORGANIZATION"],
    defaultHeaders: config.headers,
    ...(config.providerOptions?.openai || {}),
  };

  Object.keys(options).forEach((key) => {
    if ((options as any)[key] === undefined) {
      delete (options as any)[key];
    }
  });

  return options as ClientOptions;
}

/**
 * Convert Message to OpenAI ChatCompletionMessageParam(s)
 */
export function toOpenAIMessages(message: Message): ChatCompletionMessageParam[] {
  const content: any[] = [];
  const tool_calls: any[] = [];
  const toolResultMessages: ChatCompletionMessageParam[] = [];

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;

      case "image":
        if (block.source.type === "url") {
          content.push({
            type: "image_url",
            image_url: { url: block.source.url },
          });
        } else if (block.source.type === "base64") {
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.mimeType};base64,${block.source.data}`,
            },
          });
        }
        break;

      case "tool_use":
        tool_calls.push({
          id: block.toolUseId,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
        break;

      case "tool_result":
        const resultContent = block.content || [];
        const resultText = resultContent
          .filter((c: any) => c.type === "text")
          .map((c: any) => (c as TextBlock).text)
          .join("\n");

        toolResultMessages.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: resultText || "Done",
        } as any);
        break;

      default:
        const blockText = (block as any).text || JSON.stringify(block, null, 2);
        content.push({ type: "text", text: blockText });
        break;
    }
  }

  if (toolResultMessages.length > 0 && content.length === 0 && tool_calls.length === 0) {
    return toolResultMessages;
  }

  const baseMessage: any = {
    role: message.role,
    content: content.length > 0 ? content : null,
  };

  if (tool_calls.length > 0) {
    baseMessage.tool_calls = tool_calls;
  }

  const result: ChatCompletionMessageParam[] = [baseMessage];
  if (toolResultMessages.length > 0) {
    result.push(...toolResultMessages);
  }

  return result;
}

/**
 * Map tool definition to OpenAI format
 */
export function mapToolDefinition(tool: any): ChatCompletionTool {
  if (typeof tool === "string") {
    return {
      type: "function",
      function: {
        name: tool,
        description: "",
        parameters: {},
      },
    };
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const baseTool: ChatCompletionTool = {
      type: "function",
      function: {
        name: toolDef.name,
        description: toolDef.description || "",
        parameters: toolDef.input || {},
      },
    };

    if (toolDef.providerOptions?.openai) {
      const openAIConfig = toolDef.providerOptions.openai;
      return {
        ...baseTool,
        ...openAIConfig,
        function: {
          ...baseTool.function,
          ...(openAIConfig.function || {}),
        },
      } as ChatCompletionTool;
    }

    return baseTool;
  }

  const metadata = (tool as any).metadata || tool;
  return {
    type: "function",
    function: {
      name: metadata?.id || metadata?.name || "unknown",
      description: metadata?.description || "",
      parameters: metadata?.inputSchema || {},
    },
  };
}
