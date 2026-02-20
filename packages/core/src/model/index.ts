/**
 * # Agentick Models
 *
 * Model adapters and utilities for connecting to AI providers.
 * Models are the interface between Agentick and AI services.
 *
 * ## Features
 *
 * - **createAdapter** - Factory for creating model adapters (recommended)
 * - **ModelClass** - Unified type for JSX + programmatic use
 * - **EngineModel** - Core interface for all models
 * - **StreamAccumulator** - Built-in streaming support
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createAdapter, StopReason } from '@agentick/core/model';
 *
 * const model = createAdapter({
 *   metadata: { id: 'my-model', provider: 'my-provider', capabilities: [] },
 *   prepareInput: (input) => ({ model: 'gpt-4', messages: input.messages }),
 *   mapChunk: (chunk) => ({ type: 'text', delta: chunk.text }),
 *   execute: (input) => provider.generate(input),
 *   executeStream: (input) => provider.stream(input),
 * });
 *
 * // Use as JSX component
 * <model temperature={0.9}><MyAgent /></model>
 *
 * // Use with createApp
 * const app = createApp(Agent, { model });
 *
 * // Direct execution
 * const output = await model.generate(input);
 * ```
 *
 * ## Pre-built Adapters
 *
 * - `@agentick/ai-sdk` - Vercel AI SDK (multi-provider)
 * - `@agentick/openai` - OpenAI native
 * - `@agentick/google` - Google AI native
 *
 * @see {@link createAdapter} - Main adapter factory
 * @see {@link ModelClass} - Unified model type
 *
 * @module agentick/model
 */

export * from "./model";
export * from "./model-hooks";
export * from "./utils";

// Adapter creation
export * from "./stream-accumulator"; // AdapterDelta, StreamAccumulator
export * from "./adapter"; // createAdapter factory
export * from "./adapter-helpers"; // Composable helpers for adapters

// Embedding adapters
export * from "./embedding";
