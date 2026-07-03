/**
 * Google GenAI Adapter
 *
 * Native Google GenAI adapter for use with the engine.
 * Uses createAdapter for minimal boilerplate.
 */

import type { GenerateContentResponse } from "@google/genai";
import { GoogleGenAI, type GenerateContentParameters, FinishReason } from "@google/genai";

import { uuidv7 } from "@agentick/shared";
import {
  createAdapter,
  type AdapterDelta,
  type ModelClass,
  type ModelInput,
  type ModelOutput,
} from "@agentick/core/model";
// import { Logger } from "@agentick/core";
import { normalizeModelInput } from "@agentick/core/utils";
import type { ToolDefinition } from "@agentick/core/tool";
import {
  type ContentBlock,
  type Message,
  type TextBlock,
  type EmbedResult,
  StopReason,
  AdapterError,
  ValidationError,
} from "@agentick/shared";
import { type GoogleAdapterConfig, STOP_REASON_MAP } from "./types.js";

// const logger = Logger.for("GoogleAdapter");

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Factory function for creating Google model adapter.
 *
 * Returns a ModelClass that can be used both programmatically and as JSX.
 */
export function createGoogleModel(config: GoogleAdapterConfig = {}): ModelClass {
  const client = config.client ?? new GoogleGenAI(buildClientOptions(config));

  return createAdapter<GenerateContentParameters, GenerateContentResponse, GenerateContentResponse>(
    {
      metadata: {
        id: "google",
        provider: "google",
        model: config.model,
        type: "language" as const,
        capabilities: [
          { stream: true, toolCalls: true, provider: "google" },
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
        const { contents, systemInstruction } = toGoogleMessages(normalizedInput.messages);

        const generateConfig: any = {
          temperature: normalizedInput.temperature,
          maxOutputTokens: normalizedInput.maxTokens,
          topP: normalizedInput.topP,
          stopSequences: normalizedInput.stop,
        };

        if (systemInstruction) {
          generateConfig.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        if (normalizedInput.tools.length > 0) {
          const allFunctionDeclarations = normalizedInput.tools.flatMap((tool) => {
            const mapped = mapToolDefinition(tool.metadata);
            return mapped.functionDeclarations || [];
          });
          generateConfig.tools = [{ functionDeclarations: allFunctionDeclarations }];
        }

        // Map responseFormat
        if (normalizedInput.responseFormat) {
          const rf = normalizedInput.responseFormat;
          if (rf.type === "json" || rf.type === "json_schema") {
            generateConfig.responseMimeType = "application/json";
          }
          if (rf.type === "json_schema") {
            generateConfig.responseSchema = rf.schema;
          }
        }

        Object.keys(generateConfig).forEach((key) => {
          if (generateConfig[key] === undefined) delete generateConfig[key];
        });

        const googleOptions = normalizedInput.providerOptions?.google || {};
        const { model: providerModel, ...providerConfigOptions } = googleOptions as any;
        const finalConfig = { ...generateConfig, ...providerConfigOptions };

        if (contents.length === 0) {
          throw new ValidationError(
            "contents",
            "No valid contents to send to Google. All messages were either system messages or had empty parts.",
          );
        }

        return {
          model: providerModel || normalizedInput.model || config.model || "gemini-2.5-flash",
          contents,
          config: finalConfig,
        } as any;
      },

      mapChunk: mapGoogleChunk,

      processOutput: async (output: GenerateContentResponse): Promise<ModelOutput> => {
        const candidate = output.candidates?.[0];
        if (!candidate) {
          throw new AdapterError("google", "No candidates in Google response", "ADAPTER_RESPONSE");
        }

        const content: ContentBlock[] = [];

        for (const part of candidate.content?.parts || []) {
          if (part.text) {
            content.push({ type: "text", text: part.text || "" });
          } else if (part.functionCall) {
            const fc = part.functionCall as {
              name?: string;
              id?: string;
              args?: Record<string, unknown>;
            };
            const toolUseId = fc.id ?? fc.name ?? "";
            content.push({
              type: "tool_use",
              toolUseId,
              name: fc.name || "",
              input: fc.args || {},
              // Gemini 3+ thinking models attach thoughtSignature to functionCall
              // parts. Must be preserved and sent back in subsequent requests.
              ...((part as any).thoughtSignature
                ? {
                    providerMetadata: {
                      google: { thoughtSignature: (part as any).thoughtSignature },
                    },
                  }
                : {}),
            });
          }
        }

        const toolCalls = content
          .filter((block) => block.type === "tool_use")
          .map((block: any) => ({
            id: block.toolUseId,
            name: block.name,
            input: block.input,
          }));

        const messages: Message[] = [{ role: "assistant", content }];

        return {
          model: output.modelVersion || "unknown",
          createdAt: new Date().toISOString(),
          messages,
          get message() {
            return messages.filter((m) => m.role === "assistant").at(-1);
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
      },

      execute: async (params) => {
        const model = (params as any).model || "gemini-1.5-flash";
        const { model: _, ...requestParams } = params as any;
        return await client.models.generateContent({ model, ...requestParams });
      },

      executeStream: async function* (params) {
        const model = (params as any).model || "gemini-1.5-flash";
        const { model: _, ...requestParams } = params as any;
        const stream = await client.models.generateContentStream({ model, ...requestParams });
        for await (const chunk of stream) {
          yield chunk;
        }
      },

      reconstructRaw: (accumulated) => {
        // Reconstruct a GenerateContentResponse-like object from streaming data
        const chunks = accumulated.chunks as GenerateContentResponse[];
        const firstChunk = chunks[0];

        // Map internal stop reason to Google FinishReason
        const finishReason = (() => {
          switch (accumulated.stopReason) {
            case StopReason.STOP:
              return FinishReason.STOP;
            case StopReason.MAX_TOKENS:
              return FinishReason.MAX_TOKENS;
            case StopReason.TOOL_USE:
              return FinishReason.STOP; // Google doesn't have a tool_calls finish reason
            case StopReason.CONTENT_FILTER:
              return FinishReason.SAFETY;
            default:
              return FinishReason.STOP;
          }
        })();

        // Build parts array from accumulated content
        const parts: any[] = [];

        if (accumulated.text) {
          parts.push({ text: accumulated.text });
        }

        // Add function calls from tool calls
        for (const tc of accumulated.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.input,
            },
          });
        }

        // Reconstruct the GenerateContentResponse format
        const reconstructed: GenerateContentResponse = {
          candidates: [
            {
              content: {
                role: "model",
                parts,
              },
              finishReason,
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: accumulated.usage.inputTokens,
            candidatesTokenCount: accumulated.usage.outputTokens,
            totalTokenCount: accumulated.usage.totalTokens,
            thoughtsTokenCount: accumulated.usage.reasoningTokens || 0,
            cachedContentTokenCount: accumulated.usage.cachedInputTokens || 0,
          },
          modelVersion: accumulated.model || firstChunk?.modelVersion,
        } as GenerateContentResponse;

        return reconstructed;
      },

      // Forward application-level options to createAdapter
      customBlocks: config.customBlocks,
      deltaTransform: config.deltaTransform,

      // Embedding support — enabled when embeddingModel is configured
      embed: config.embeddingModel
        ? async (input): Promise<EmbedResult> => {
            const texts = typeof input.input === "string" ? [input.input] : input.input;
            const embedConfig: Record<string, unknown> = {};
            if (input.dimensions) embedConfig.outputDimensionality = input.dimensions;
            if (input.taskType) embedConfig.taskType = input.taskType;

            const embeddingModel = input.model ?? config.embeddingModel!;
            const response = await client.models.embedContent({
              model: embeddingModel,
              contents: texts.map((text) => ({ parts: [{ text }] })),
              ...(Object.keys(embedConfig).length > 0 ? { config: embedConfig } : {}),
            });

            const embeddings = (response.embeddings ?? []).map((e) => e.values ?? []);

            return {
              embeddings,
              dimensions: embeddings[0]?.length ?? input.dimensions ?? 0,
              model: embeddingModel,
            };
          }
        : undefined,
    },
  );
}

/**
 * Convenience factory for creating Google model.
 *
 * Returns a ModelClass that can be used as:
 * - JSX component: `<model><Agent /></model>`
 * - App config: `createApp(Agent, { model })`
 * - Direct calls: `await model.generate(input)`
 *
 * @example
 * ```typescript
 * const model = google({ model: 'gemini-2.0-flash' });
 *
 * // As JSX
 * <model><MyAgent /></model>
 *
 * // With createApp
 * const app = createApp(MyAgent, { model });
 * ```
 */
export function google(config?: GoogleAdapterConfig): ModelClass {
  return createGoogleModel(config);
}

// ============================================================================
// Helper Functions
// ============================================================================

export function buildClientOptions(config: GoogleAdapterConfig): any {
  const options: any = {};

  if (config.apiKey) options.apiKey = config.apiKey;

  if (config.vertexai) {
    options.vertexai = true;
    if (config.project) options.project = config.project;
    if (config.location) options.location = config.location;
  }

  if (config.timeout || config.baseUrl) {
    options.httpOptions = {};
    if (config.timeout) options.httpOptions.timeout = config.timeout;
    if (config.baseUrl) options.httpOptions.baseUrl = config.baseUrl;
  }

  if (config.googleAuthOptions) options.googleAuthOptions = config.googleAuthOptions;
  if (config.providerOptions?.google) Object.assign(options, config.providerOptions.google);

  return options;
}

export function mapGoogleFinishReason(finishReason: FinishReason | undefined): StopReason {
  return finishReason ? STOP_REASON_MAP[finishReason] || StopReason.STOP : StopReason.STOP;
}

/**
 * Map a Google GenerateContentResponse chunk to adapter deltas.
 * Handles all part types (text, functionCall) and finishReason in a single pass.
 * Returns an array when a chunk contains multiple parts (parallel tool calls,
 * text + tool call, or parts + finishReason).
 */
export function mapGoogleChunk(
  chunk: GenerateContentResponse,
): AdapterDelta | AdapterDelta[] | null {
  const candidate = chunk.candidates?.[0];
  if (!candidate) return null;

  const parts = candidate.content?.parts || [];
  const deltas: AdapterDelta[] = [];

  for (const part of parts) {
    if (part.text) {
      deltas.push({ type: "text", delta: part.text });
    } else if (part.functionCall) {
      const fc = part.functionCall as {
        name?: string;
        id?: string;
        args?: Record<string, unknown>;
      };
      deltas.push({
        type: "tool_call",
        id: fc.id || uuidv7(),
        name: fc.name || "",
        input: fc.args || {},
        // Gemini 3+ thinking: thoughtSignature is a sibling of functionCall on the part
        ...((part as any).thoughtSignature
          ? { providerMetadata: { google: { thoughtSignature: (part as any).thoughtSignature } } }
          : {}),
      });
    }
  }

  if (candidate.finishReason) {
    deltas.push({
      type: "message_end",
      stopReason: mapGoogleFinishReason(candidate.finishReason),
      usage: chunk.usageMetadata
        ? {
            inputTokens: chunk.usageMetadata.promptTokenCount || 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount || 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
            reasoningTokens: chunk.usageMetadata.thoughtsTokenCount || 0,
            cachedInputTokens: chunk.usageMetadata.cachedContentTokenCount || 0,
          }
        : undefined,
    });
  }

  if (deltas.length === 0) return null;
  return deltas.length === 1 ? deltas[0] : deltas;
}

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

      case "document":
        // Gemini accepts documents (e.g. application/pdf) through the same
        // inlineData/fileData parts as images. Small payloads go inline as
        // base64; large ones are referenced by URI (typically a gs:// object
        // staged by the caller). Mirrors the "image" case above.
        if (block.source.type === "url") {
          parts.push({
            fileData: {
              mimeType: block.source.mimeType || "application/pdf",
              fileUri: block.source.url,
            },
          });
        } else if (block.source.type === "base64") {
          parts.push({
            inlineData: {
              mimeType: block.source.mimeType || "application/pdf",
              data: block.source.data,
            },
          });
        }
        break;

      case "tool_use":
        parts.push({
          functionCall: {
            id: block.toolUseId,
            name: block.name,
            args: block.input,
          },
          // Gemini 3+ thinking: thoughtSignature must round-trip on functionCall parts
          ...((block as any).providerMetadata?.google?.thoughtSignature
            ? { thoughtSignature: (block as any).providerMetadata.google.thoughtSignature }
            : {}),
        });
        break;

      case "tool_result":
        const resultContent = block.content;
        const resultText =
          resultContent == null
            ? undefined
            : typeof resultContent === "string"
              ? resultContent
              : Array.isArray(resultContent)
                ? resultContent
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n") || JSON.stringify(resultContent)
                : JSON.stringify(resultContent);

        parts.push({
          functionResponse: {
            id: block.toolUseId,
            name: block.name,
            response: { result: resultText },
          },
        });
        break;

      default:
        const blockText = (block as any).text || JSON.stringify(block, null, 2);
        parts.push({ text: blockText });
        break;
    }
  }

  return parts;
}

