/**
 * AI SDK Adapter v2 - Using composable helpers
 *
 * This shows the adapter pattern using:
 * - AdapterDelta + StreamAccumulator (framework)
 * - Composable helpers (framework)
 * - Adapter-specific logic (here)
 *
 * Compare to adapter.ts (~1400 lines) - this is ~250 lines.
 *
 * @module @tentickle/ai-sdk/adapter-v2-example
 */

import {
  createSimpleAdapter,
  type AdapterDelta,
  type ModelInput,
  // Helpers - import what you need
  extractSystemPrompt,
  extractText,
  getToolResultBlocks,
  imageToBase64,
  imageToUrl,
  imageMimeType,
  documentToBase64,
  documentToUrl,
  normalizeToolDefinition,
  toolResultToSimple,
  normalizeUsage,
  mapStopReason,
} from "@tentickle/core/model";

import type { ContentBlock, Message } from "@tentickle/shared";

import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  jsonSchema,
} from "ai";

// ============================================================================
// Types
// ============================================================================

export interface AiSdkAdapterV2Config {
  model: LanguageModel;
  system?: string;
  tools?: ToolSet;
  temperature?: number;
  maxTokens?: number;
}

// ============================================================================
// Content Block → AI SDK Part Conversion
// ============================================================================

function blockToAiSdkPart(block: ContentBlock): unknown | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: (block as any).text };

    case "reasoning":
      return { type: "reasoning", text: (block as any).text };

    case "image": {
      const url = imageToUrl(block);
      if (url) return { type: "image", image: url, mediaType: imageMimeType(block) };
      const b64 = imageToBase64(block);
      if (b64) return { type: "image", image: b64, mediaType: imageMimeType(block) };
      return undefined;
    }

    case "document": {
      const url = documentToUrl(block);
      if (url) return { type: "file", data: url, mediaType: (block as any).mimeType };
      const b64 = documentToBase64(block);
      if (b64) return { type: "file", data: b64, mediaType: (block as any).mimeType };
      return undefined;
    }

    case "tool_use": {
      const tb = block as any;
      return {
        type: "tool-call",
        toolCallId: tb.toolUseId,
        toolName: tb.name,
        args: tb.input,
      };
    }

    case "tool_result": {
      const tr = block as any;
      const output = toolResultToSimple(tr.content, tr.isError);
      return {
        type: "tool-result",
        toolCallId: tr.toolUseId,
        toolName: tr.name || "unknown",
        output: {
          type: tr.isError ? "error-text" : output.type === "json" ? "json" : "text",
          value: output.value,
        },
      };
    }

    default:
      return { type: "text", text: JSON.stringify(block) };
  }
}

function blocksToAiSdkContent(blocks: ContentBlock[]): unknown[] {
  return blocks.map(blockToAiSdkPart).filter((p) => p != null);
}

// ============================================================================
// Message → AI SDK Message Conversion
// ============================================================================

function messageToAiSdk(msg: Message): ModelMessage | undefined {
  if (msg.role === "system") {
    return { role: "system", content: extractText(msg.content) };
  }

  if (msg.role === "user" || msg.role === "assistant") {
    const content = blocksToAiSdkContent(msg.content);
    if (content.length === 0) return undefined;
    return { role: msg.role, content } as any;
  }

  if (msg.role === "tool") {
    const results = getToolResultBlocks(msg.content).map((tr) => {
      const output = toolResultToSimple(tr.content, tr.isError);
      return {
        type: "tool-result" as const,
        toolCallId: tr.toolUseId,
        toolName: tr.name || "unknown",
        output: {
          type: tr.isError ? "error-text" : output.type === "json" ? "json" : "text",
          value: output.value,
        },
      };
    });
    if (results.length === 0) return undefined;
    return { role: "tool", content: results } as any;
  }

  // event, ephemeral → user (fallback)
  const content = blocksToAiSdkContent(msg.content);
  if (content.length === 0) return undefined;
  return { role: "user", content } as any;
}

// ============================================================================
// Tool Conversion
// ============================================================================

function toolsToToolSet(tools: unknown[] | undefined): ToolSet {
  if (!tools || tools.length === 0) return {} as ToolSet;

  const set: ToolSet = {} as ToolSet;
  for (const tool of tools) {
    const def = normalizeToolDefinition(tool);
    if (def) {
      set[def.name] = {
        description: def.description,
        parameters: def.input ? jsonSchema(def.input as any) : undefined,
      } as any;
    }
  }
  return set;
}

