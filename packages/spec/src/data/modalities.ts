/**
 * Modality data shapes (ADR 105) — the inputs and results of the
 * `image-model` and `embedding-model` executor families. Adapter + executor
 * PROTOCOLS live beside the language-model family in
 * `protocol/executor.ts`; these are the wire-safe values they exchange.
 *
 * Every result extends {@link ExecutionResult}: generated images ride
 * `output` as image blocks too, so a result renders without knowing its
 * family, and `usage` / `finishMetadata` mean what they mean everywhere.
 */

import type { MediaSource } from "./content-blocks.js";
import type { ExecutionResult } from "./execution-result.js";
import type { ProviderOptions } from "./rendered-tree.js";

// ── image-model ─────────────────────────────────────────────────────────────

export type GeneratedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageGenerateInput {
  readonly prompt: string;
  /**
   * Reference images — an edit or variation of existing pixels. The provider
   * decides the mechanism (a dedicated edit endpoint, or an image-capable
   * generation model given the references as parts).
   */
  readonly references?: readonly MediaSource[];
  /** How many candidates to produce. Default 1. */
  readonly count?: number;
  /** `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"` — provider-validated. */
  readonly aspectRatio?: string;
  readonly mimeType?: GeneratedImageMimeType;
  readonly negativePrompt?: string;
  readonly seed?: number;
  readonly providerOptions?: ProviderOptions;
}

export interface GeneratedImage {
  /** Base64 bytes. Providers that return a URI are projected to bytes by their adapter. */
  readonly data: string;
  readonly mimeType: string;
  /** The prompt the provider actually rendered, when it rewrote the caller's. */
  readonly enhancedPrompt?: string;
}

export interface ImageGenerateResult extends ExecutionResult {
  readonly images: readonly GeneratedImage[];
}

// ── embedding-model ─────────────────────────────────────────────────────────

export interface EmbedInput {
  readonly input: readonly string[];
  /** Requested vector length; provider truncates/validates. */
  readonly dimensions?: number;
  /** Retrieval role — providers tune the embedding for the side it will sit on. */
  readonly task?: "query" | "document";
  readonly providerOptions?: ProviderOptions;
}

export interface EmbedResult extends ExecutionResult {
  /** One vector per `input` entry, in order. */
  readonly embeddings: readonly (readonly number[])[];
  readonly dimensions: number;
}
