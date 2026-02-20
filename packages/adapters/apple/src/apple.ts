/**
 * Apple Foundation Models Adapter
 *
 * Wraps Apple's on-device Foundation Models (~3B parameter) via a compiled
 * Swift bridge executable. Communicates over stdin/stdout JSON:
 *
 *   Node.js ──stdin JSON──▶ Swift bridge ──stdout JSON/NDJSON──▶ Node.js
 *
 * Non-streaming: single JSON ModelOutput on stdout
 * Streaming: NDJSON lines, each an AdapterDelta-compatible object
 *
 * Requires macOS 26+ with Apple Intelligence enabled.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAdapter,
  StopReason,
  type ModelClass,
  type ModelInput,
  type ModelOutput,
} from "@agentick/core/model";
import { normalizeModelInput } from "@agentick/core/utils";
import type { Message, ContentBlock } from "@agentick/shared";
import type {
  AppleAdapterConfig,
  BridgeInput,
  BridgeOutput,
  BridgeChunk,
  BridgeMessage,
  BridgeResponseFormat,
  BridgeJsonSchema,
  BridgeSchemaProperty,
  EmbedBridgeInput,
  EmbedBridgeOutput,
} from "./types";
import { STOP_REASON_MAP } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_PATH = join(__dirname, "..", "bin", "apple-fm-bridge");

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an Apple Foundation Models adapter.
 *
 * Uses a compiled Swift bridge to communicate with the on-device model.
 * The bridge must be compiled from the provided inference.swift:
 *
 * ```bash
 * swiftc -parse-as-library -framework FoundationModels inference.swift -o apple-fm-bridge
 * ```
 */
export function createAppleModel(config: AppleAdapterConfig = {}): ModelClass {
  const modelId = config.model ?? "apple-foundation-3b";
  const bridgePath = resolveBridgePath(config.bridgePath);

  return createAdapter<BridgeInput, BridgeOutput, BridgeChunk>({
    metadata: {
      id: modelId,
      provider: "apple",
      model: modelId,
      type: "language",
      capabilities: [
        { stream: true, toolCalls: false },
        {
          messageTransformation: () => ({
            preferredRenderer: "markdown",
            roleMapping: {
              event: "user",
              ephemeral: "user",
            },
          }),
        },
      ],
      contextWindow: 4096,
      supportsVision: false,
      supportsToolUse: false,
      supportsStructuredOutput: true,
    },

    prepareInput: (input: ModelInput) => {
      const normalized = normalizeModelInput(input, { model: modelId });

      // Extract system prompt from system-role messages or system field
      const systemMessages = normalized.messages.filter((m) => m.role === "system");
      const system =
        input.system ||
        systemMessages
          .map((m) =>
            m.content
              .filter((b): b is ContentBlock & { text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n"),
          )
          .join("\n") ||
        undefined;

      // Convert non-system messages to bridge wire format
      const messages: BridgeMessage[] = normalized.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role,
          content: m.content.map((b) => {
            if (b.type === "text") return { type: "text", text: (b as any).text };
            return { type: b.type, text: JSON.stringify(b) };
          }),
        }));

      // Map ResponseFormat to BridgeResponseFormat
      const responseFormat = input.responseFormat
        ? convertResponseFormat(input.responseFormat)
        : undefined;

      return {
        messages,
        system,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        stream: false,
        responseFormat,
      };
    },

    mapChunk: (chunk: BridgeChunk) => {
      switch (chunk.type) {
        case "text":
          return { type: "text", delta: chunk.delta };
        case "message_end":
          return {
            type: "message_end",
            stopReason: STOP_REASON_MAP[chunk.stopReason] ?? StopReason.STOP,
            usage: chunk.usage,
          };
        case "error":
          return { type: "error", error: chunk.error };
        default:
          return null;
      }
    },

    processOutput: async (output: BridgeOutput): Promise<ModelOutput> => {
      const content: ContentBlock[] = output.message.content.map((b) => ({
        type: "text" as const,
        text: b.text,
      }));

      const message: Message = { role: "assistant", content };

      return {
        model: output.model,
        createdAt: output.createdAt,
        messages: [message],
        message,
        stopReason: STOP_REASON_MAP[output.stopReason] ?? StopReason.STOP,
        usage: output.usage,
        raw: output,
      };
    },

    execute: async (input: BridgeInput) => {
      return runBridge(bridgePath, { ...input, stream: false });
    },

    executeStream: async function* (input: BridgeInput) {
      yield* streamBridge(bridgePath, { ...input, stream: true });
    },

    embed: async (texts) => {
      const input: EmbedBridgeInput = { operation: "embed", texts, script: "latin" };
      const output = await runEmbedBridge(bridgePath, input);
      return { embeddings: output.embeddings, dimensions: output.dimensions, model: output.model };
    },
  });
}

