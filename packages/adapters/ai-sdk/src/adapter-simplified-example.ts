/**
 * AI SDK Adapter - Simplified Version (EXAMPLE/EXPLORATION)
 *
 * This file demonstrates how the AI SDK adapter would look using the
 * new createSimpleAdapter pattern with AdapterDelta + StreamAccumulator.
 *
 * Compare this (~200 lines) to adapter.ts (~1400 lines) to see the reduction.
 *
 * NOTE: This is an exploration/example file. The actual adapter is in adapter.ts.
 *
 * @module @tentickle/ai-sdk/adapter-simplified-example
 */

import { createSimpleAdapter, type AdapterDelta, type ModelInput } from "@tentickle/core/model";

import { StopReason } from "@tentickle/shared";

import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  jsonSchema,
} from "ai";

// ============================================================================
// Configuration
// ============================================================================

export interface SimplifiedAiSdkAdapterConfig {
  model: LanguageModel;
  system?: string;
  tools?: ToolSet;
  temperature?: number;
  maxTokens?: number;
}

// ============================================================================
// Stop Reason Mapping
// ============================================================================

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "length":
      return StopReason.MAX_TOKENS;
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
// The Simplified Adapter (~150 lines vs ~1400 lines)
// ============================================================================

/**
 * Create a simplified AI SDK adapter.
 *
 * The key insight: mapChunk is ~30 lines vs the 230-line switch in adapter.ts.
 * Everything else (accumulation, events, lifecycle) is handled by the framework.
 */
export function createSimplifiedAiSdkAdapter(config: SimplifiedAiSdkAdapterConfig) {
  const { model, system: defaultSystem, tools: defaultTools, ...defaultParams } = config;

  return createSimpleAdapter({
    metadata: {
      id: `ai-sdk:${(model as any).modelId || "unknown"}`,
      provider: (model as any).provider || "ai-sdk",
      type: "language",
      capabilities: [{ stream: true, toolCalls: true }],
    },

    // =========================================================================
    // prepareInput: ModelInput → AI SDK format
    // This is the same as before - you still need to convert messages/tools
    // =========================================================================
    prepareInput: (input: ModelInput) => {
      const messages: ModelMessage[] = [];
      let system: string | undefined = defaultSystem;

      // Convert messages
      for (let msg of input.messages || []) {
        if (typeof msg === "string") {
          msg = { role: "user", content: [{ type: "text", text: msg }] };
        }
        if (msg.role === "system") {
          system = msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n\n");
        } else if (msg.role === "user" || msg.role === "assistant") {
          const content = msg.content.map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            if (block.type === "tool_use") {
              return {
                type: "tool-call" as const,
                toolCallId: (block as any).toolUseId,
                toolName: (block as any).name,
                args: (block as any).input,
              };
            }
            return { type: "text" as const, text: JSON.stringify(block) };
          });
          messages.push({ role: msg.role, content } as any);
        } else if (msg.role === "tool") {
          const toolResults = msg.content
            .filter((b): b is any => b.type === "tool_result")
            .map((block) => ({
              type: "tool-result" as const,
              toolCallId: block.toolUseId,
              toolName: block.name || "unknown",
              result: block.content,
            }));
          if (toolResults.length) {
            messages.push({ role: "tool", content: toolResults } as any);
          }
        }
      }

      // Add system message
      if (system) {
        messages.unshift({ role: "system", content: system } as any);
      }

      // Convert tools
      const toolSet: ToolSet = { ...defaultTools } as ToolSet;
      for (const toolRef of input.tools || []) {
        if (typeof toolRef !== "string" && "name" in toolRef) {
          const name = (toolRef as any).name || (toolRef as any).metadata?.name;
          const desc = (toolRef as any).description || (toolRef as any).metadata?.description;
          const schema = (toolRef as any).input || (toolRef as any).metadata?.input;
          if (name) {
            toolSet[name] = {
              description: desc || "",
              parameters: schema ? jsonSchema(schema) : undefined,
            } as any;
          }
        }
      }

      return {
        model,
        messages,
        tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
        temperature: input.temperature ?? defaultParams.temperature,
        maxTokens: input.maxTokens ?? defaultParams.maxTokens,
      };
    },

    // =========================================================================
    // mapChunk: AI SDK chunk → AdapterDelta
    // This is the magic - 30 lines vs 230 lines!
    // =========================================================================
    mapChunk: (chunk: any): AdapterDelta | null => {
      switch (chunk.type) {
        // Text content
        case "text-delta":
          return { type: "text", delta: chunk.text || "" };

        // Reasoning (Claude, o1)
        case "reasoning-delta":
          return { type: "reasoning", delta: chunk.text || "" };

        // Tool calls
        case "tool-input-start":
          return { type: "tool_call_start", id: chunk.id, name: chunk.toolName };
        case "tool-input-delta":
          return { type: "tool_call_delta", id: chunk.id, delta: chunk.delta || "" };
        case "tool-input-end":
          return { type: "tool_call_end", id: chunk.id, input: undefined }; // Accumulator parses JSON
        case "tool-call":
          return {
            type: "tool_call",
            id: chunk.toolCallId,
            name: chunk.toolName,
            input: chunk.args,
          };

        // Message lifecycle
        case "start":
          return { type: "message_start" };
        case "finish":
          return {
            type: "message_end",
            stopReason: mapStopReason(chunk.finishReason),
            usage: chunk.totalUsage
              ? {
                  inputTokens: chunk.totalUsage.promptTokens || chunk.totalUsage.inputTokens || 0,
                  outputTokens:
                    chunk.totalUsage.completionTokens || chunk.totalUsage.outputTokens || 0,
                  totalTokens: chunk.totalUsage.totalTokens || 0,
                }
              : undefined,
          };

        // Errors
        case "error":
          return { type: "error", error: chunk.error?.message || "Stream error" };

        // Everything else - pass through as raw
        default:
          return null; // Ignore unknown chunks
      }
    },

    // =========================================================================
    // execute/executeStream: Call the provider
    // =========================================================================
    execute: async (input) => {
      return generateText(input as any);
    },

    executeStream: (input) => {
      return streamText(input as any).fullStream;
    },

    // =========================================================================
    // processOutput: Convert non-streaming result (optional)
    // =========================================================================
    processOutput: (output: any) => {
      const messages = output.response?.messages || [];
      const content = messages
        .filter((m: any) => m.role === "assistant")
        .flatMap((m: any) => m.content || []);

      return {
        model: output.response?.modelId || "unknown",
        createdAt: output.response?.timestamp?.toISOString() || new Date().toISOString(),
        message: { role: "assistant" as const, content },
        messages: [{ role: "assistant" as const, content }],
        usage: {
          inputTokens: output.usage?.inputTokens || 0,
          outputTokens: output.usage?.outputTokens || 0,
          totalTokens: output.usage?.totalTokens || 0,
        },
        toolCalls: output.toolCalls?.map((tc: any) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.args,
        })),
        stopReason: mapStopReason(output.finishReason),
        raw: output,
      };
    },
  });
}

// ============================================================================
// Shorthand
// ============================================================================

export function aiSdkSimplified(config: SimplifiedAiSdkAdapterConfig) {
  return createSimplifiedAiSdkAdapter(config);
}
