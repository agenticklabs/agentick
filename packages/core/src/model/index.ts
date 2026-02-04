/**
 * # Tentickle Models
 *
 * Model adapters and utilities for connecting to AI providers.
 * Models are the interface between Tentickle and AI services.
 *
 * ## Features
 *
 * - **ModelAdapter** - Base class for model adapters
 * - **createModel** - Factory for creating model instances
 * - **Model Hooks** - Before/after hooks for model calls
 * - **Streaming** - Built-in streaming support
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createModel } from 'tentickle/model';
 *
 * // Create a model using an adapter
 * const model = createModel({
 *   adapter: openaiAdapter,
 *   model: 'gpt-4o',
 * });
 *
 * // Use in an engine
 * const engine = new Engine({ model });
 * ```
 *
 * ## Adapters
 *
 * Use pre-built adapters from:
 * - `@tentickle/ai-sdk` - Vercel AI SDK
 * - `@tentickle/openai` - OpenAI native
 * - `@tentickle/google` - Google AI native
 *
 * @see {@link ModelAdapter} - Base adapter class
 * @see {@link createModel} - Model factory
 *
 * @module tentickle/model
 */

export * from "./model";
export * from "./model-hooks";
export * from "./utils";

// Adapter creation
export * from "./stream-accumulator"; // AdapterDelta, StreamAccumulator
export * from "./adapter"; // createAdapter factory
export * from "./adapter-helpers"; // Composable helpers for adapters
