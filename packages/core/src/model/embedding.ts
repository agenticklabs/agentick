/**
 * Embedding Model System
 *
 * Mirrors the generation model pattern (EngineModel + createAdapter) for embeddings.
 * Embeddings don't stream — the pipeline is simpler: prepareInput → execute → processOutput.
 *
 * @example
 * ```typescript
 * import { createEmbeddingAdapter } from '@agentick/core/model';
 *
 * const embedder = createEmbeddingAdapter({
 *   metadata: { id: 'my-embedder', provider: 'my-provider', dimensions: 384 },
 *   prepareInput: (texts) => ({ texts, model: 'my-model' }),
 *   execute: (input) => provider.embed(input),
 *   processOutput: (output) => ({ embeddings: output.data, dimensions: 384, model: 'my-model' }),
 * });
 *
 * const result = await embedder.embed(["Hello world"]);
 * ```
 */

import type { EmbedResult } from "@agentick/shared";
import type { ProviderGenerationOptions, LibraryGenerationOptions } from "../types.js";

// ============================================================================
// Options
// ============================================================================

export interface EmbedOptions {
  dimensions?: number;
  providerOptions?: ProviderGenerationOptions;
  libraryOptions?: LibraryGenerationOptions;
}

// ============================================================================
// Interface
// ============================================================================

export interface EmbeddingMetadata {
  id: string;
  provider: string;
  dimensions: number;
  model?: string;
  description?: string;
}

export interface EmbeddingModel {
  metadata: EmbeddingMetadata;
  embed(texts: string[], options?: EmbedOptions): Promise<EmbedResult>;
}

export function isEmbeddingModel(value: unknown): value is EmbeddingModel {
  return (
    value != null &&
    typeof value === "object" &&
    "metadata" in value &&
    "embed" in value &&
    typeof (value as EmbeddingModel).embed === "function"
  );
}

// ============================================================================
// Factory
// ============================================================================

export interface EmbeddingAdapterOptions<TProviderInput, TProviderOutput> {
  metadata: EmbeddingMetadata;

  /** Convert texts + options to provider-specific input (like createAdapter.prepareInput) */
  prepareInput: (
    texts: string[],
    options?: EmbedOptions,
  ) => TProviderInput | Promise<TProviderInput>;

  /** Call the provider's embedding API (like createAdapter.execute) */
  execute: (input: TProviderInput) => Promise<TProviderOutput>;

  /** Convert provider output to normalized EmbedResult (like createAdapter.processOutput) */
  processOutput: (output: TProviderOutput) => EmbedResult | Promise<EmbedResult>;
}

/**
 * Create an embedding adapter with the standard prepareInput → execute → processOutput pipeline.
 *
 * This mirrors createAdapter's structure but without streaming (embeddings don't stream).
 */
export function createEmbeddingAdapter<TProviderInput, TProviderOutput>(
  options: EmbeddingAdapterOptions<TProviderInput, TProviderOutput>,
): EmbeddingModel {
  return {
    metadata: options.metadata,
    embed: async (texts, opts) => {
      const input = await options.prepareInput(texts, opts);
      const output = await options.execute(input);
      return options.processOutput(output);
    },
  };
}
