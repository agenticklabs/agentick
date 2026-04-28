/**
 * # Agentick AWS Bedrock Adapter
 *
 * Native AWS Bedrock Converse API adapter for Agentick. Provides direct integration
 * with AWS Bedrock models without requiring the Vercel AI SDK.
 *
 * ## Features
 *
 * - **Native API** - Direct AWS Bedrock Converse API integration
 * - **Streaming** - Full streaming support via ConverseStream
 * - **Tool Calling** - Native tool use support
 * - **Multimodal** - Image and document understanding
 * - **All Models** - Claude, Llama, Mistral, and more via Bedrock
 *
 * ## Quick Start
 *
 * ```typescript
 * import { bedrock } from '@agentick/bedrock';
 *
 * const model = bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0');
 *
 * // Use with app
 * const app = createApp(<MyAgent />);
 * const result = await app.run({ messages });
 * ```
 *
 * @module @agentick/bedrock
 */
export * from "./bedrock.js";
export * from "./bedrock-model.js";
export * from "./types.js";
