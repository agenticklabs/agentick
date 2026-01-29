/**
 * # Tentickle Vercel AI SDK Adapter
 *
 * Use Vercel AI SDK models with Tentickle apps.
 *
 * ## Usage
 *
 * ```typescript
 * import { createApp } from '@tentickle/core/app';
 * import { aiSdk } from '@tentickle/ai-sdk';
 * import { openai } from '@ai-sdk/openai';
 *
 * // Create an EngineModel from AI SDK LanguageModel
 * const model = aiSdk({ model: openai('gpt-4') });
 *
 * // Use with createApp
 * const app = createApp(MyAgent, { model });
 *
 * // Or pass different model per run
 * const result = await app.run({
 *   props: { query: "Hello!" },
 *   messages: [...],
 * });
 * ```
 *
 * ## Swapping Models
 *
 * The model can be:
 * 1. Set at app creation: `createApp(Component, { model })`
 * 2. Declared in JSX: `<Model model={aiSdk({ model: openai('gpt-4') })} />`
 * 3. Swapped at runtime via component state
 *
 * @see {@link aiSdk} - Create EngineModel from AI SDK LanguageModel
 * @see {@link createAiSdkModel} - Alternative factory function
 *
 * @module @tentickle/ai-sdk
 */

// ============================================================================
// Engine Integration - Model Adapter
// ============================================================================

// Use ai-sdk models within our Engine
export { createAiSdkModel, aiSdk, type AiSdkAdapter, type AiSdkAdapterConfig } from "./adapter";

// Conversion utilities (for advanced use cases)
export {
  // AI SDK → Engine conversions
  aiSdkMessagesToEngineInput,
  fromAiSdkInputMessages,
  fromAiSdkMessages,
  mapAiSdkContentToContentBlocks,
  mapAiSdkPartToContentBlock,
  mapToolResultToContentBlocks,
  // Engine → AI SDK conversions
  toAiSdkMessages,
  toAiSdkCompiledInput,
  mapContentBlocksToAiSdkContent,
  mapContentBlockToAiSdkPart,
} from "./adapter";
