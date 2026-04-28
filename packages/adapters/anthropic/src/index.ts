/**
 * # Agentick Anthropic Adapter
 *
 * Native Anthropic API adapter for Agentick. Provides direct integration with
 * Anthropic's Claude models without requiring the Vercel AI SDK.
 *
 * ## Features
 *
 * - **Native API** - Direct Anthropic API integration
 * - **Streaming** - Full streaming support with deltas
 * - **Tool Calling** - Native tool use support
 * - **All Models** - Claude Opus, Sonnet, Haiku, and more
 *
 * ## Quick Start
 *
 * ```typescript
 * import { anthropic } from '@agentick/anthropic';
 *
 * const model = anthropic('claude-sonnet-4-20250514');
 *
 * // Use with app
 * const app = createApp(<MyAgent />);
 * const result = await app.run({ messages });
 * ```
 *
 * @module @agentick/anthropic
 */
export * from "./anthropic.js";
export * from "./anthropic-model.js";
