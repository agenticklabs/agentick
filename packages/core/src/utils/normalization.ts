import type { Message } from "@agentick/shared";
import { toJSONSchema, detectSchemaType } from "@agentick/kernel";
import { toolRegistry } from "./registry.js";
import type {
  ModelConfig,
  ModelInput,
  ModelToolReference,
  NormalizedModelInput,
  NormalizedModelTool,
} from "../model/model.js";
import type { ExecutableTool, ToolMetadata } from "../tool/tool.js";

export async function normalizeModelInput<TConfig extends ModelConfig = ModelConfig>(
  input: ModelInput,
  config: TConfig,
): Promise<NormalizedModelInput> {
  const defaults: Partial<ModelInput> = {
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    frequencyPenalty: config.frequencyPenalty,
    presencePenalty: config.presencePenalty,
    stop: config.stop,
    tools: config.tools,
  };

  const mergedInput: ModelInput = {
    ...defaults,
    ...input,
  };

  if (defaults.tools && input.tools) {
    mergedInput.tools = [...defaults.tools, ...input.tools];
  }

  const resolvedModel = mergedInput.model ?? config.model;

  if (!resolvedModel) {
    throw new Error("Model identifier must be provided via input.model or configuration");
  }

  if (!mergedInput.messages) {
    throw new Error("Model input must include messages");
  }

  const normalizedMessages = normalizeMessages(mergedInput.messages);

  const { tools: toolReferences = [], ...rest } = mergedInput;

  const normalized: NormalizedModelInput = {
    ...(rest as Omit<ModelInput, "messages" | "tools">),
    model: resolvedModel,
    messages: normalizedMessages,
    tools: await resolveTools(toolReferences),
  };

  return normalized;
}

export async function resolveTools(
  toolReferences: ModelToolReference[],
): Promise<NormalizedModelTool[]> {
  const resolved: NormalizedModelTool[] = [];

  for (const ref of toolReferences) {
    // Check for ExecutableTool (including Tool instances)
    if (isExecutableTool(ref)) {
      resolved.push({
        id: ref.metadata.name,
        metadata: await enrichMetadata(ref.metadata),
      });
      continue;
    }

    if (typeof ref === "string") {
      const tool = toolRegistry.get(ref);
      if (tool) {
        resolved.push({
          id: tool.metadata.name,
          metadata: await enrichMetadata(tool.metadata),
        });
      } else {
        console.warn(`Tool reference '${ref}' not found in registry during normalization.`);
      }
      continue;
    }

    // Handle ToolMetadata
    if (isToolMetadata(ref)) {
      resolved.push({
        id: ref.name,
        metadata: await enrichMetadata(ref),
      });
      continue;
    }
  }
  return resolved;
}

/**
 * Enrich tool metadata with a pre-computed `inputSchema` (JSON Schema).
 *
 * Uses kernel's `detectSchemaType` to determine the input format:
 * - "json-schema" → pass through directly (common for MCP-discovered tools)
 * - "zod3"/"zod4"/"standard-*" → convert via kernel's `toJSONSchema`
 *
 * Adapters read `metadata.inputSchema` for provider-specific conversion
 * (e.g., Gemini schema sanitization).
 */
async function enrichMetadata(metadata: ToolMetadata): Promise<ToolMetadata> {
  if ((metadata as any).inputSchema) return metadata;
  if (!metadata.input) return metadata;

  let inputSchema: Record<string, unknown> | undefined;
  const schemaType = detectSchemaType(metadata.input);

  if (schemaType === "json-schema") {
    // Already JSON Schema — no conversion needed
    inputSchema = metadata.input as unknown as Record<string, unknown>;
  } else if (schemaType !== "unknown") {
    // Zod, Standard Schema, etc. — convert via kernel
    try {
      inputSchema = await toJSONSchema(metadata.input);
    } catch {
      // Schema conversion failed — adapter will handle raw input
    }
  }

  if (inputSchema && Object.keys(inputSchema).length > 0) {
    return { ...metadata, inputSchema } as any;
  }
  return metadata;
}

function isExecutableTool(obj: any): obj is ExecutableTool {
  return obj && typeof obj === "object" && "metadata" in obj && "run" in obj;
}

function isToolMetadata(obj: any): obj is ToolMetadata {
  return obj && typeof obj === "object" && "name" in obj && "description" in obj && "input" in obj;
}

export function normalizeMessages(messages: string | string[] | Message[]): Message[] {
  if (typeof messages === "string") {
    return [
      {
        role: "user",
        content: [{ type: "text", text: messages }],
      },
    ];
  }

  if (Array.isArray(messages) && messages.length > 0) {
    // Check if it's an array of strings
    if (typeof messages[0] === "string") {
      return (messages as string[]).map((msg) => ({
        role: "user",
        content: [{ type: "text", text: msg }],
      }));
    }
    // Otherwise assume it's already Message[]
    return messages as Message[];
  }

  return messages as Message[];
}