/**
 * Transform agentick `Message[]` into the shape Google's GenAI API expects:
 *   - `contents` — the conversational turns (user / model)
 *   - `systemInstruction` — a single string with ALL system messages joined
 *
 * Google's `systemInstruction` accepts only one value, but agentick callers
 * can emit multiple `role: "system"` messages (e.g. an identity block and
 * a separate resource-listing block). A naïve last-write-wins implementation
 * silently drops everything but the final system message — a class of bug
 * that mostly surfaces in production once the system prompt is split. We
 * accumulate ALL system message texts into `systemParts` and concatenate
 * them with a blank-line separator, mirroring the Anthropic adapter's
 * `toAnthropicMessages` pattern.
 *
 * Empty system messages (no text blocks, or all empty after filtering) are
 * skipped so they don't introduce spurious separators.
 */
export function toGoogleMessages(messages: Message[]): {
  contents: any[];
  systemInstruction: string | undefined;
} {
  const contents: any[] = [];
  const systemParts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as TextBlock).text)
        .join("\n\n");
      if (text) systemParts.push(text);
      continue;
    }

    const parts = convertBlocksToGoogleParts(message.content);
    if (parts.length === 0) continue;

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

/**
 * Sanitize a JSON Schema for Gemini's function declaration format.
 * Gemini supports a strict subset of JSON Schema. This recursively strips
 * unsupported features while preserving the schema's intent.
 *
 * Removed: $ref, additionalItems, additionalProperties (empty object),
 *          tuple-style items (array of schemas), $defs/$definitions.
 * Simplified: anyOf/oneOf with mixed types → first valid option or any.
 */
