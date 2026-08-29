/**
 * `@agentick/model-google` — Google (Gemini)
 * `LanguageModelAdapter` for Agentick v2 (ADR 52).
 *
 * Ships `google(model?, options?)`, a factory producing the
 * provider-normalization part consumed by the ONE
 * `LanguageModelExecutor` in `@agentick/model-executor`. Supports both
 * the Gemini Developer API (apiKey) and Vertex AI
 * (project/location/auth) paths.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 * @see docs/proposals/v2/V1-PARITY-TRACKER.md
 */

import { google as languageModel } from "./google-adapter.js";
import { googleEmbeddings, googleImages } from "./google-modalities.js";

export {
  type GoogleAdapterOptions,
  type CustomBlockDefinition,
  sanitizeSchemaForGemini,
} from "./google-adapter.js";

/**
 * The Google provider family (ADR 105): `google(model)` is the language-model
 * adapter; `google.images(model)` / `google.embeddings(model)` are the
 * image-model and embedding-model adapters, sharing options + client resolution.
 */
export const google = Object.assign(languageModel, {
  images: googleImages,
  embeddings: googleEmbeddings,
});

export {
  googleImages,
  googleEmbeddings,
  type GoogleImagesOptions,
  type GoogleEmbeddingsOptions,
  type GoogleModalityClient,
} from "./google-modalities.js";
