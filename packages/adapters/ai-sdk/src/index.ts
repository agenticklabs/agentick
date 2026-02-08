/**
 * # Agentick Vercel AI SDK Adapter
 *
 * Use Vercel AI SDK models with Agentick apps.
 *
 * ## Usage
 *
 * ```typescript
 * import { createApp } from '@agentick/core/app';
 * import { aiSdk } from '@agentick/ai-sdk';
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
 * @module @agentick/ai-sdk
 */

// ============================================================================
// Engine Integration - Model Adapter
// ============================================================================

// Use ai-sdk models within our Engine
export { createAiSdkModel, aiSdk, type AiSdkAdapterConfig } from "./adapter";

// Conversion utilities (for advanced use cases)
export {
  // AI SDK → Engine conversions
  fromAiSdkMessages,
  mapAiSdkContentToContentBlocks,
  mapAiSdkPartToContentBlock,
  // Engine → AI SDK conversions
  toAiSdkMessages,
  mapContentBlocksToAiSdkContent,
  mapContentBlockToAiSdkPart,
  mapToolResultContent,
  // Tool conversion
  convertToolsToToolSet,
  // Stop reason mapping
  toStopReason,
  // Types
  type ToolResultOutput,
} from "./adapter";
