/**
 * Apple On-Device Embeddings
 *
 * Generates vector embeddings using Apple's NLContextualEmbedding model,
 * running entirely on-device via the NaturalLanguage framework.
 *
 * - 768 dimensions on macOS, 512 on iOS
 * - 27+ languages across 6 script models
 * - Completely private — no network calls
 *
 * @example
 * ```typescript
 * import { appleEmbedding } from '@agentick/apple';
 *
 * const embedder = appleEmbedding();
 * const result = await embedder.embed(["Hello world"]);
 * // result.embeddings[0] → number[512]
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbeddingAdapter, type EmbeddingModel } from "@agentick/core/model";
import type { AppleEmbeddingConfig, EmbedBridgeInput, EmbedBridgeOutput } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE_PATH = join(__dirname, "..", "bin", "apple-fm-bridge");

/**
 * Create an Apple on-device embedding model.
 *
 * Uses NLContextualEmbedding under the hood — mean-pooled token vectors
 * producing a single vector per input text.
 *
 * @example
 * ```typescript
 * const embedder = appleEmbedding({ script: "latin" });
 * const { embeddings } = await embedder.embed(["machine learning"]);
 * console.log(embeddings[0].length); // 512
 * ```
 */
export function appleEmbedding(config: AppleEmbeddingConfig = {}): EmbeddingModel {
  const script = config.script ?? "latin";
  const bridgePath = resolveBridgePath(config.bridgePath);

  return createEmbeddingAdapter<EmbedBridgeInput, EmbedBridgeOutput>({
    metadata: {
      id: "apple-contextual-embedding",
      provider: "apple",
      dimensions: 512,
      model: "apple-contextual-embedding",
    },

    prepareInput: (texts, _options) => ({
      operation: "embed" as const,
      texts,
      script,
      language: config.language,
    }),

    execute: (input) => runBridge(bridgePath, input),

    processOutput: (output) => ({
      embeddings: output.embeddings,
      dimensions: output.dimensions,
      model: output.model,
    }),
  });
}

function resolveBridgePath(explicit?: string): string {
  if (explicit) return explicit;
  if (existsSync(DEFAULT_BRIDGE_PATH)) return DEFAULT_BRIDGE_PATH;
  return "apple-fm-bridge";
}

function runBridge(bridgePath: string, input: EmbedBridgeInput): Promise<EmbedBridgeOutput> {
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
