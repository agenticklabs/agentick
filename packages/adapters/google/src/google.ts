/**
 * Google GenAI Adapter
 *
 * Native Google GenAI adapter for use with the engine.
 * Uses createAdapter for minimal boilerplate.
 */

import type { GenerateContentResponse } from "@google/genai";
import { GoogleGenAI, type GenerateContentParameters, FinishReason } from "@google/genai";

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
  type ContentBlock,
  type Message,
  type TextBlock,
  StopReason,
  AdapterError,
  ValidationError,
} from "@tentickle/shared";
import { type GoogleAdapterConfig, STOP_REASON_MAP } from "./types";

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
        const normalizedInput = normalizeModelInput(input, config);
        const contents: any[] = [];
        let systemInstruction: string | undefined;

        for (const message of normalizedInput.messages) {
          if (message.role === "system") {
            systemInstruction = message.content
              .filter((block) => block.type === "text")
              .map((block) => (block as TextBlock).text)
              .join("\n\n");
            continue;
          }

          const parts = convertBlocksToGoogleParts(message.content);
          if (parts.length === 0) continue;

          contents.push({
            role: message.role === "assistant" ? "model" : "user",
            parts,
          });
        }

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

      mapChunk: (chunk: GenerateContentResponse): AdapterDelta | null => {
        const candidate = chunk.candidates?.[0];
        if (!candidate) return null;

        const parts = candidate.content?.parts || [];

        // Text content
        for (const part of parts) {
          if (part.text) {
            return { type: "text", delta: part.text };
          }

          // Function calls
          if (part.functionCall) {
            return {
              type: "tool_call",
              id: part.functionCall.name || "",
              name: part.functionCall.name || "",
              input: part.functionCall.args || {},
            };
          }
        }

        // Finish reason
        if (candidate.finishReason) {
          return {
            type: "message_end",
            stopReason: mapGoogleFinishReason(candidate.finishReason),
            usage: chunk.usageMetadata
              ? {
                  inputTokens: chunk.usageMetadata.promptTokenCount || 0,
                  outputTokens: chunk.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: chunk.usageMetadata.totalTokenCount || 0,
                }
              : undefined,
          };
        }

        return null;
      },

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
            content.push({
              type: "tool_use",
              toolUseId: part.functionCall.name || "",
              name: part.functionCall.name || "",
              input: part.functionCall.args || {},
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
          },
          modelVersion: accumulated.model || firstChunk?.modelVersion,
        } as GenerateContentResponse;

        return reconstructed;
      },
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
        const resultText =
          block.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") || JSON.stringify(block.content);

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

export function mapToolDefinition(tool: any): any {
  if (typeof tool === "string") {
    return {
      functionDeclarations: [{ name: tool, description: "", parameters: {} }],
    };
  }

  if ("name" in tool && "input" in tool) {
    const toolDef = tool as ToolDefinition;
    const baseTool = {
      functionDeclarations: [
        {
          name: toolDef.name,
          description: toolDef.description || "",
          parameters: toolDef.input || {},
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
