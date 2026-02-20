/**
 * # Agentick Apple Foundation Models Adapter
 *
 * On-device inference via Apple's Foundation Models framework (macOS 26+).
 * Uses a compiled Swift bridge executable for communication.
 *
 * ## Features
 *
 * - **On-Device** — ~3B parameter model running locally on Apple Silicon
 * - **Streaming** — Full streaming support via NDJSON
 * - **Vision** — Multimodal input (text + images)
 * - **Private** — All inference on-device, no network required
 * - **Free** — No API keys or usage costs
 *
 * ## Prerequisites
 *
 * 1. macOS 26+ (Tahoe) with Apple Intelligence enabled
 * 2. Compile the Swift bridge:
 *    ```bash
 *    swiftc -parse-as-library -framework FoundationModels inference.swift -o apple-fm-bridge
 *    ```
 *
 * ## Quick Start
 *
 * ```typescript
 * import { apple } from '@agentick/apple';
 *
 * const model = apple({ bridgePath: './apple-fm-bridge' });
 * const app = createApp(Agent, { model });
 * ```
 *
 * @module @agentick/apple
 */
export * from "./apple-model";
export * from "./apple";
export { appleEmbedding } from "./embedding";
export type {
  AppleAdapterConfig,
  AppleEmbeddingConfig,
  EmbeddingScript,
  BridgeInput,
  BridgeOutput,
  BridgeChunk,
} from "./types";