// ============================================================================
// The Adapter (~50 lines of actual adapter logic)
// ============================================================================

export function createAiSdkAdapterV2(config: AiSdkAdapterV2Config) {
  const { model, system: defaultSystem, tools: defaultTools, ...defaultParams } = config;

  return createSimpleAdapter({
    metadata: {
      id: `ai-sdk:${(model as any).modelId || "unknown"}`,
      provider: (model as any).provider || "ai-sdk",
      type: "language",
      capabilities: [{ stream: true, toolCalls: true }],
    },

    // =========================================================================
    // prepareInput: Uses helpers for conversion
    // =========================================================================
    prepareInput: (input: ModelInput) => {
      // Normalize messages
      const messages = (Array.isArray(input.messages) ? input.messages : [input.messages]).map(
        (m) =>
          typeof m === "string"
            ? { role: "user" as const, content: [{ type: "text" as const, text: m }] }
            : m,
      );

      // Extract system prompt
      const { system: extractedSystem, messages: rest } = extractSystemPrompt(messages);
      const system = extractedSystem || defaultSystem;

      // Convert messages
      const aiSdkMessages = rest.map(messageToAiSdk).filter((m): m is ModelMessage => m != null);

      // Add system as first message if present
      if (system) {
        aiSdkMessages.unshift({ role: "system", content: system });
      }

      // Convert tools
      const toolSet = { ...defaultTools, ...toolsToToolSet(input.tools) } as ToolSet;

      return {
        model,
        messages: aiSdkMessages,
        tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
        temperature: input.temperature ?? defaultParams.temperature,
        maxTokens: input.maxTokens ?? defaultParams.maxTokens,
      };
    },

    // =========================================================================
    // mapChunk: ~40 lines - the core adapter logic
    // =========================================================================
    mapChunk: (chunk: any): AdapterDelta | null => {
      const type = chunk.type;

      // Text
      if (type === "text-delta") {
        return { type: "text", delta: chunk.text || "" };
      }

      // Reasoning
      if (type === "reasoning-delta") {
        return { type: "reasoning", delta: chunk.text || "" };
      }

      // Tool calls (streamed)
      if (type === "tool-input-start") {
        return { type: "tool_call_start", id: chunk.id, name: chunk.toolName };
      }
      if (type === "tool-input-delta") {
        return { type: "tool_call_delta", id: chunk.id, delta: chunk.delta || "" };
      }
      if (type === "tool-input-end") {
        return { type: "tool_call_end", id: chunk.id, input: undefined };
      }

      // Tool call (complete)
      if (type === "tool-call") {
        return { type: "tool_call", id: chunk.toolCallId, name: chunk.toolName, input: chunk.args };
      }

      // Message lifecycle
      if (type === "start") {
        return { type: "message_start" };
      }
      if (type === "finish") {
        return {
          type: "message_end",
          stopReason: mapStopReason(chunk.finishReason),
          usage: normalizeUsage(chunk.totalUsage),
        };
      }

      // Errors
      if (type === "error" || type === "abort") {
        return { type: "error", error: chunk.error?.message || "Stream error" };
      }

      // Pass through unknown as metadata
      if (type === "source" || type === "file" || type === "start-step" || type === "finish-step") {
        return { type: "raw", data: chunk };
      }

      return null;
    },

    // =========================================================================
    // Executors
    // =========================================================================
    execute: (input) => generateText(input as any),
    executeStream: (input) => streamText(input as any).fullStream,

    // =========================================================================
    // processOutput: For non-streaming
    // =========================================================================
    processOutput: (output: any) => ({
      model: output.response?.modelId || "unknown",
      createdAt: output.response?.timestamp?.toISOString() || new Date().toISOString(),
      message: output.response?.messages?.[0]
        ? { role: "assistant" as const, content: output.response.messages[0].content }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: output.text || "" }],
          },
      messages: output.response?.messages || [],
      usage: normalizeUsage(output.usage),
      toolCalls: output.toolCalls?.map((tc: any) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args,
      })),
      stopReason: mapStopReason(output.finishReason),
      raw: output,
    }),
  });
}

// ============================================================================
// Shorthand
// ============================================================================

export function aiSdkV2(config: AiSdkAdapterV2Config) {
  return createAiSdkAdapterV2(config);
}