/**
 * Convenience factory for creating an Apple Foundation Models adapter.
 *
 * The bridge binary is auto-compiled on install. No config needed for defaults.
 *
 * @example
 * ```typescript
 * import { apple } from '@agentick/apple';
 *
 * const model = apple();
 *
 * // Or with explicit bridge path
 * const model = apple({ bridgePath: '/path/to/apple-fm-bridge' });
 * ```
 */
export function apple(config: AppleAdapterConfig = {}): ModelClass {
  return createAppleModel(config);
}

// ============================================================================
// Response Format Conversion
// ============================================================================

function convertResponseFormat(
  format: NonNullable<ModelInput["responseFormat"]>,
): BridgeResponseFormat | undefined {
  if (format.type === "text") {
    return { type: "text" };
  }
  if (format.type === "json") {
    return { type: "json" };
  }
  if (format.type === "json_schema") {
    // Convert JSON Schema to BridgeJsonSchema
    const schema = format.schema as any;
    return {
      type: "json_schema",
      schema: convertJsonSchema(schema),
      name: format.name,
    };
  }
  return undefined;
}

function convertJsonSchema(schema: any): BridgeJsonSchema {
  if (schema.type !== "object") {
    throw new Error("Apple Foundation Models only supports object root schemas");
  }

  const properties: Record<string, BridgeSchemaProperty> = {};
  for (const [key, value] of Object.entries(schema.properties || {})) {
    properties[key] = convertSchemaProperty(value as any);
  }

  return {
    type: "object",
    properties,
    description: schema.description,
  };
}

function convertSchemaProperty(prop: any): BridgeSchemaProperty {
  const base: BridgeSchemaProperty = {
    type: prop.type === "integer" ? "integer" : prop.type,
    description: prop.description,
  };

  if (prop.type === "object" && prop.properties) {
    base.properties = {};
    for (const [key, value] of Object.entries(prop.properties)) {
      base.properties[key] = convertSchemaProperty(value as any);
    }
  }

  if (prop.type === "array" && prop.items) {
    base.items = convertSchemaProperty(prop.items);
  }

  return base;
}

// ============================================================================
// Bridge Path Resolution
// ============================================================================

function resolveBridgePath(explicit?: string): string {
  if (explicit) return explicit;

  // Default: compiled binary next to this package
  if (existsSync(DEFAULT_BRIDGE_PATH)) return DEFAULT_BRIDGE_PATH;

  // Fallback: check if it's in PATH (e.g. node_modules/.bin symlink)
  return "apple-fm-bridge";
}

// ============================================================================
// Process Bridge
// ============================================================================

/** Spawn the Swift bridge, write JSON to stdin, collect full stdout as BridgeOutput */
function runBridge(bridgePath: string, input: BridgeInput): Promise<BridgeOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bridgePath, [], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Apple FM bridge at ${bridgePath}: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Apple FM bridge exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const output = JSON.parse(stdout.trim());
        if (output.type === "error") {
          reject(new Error(`Apple Foundation Models: ${output.error}`));
          return;
        }
        resolve(output);
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

/** Spawn the Swift bridge, write JSON to stdin, yield NDJSON chunks from stdout */
async function* streamBridge(bridgePath: string, input: BridgeInput): AsyncIterable<BridgeChunk> {
  const proc = spawn(bridgePath, [], { stdio: ["pipe", "pipe", "pipe"] });

  let stderrBuf = "";
  proc.stderr.on("data", (data: Buffer) => {
    stderrBuf += data.toString();
  });

  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  let buffer = "";

  for await (const data of proc.stdout) {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        yield JSON.parse(trimmed) as BridgeChunk;
      } catch {
        // skip unparseable lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as BridgeChunk;
    } catch {
      // skip
    }
  }

  if (stderrBuf.trim()) {
    yield { type: "error", error: stderrBuf.trim() };
  }
}

// ============================================================================
// Embedding Bridge
// ============================================================================

/** Spawn the Swift bridge with embed operation, collect output as EmbedBridgeOutput */
function runEmbedBridge(bridgePath: string, input: EmbedBridgeInput): Promise<EmbedBridgeOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bridgePath, [], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Apple FM bridge at ${bridgePath}: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Apple FM bridge exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const output = JSON.parse(stdout.trim());
        if (output.type === "error") {
          reject(new Error(`Apple embedding: ${output.error}`));
          return;
        }
        resolve(output);
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}
