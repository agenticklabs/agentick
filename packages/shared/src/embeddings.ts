/** Wire-safe embedding output — shared across all embedding adapters. */
export interface EmbedResult {
  embeddings: number[][];
  dimensions: number;
  model: string;
  usage?: { totalTokens: number };
}
