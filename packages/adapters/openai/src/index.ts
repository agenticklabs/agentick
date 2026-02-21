/**
 * # Agentick OpenAI Adapter
 *
 * Native OpenAI API adapter for Agentick. Provides direct integration with
 * OpenAI models without requiring the Vercel AI SDK.
 *
 * ## Features
 *
 * - **Native API** - Direct OpenAI API integration
 * - **Streaming** - Full streaming support with deltas
 * - **Tool Calling** - Native function calling support
 * - **All Models** - GPT-4o, GPT-4, GPT-3.5, and more
 *
 * ## Quick Start
 *
 * ```typescript
 * import { openai } from '@agentick/openai';
 *
 * const model = openai('gpt-4o');
 *
 * // Use with app
 * const app = createApp(<MyAgent />);
 * const result = await app.run({ messages });
 * ```
 *
 * @module @agentick/openai
 */
export * from "./openai-model.js";
export * from "./openai.js";
