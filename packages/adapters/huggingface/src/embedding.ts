/**
 * HuggingFace Local Embeddings
 *
 * Runs transformer models locally via @huggingface/transformers (ONNX Runtime).
 * Default model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~33MB).
 *
 * Pipeline is lazily initialized on first embed call.
 *
 * ## pnpm users
 *
 * `@huggingface/transformers` depends on `onnxruntime-node` which has a native
 * build step. pnpm 9+ blocks lifecycle scripts by default. Add to your
 * `pnpm-workspace.yaml`:
 *
 * ```yaml
 * onlyBuiltDependencies:
 *   - onnxruntime-node
 * ```
 *
 * @example
 * ```typescript
 * import { huggingfaceEmbedding } from '@agentick/huggingface';
 *
 * const embedder = huggingfaceEmbedding();
 * const result = await embedder.embed(["Hello world"]);
 * // result.embeddings[0] → number[384]
 * ```
 */

import { createEmbeddingAdapter, type EmbeddingModel } from "@agentick/core/model";
import type { HuggingFaceEmbeddingConfig } from "./types.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIMENSIONS = 384;

interface HFPipelineInput {
  texts: string[];
  pooling: string;
  normalize: boolean;
}

interface HFPipelineOutput {
  embeddings: number[][];
}

export function huggingfaceEmbedding(config: HuggingFaceEmbeddingConfig = {}): EmbeddingModel {
  const modelId = config.model ?? DEFAULT_MODEL;
  const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;

  // Pipeline state lives on this closure — each call to huggingfaceEmbedding()
  // gets its own pipeline, keyed to its own config. No module-global sharing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers pipeline types are loosely typed
  let extractor: any = null;
  let loading: Promise<void> | null = null;

  async function warmup(): Promise<void> {
    const { pipeline, env } = await import("@huggingface/transformers");
    if (config.cacheDir) env.cacheDir = config.cacheDir;
    extractor = await pipeline("feature-extraction", modelId, {
      dtype: config.dtype ?? "fp32",
    });
  }

  return createEmbeddingAdapter<HFPipelineInput, HFPipelineOutput>({
    metadata: {
      id: `hf:${modelId}`,
      provider: "huggingface",
      dimensions,
      model: modelId,
    },

    prepareInput: (texts, _options) => ({
      texts,
      pooling: "mean",
      normalize: true,
    }),

    execute: async (input) => {
      if (!extractor) {
        if (!loading) {
          loading = warmup().catch(() => {
            loading = null;
          });
        }
        await loading;
      }
      if (!extractor) throw new Error(`HuggingFace model ${modelId} failed to load`);

      const embeddings: number[][] = [];
      for (const text of input.texts) {
        const output = await extractor(text, {
          pooling: input.pooling,
          normalize: input.normalize,
        });
        embeddings.push(Array.from(output.tolist()[0]));
      }
      return { embeddings };
    },

    processOutput: (output) => ({
      embeddings: output.embeddings,
      dimensions,
      model: modelId,
    }),
  });
}
