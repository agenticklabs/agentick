/**
 * # Agentick Google AI Adapter
 *
 * Native Google AI (Gemini) adapter for Agentick. Provides direct integration
 * with Google's Gemini models without requiring the Vercel AI SDK.
 *
 * ## Features
 *
 * - **Native API** - Direct Google AI API integration
 * - **Streaming** - Full streaming support
 * - **Tool Calling** - Native function calling support
 * - **Multimodal** - Image and document understanding
 * - **All Models** - Gemini Pro, Gemini Flash, and more
 *
 * ## Quick Start
 *
 * ```typescript
 * import { google } from '@agentick/google';
 *
 * const model = google('gemini-1.5-pro');
 *
 * // Use with app
 * const app = createApp(<MyAgent />);
 * const result = await app.run({ messages });
 * ```
 *
 * @module @agentick/google
 */
export * from "./google.js";
export * from "./google.model.js";