export function sanitizeSchemaForGemini(schema: any, depth = 0): any {
  if (!schema || typeof schema !== "object" || depth > 15) return schema;

  // Handle arrays (e.g., items: [{...}, {...}] tuple form)
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item, depth + 1));
  }

  const result: any = {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported keywords entirely
    if (
      key === "$ref" ||
      key === "$defs" ||
      key === "$definitions" ||
      key === "additionalItems" ||
      key === "propertyNames"
    ) {
      continue;
    }

    // additionalProperties: {} (empty schema) → remove
    if (key === "additionalProperties") {
      if (value && typeof value === "object" && Object.keys(value).length === 0) {
        continue;
      }
      // additionalProperties: false is fine for Gemini
      if (value === false) {
        result[key] = value;
        continue;
      }
      // additionalProperties: {schema} → skip (Gemini doesn't support it well)
      continue;
    }

    // items: when it's an array (tuple validation) → use first item's schema or string
    if (key === "items" && Array.isArray(value)) {
      // Tuple items: [{ type: "string" }, { type: "string" }] → { type: "string" }
      const first = value[0];
      result[key] = first ? sanitizeSchemaForGemini(first, depth + 1) : { type: "string" };
      continue;
    }

    // anyOf/oneOf with $ref entries → filter them out
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const cleaned = value
        .filter((v: any) => !v?.$ref)
        .map((v: any) => sanitizeSchemaForGemini(v, depth + 1));

      if (cleaned.length === 0) {
        // All options had $ref → fall back to any
        result.type = "object";
      } else if (cleaned.length === 1) {
        // Single option → inline it
        Object.assign(result, cleaned[0]);
      } else {
        result[key] = cleaned;
      }
      continue;
    }

    // Recurse into objects
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGemini(value, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Ensure the parameters object is a valid Gemini function declaration schema.
 * Gemini requires `type: "object"` — empty `{}` or missing `type` is rejected.
 */
function ensureObjectSchema(params: any): any {
  if (!params || typeof params !== "object") return { type: "object" };
  if (!params.type) return { ...params, type: "object" };
  return params;
}

export function mapToolDefinition(tool: any): any {
  if (typeof tool === "string") {
    return {
      functionDeclarations: [{ name: tool, description: "", parameters: { type: "object" } }],
    };
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const baseTool = {
      functionDeclarations: [
        {
          name: toolDef.name,
          description: toolDef.description || "",
          parameters: ensureObjectSchema(sanitizeSchemaForGemini(toolDef.input)),
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

  const metadata = (tool as any).metadata || tool;
  // Read inputSchema (JSON Schema, set by enrichMetadata) or input (Zod/raw),
  // then fall back to empty object schema.
  const rawSchema = metadata?.inputSchema ?? metadata?.input;
  return {
    functionDeclarations: [
      {
        name: metadata?.id || metadata?.name || "unknown",
        description: metadata?.description || "",
        parameters: ensureObjectSchema(sanitizeSchemaForGemini(rawSchema)),
      },
    ],
  };
}
