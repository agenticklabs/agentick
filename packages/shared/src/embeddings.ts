/**
 * Embedding types — shared across all embedding adapters.
 *
 * EmbedInput mirrors ModelInput style: single object, named fields.
 * EmbedResult is the normalized output.
 */

/** Input for embedding generation. */
export interface EmbedInput {
  /** Model to use for embedding. */
  model?: string;
  /** Text inputs to embed. */
  input: string | string[];
  /** Output dimensionality (model-dependent, e.g. 256, 768, 3072). */
  dimensions?: number;
  /** Task type hint for the embedding model (e.g. "retrieval_query", "retrieval_document"). */
  taskType?: string;
}

/** Wire-safe embedding output — shared across all embedding adapters. */
export interface EmbedResult {
  embeddings: number[][];
  dimensions: number;
  model: string;
  usage?: { totalTokens: number };
}
