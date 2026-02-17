/**
 * Model Catalog
 *
 * Reference data for known models including context windows and capabilities.
 * This is a best-effort catalog - actual limits may change.
 *
 * Architecture:
 * - MODEL_CATALOG is static reference data (defaults)
 * - Adapters are source of truth and can override via ModelMetadata
 * - Runtime additions via registerModel() for dynamic discovery
 * - Lookup order: runtime > static catalog
 *
 * Sources (as of February 2026):
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 * - OpenAI: https://platform.openai.com/docs/models
 * - Google: https://ai.google.dev/gemini-api/docs/models
 * - Mistral: https://mistral.ai/models
 * - Meta: https://www.llama.com/models/llama-4/
 */

export interface ModelInfo {
  /** Display name */
  name: string;
  /** Provider name */
  provider: string;
  /** Context window size in tokens */
  contextWindow: number;
  /** Max output tokens (if different from context window) */
  maxOutputTokens?: number;
  /** Model release/version date */
  releaseDate?: string;
  /** Whether the model supports vision/images */
  supportsVision?: boolean;
  /** Whether the model supports tool use */
  supportsToolUse?: boolean;
  /** Whether the model supports structured output via JSON schema */
  supportsStructuredOutput?: boolean;
  /** Whether this is a reasoning model (extended thinking) */
  isReasoningModel?: boolean;
}

/**
 * Runtime model registry for dynamic additions.
 * Takes precedence over MODEL_CATALOG.
 */
const runtimeRegistry = new Map<string, ModelInfo>();

/**
 * Register a model at runtime.
 * Use this for models discovered dynamically or provided by adapters.
 *
 * @param modelId - The model ID
 * @param info - Model information
 */
export function registerModel(modelId: string, info: ModelInfo): void {
  runtimeRegistry.set(modelId.toLowerCase(), info);
}

/**
 * Register multiple models at once.
 *
 * @param models - Map of model ID to model info
 */
export function registerModels(models: Record<string, ModelInfo>): void {
  for (const [id, info] of Object.entries(models)) {
    registerModel(id, info);
  }
}

/**
 * Clear all runtime-registered models.
 * Primarily for testing.
 */
export function clearRuntimeModels(): void {
  runtimeRegistry.clear();
}

/**
 * Get all runtime-registered models.
 */
export function getRuntimeModels(): Map<string, ModelInfo> {
  return new Map(runtimeRegistry);
}

/**
 * Known model context windows and capabilities.
 *
 * Keys are model IDs (case-insensitive matching recommended).
 * Includes common aliases and versioned names.
 *
 * Last updated: February 2026
 */
export const MODEL_CATALOG: Record<string, ModelInfo> = {
  // ════════════════════════════════════════════════════════════════════════════
  // Anthropic Claude Models
  // https://platform.claude.com/docs/en/about-claude/models/overview
  // ════════════════════════════════════════════════════════════════════════════

  // Claude 4 Series (2025)
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-opus-4": {
    name: "Claude Opus 4",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-opus-4-5-20251101": {
    name: "Claude Opus 4.5",
    provider: "anthropic",
    contextWindow: 200000, // 1M available for tier 4+
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-opus-4.5": {
    name: "Claude Opus 4.5",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    provider: "anthropic",
    contextWindow: 200000, // 1M available for tier 4+
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-sonnet-4": {
    name: "Claude Sonnet 4",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Claude 3.5 Series
  "claude-3-5-sonnet-20241022": {
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-5-sonnet-latest": {
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-5-sonnet": {
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-5-haiku-20241022": {
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-5-haiku-latest": {
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Claude 3 Series (legacy)
  "claude-3-opus-20240229": {
    name: "Claude 3 Opus",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-sonnet-20240229": {
    name: "Claude 3 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },
  "claude-3-haiku-20240307": {
    name: "Claude 3 Haiku",
    provider: "anthropic",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // OpenAI GPT Models
  // https://platform.openai.com/docs/models
  // ════════════════════════════════════════════════════════════════════════════

  // GPT-5.2 "Garlic" (December 2025)
  "gpt-5.2": {
    name: "GPT-5.2",
    provider: "openai",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-5.2-turbo": {
    name: "GPT-5.2 Turbo",
    provider: "openai",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-5
  "gpt-5": {
    name: "GPT-5",
    provider: "openai",
    contextWindow: 400000,
    maxOutputTokens: 32768,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-4.1 (1M context)
  "gpt-4.1": {
    name: "GPT-4.1",
    provider: "openai",
    contextWindow: 1047576, // ~1M
    maxOutputTokens: 32768,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4.1-mini": {
    name: "GPT-4.1 Mini",
    provider: "openai",
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-4o
  "gpt-4o": {
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4o-2024-11-20": {
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4o-2024-08-06": {
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4o-2024-05-13": {
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-4o Mini
  "gpt-4o-mini": {
    name: "GPT-4o Mini",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4o-mini-2024-07-18": {
    name: "GPT-4o Mini",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-4 Turbo
  "gpt-4-turbo": {
    name: "GPT-4 Turbo",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gpt-4-turbo-2024-04-09": {
    name: "GPT-4 Turbo",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: true,
    supportsToolUse: true,
  },

  // GPT-4 (legacy)
  "gpt-4": {
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "gpt-4-32k": {
    name: "GPT-4 32K",
    provider: "openai",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },

  // GPT-3.5 Turbo (legacy)
  "gpt-3.5-turbo": {
    name: "GPT-3.5 Turbo",
    provider: "openai",
    contextWindow: 16385,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },

  // o-Series (Reasoning models)
  o1: {
    name: "o1",
    provider: "openai",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },
  "o1-2024-12-17": {
    name: "o1",
    provider: "openai",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },
  "o1-preview": {
    name: "o1 Preview",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 32768,
    supportsVision: false,
    supportsToolUse: false,
    isReasoningModel: true,
  },
  "o1-mini": {
    name: "o1 Mini",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsVision: false,
    supportsToolUse: false,
    isReasoningModel: true,
  },
  "o3-mini": {
    name: "o3 Mini",
    provider: "openai",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsVision: false,
    supportsToolUse: true,
    isReasoningModel: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Google Gemini Models
  // https://ai.google.dev/gemini-api/docs/models
  // ════════════════════════════════════════════════════════════════════════════

  // Gemini 3 (Latest - 2026)
  "gemini-3-pro": {
    name: "Gemini 3 Pro",
    provider: "google",
    contextWindow: 1000000, // 1M
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-3-pro-latest": {
    name: "Gemini 3 Pro",
    provider: "google",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-3-flash": {
    name: "Gemini 3 Flash",
    provider: "google",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-3-flash-latest": {
    name: "Gemini 3 Flash",
    provider: "google",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Gemini 2.5 Pro
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    provider: "google",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-2.5-pro-latest": {
    name: "Gemini 2.5 Pro",
    provider: "google",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Gemini 2.0 Flash (deprecated March 3, 2026)
  "gemini-2.0-flash": {
    name: "Gemini 2.0 Flash",
    provider: "google",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-2.0-flash-exp": {
    name: "Gemini 2.0 Flash Experimental",
    provider: "google",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Gemini 1.5 Pro (deprecated)
  "gemini-1.5-pro": {
    name: "Gemini 1.5 Pro",
    provider: "google",
    contextWindow: 2097152, // 2M
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-1.5-pro-latest": {
    name: "Gemini 1.5 Pro",
    provider: "google",
    contextWindow: 2097152,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Gemini 1.5 Flash (deprecated)
  "gemini-1.5-flash": {
    name: "Gemini 1.5 Flash",
    provider: "google",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "gemini-1.5-flash-latest": {
    name: "Gemini 1.5 Flash",
    provider: "google",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Mistral AI Models
  // https://mistral.ai/models
  // ════════════════════════════════════════════════════════════════════════════

  // Mistral Large 3 (December 2025)
  "mistral-large-3": {
    name: "Mistral Large 3",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "mistral-large-latest": {
    name: "Mistral Large 3",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Devstral 2 (December 2025)
  "devstral-2": {
    name: "Devstral 2",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },
  "devstral-small-2": {
    name: "Devstral Small 2",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },

  // Mistral Small 3.1
  "mistral-small-3.1": {
    name: "Mistral Small 3.1",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "mistral-small-latest": {
    name: "Mistral Small 3.1",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Ministral 3 Family
  "ministral-3-3b": {
    name: "Ministral 3 3B",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "ministral-3-8b": {
    name: "Ministral 3 8B",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "ministral-3-14b": {
    name: "Ministral 3 14B",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },

  // Codestral
  codestral: {
    name: "Codestral",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },
  "codestral-latest": {
    name: "Codestral",
    provider: "mistral",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },

  // Legacy models
  "mistral-large-2": {
    name: "Mistral Large 2",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "mistral-medium": {
    name: "Mistral Medium",
    provider: "mistral",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "mistral-nemo": {
    name: "Mistral NeMo",
    provider: "mistral",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "mixtral-8x7b": {
    name: "Mixtral 8x7B",
    provider: "mistral",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Meta Llama Models
  // https://www.llama.com/models/llama-4/
  // ════════════════════════════════════════════════════════════════════════════

  // Llama 4 (2026)
  "llama-4-scout": {
    name: "Llama 4 Scout",
    provider: "meta",
    contextWindow: 10000000, // 10M tokens!
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "llama-4-scout-17b-16e": {
    name: "Llama 4 Scout 17B",
    provider: "meta",
    contextWindow: 10000000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "llama-4-maverick": {
    name: "Llama 4 Maverick",
    provider: "meta",
    contextWindow: 512000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },
  "llama-4-maverick-17b-128e": {
    name: "Llama 4 Maverick",
    provider: "meta",
    contextWindow: 512000,
    maxOutputTokens: 8192,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Llama 3.1 (legacy)
  "llama-3.1-405b": {
    name: "Llama 3.1 405B",
    provider: "meta",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "llama-3.1-70b": {
    name: "Llama 3.1 70B",
    provider: "meta",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },
  "llama-3.1-8b": {
    name: "Llama 3.1 8B",
    provider: "meta",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DeepSeek Models
  // ════════════════════════════════════════════════════════════════════════════

  "deepseek-chat": {
    name: "DeepSeek Chat",
    provider: "deepseek",
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },
  "deepseek-coder": {
    name: "DeepSeek Coder",
    provider: "deepseek",
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
  },
  "deepseek-reasoner": {
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsVision: false,
    supportsToolUse: true,
    isReasoningModel: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // XAI Grok Models
  // https://x.ai/models
  // ════════════════════════════════════════════════════════════════════════════

  // Grok 4.1 Fast (February 2026)
  "grok-4-1-fast-reasoning": {
    name: "Grok 4.1 Fast Reasoning",
    provider: "xai",
    contextWindow: 2000000,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },
  "grok-4-1-fast-non-reasoning": {
    name: "Grok 4.1 Fast Non-Reasoning",
    provider: "xai",
    contextWindow: 2000000,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Grok Code Fast 1
  "grok-code-fast-1": {
    name: "Grok Code Fast 1",
    provider: "xai",
    contextWindow: 256000,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },

  // Grok 4 Fast
  "grok-4-fast-reasoning": {
    name: "Grok 4 Fast Reasoning",
    provider: "xai",
    contextWindow: 2000000,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },
  "grok-4-fast-non-reasoning": {
    name: "Grok 4 Fast Non-Reasoning",
    provider: "xai",
    contextWindow: 2000000,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Grok 4 (July 2025)
  "grok-4-0709": {
    name: "Grok 4",
    provider: "xai",
    contextWindow: 256000,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Grok 3
  "grok-3-mini": {
    name: "Grok 3 Mini",
    provider: "xai",
    contextWindow: 131072,
    supportsVision: true,
    supportsToolUse: true,
    isReasoningModel: true,
  },
  "grok-3": {
    name: "Grok 3",
    provider: "xai",
    contextWindow: 131072,
    supportsVision: true,
    supportsToolUse: true,
  },

  // Grok 2 (legacy)
  "grok-2-vision-1212": {
    name: "Grok 2 Vision",
    provider: "xai",
    contextWindow: 32768,
    supportsVision: true,
    supportsToolUse: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Apple Foundation Models
  // On-device inference (macOS 26+, iOS 26+)
  // https://developer.apple.com/documentation/FoundationModels
  // ════════════════════════════════════════════════════════════════════════════

  "apple-foundation-3b": {
    name: "Apple Foundation Model (~3B)",
    provider: "apple",
    contextWindow: 4096,
    supportsVision: false,
    supportsToolUse: false,
    supportsStructuredOutput: true,
    releaseDate: "2025-06",
  },
};

/**
 * Get model info by ID.
 * Checks runtime registry first, then static catalog.
 * Uses case-insensitive and partial matching.
 *
 * @param modelId - The model ID to look up
 * @returns Model info or undefined if not found
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  const lowerModelId = modelId.toLowerCase();

  // Check runtime registry first (exact match)
  if (runtimeRegistry.has(lowerModelId)) {
    return runtimeRegistry.get(lowerModelId);
  }

  // Check runtime registry (partial match)
  for (const [key, value] of runtimeRegistry) {
    if (lowerModelId.startsWith(key) || key.startsWith(lowerModelId)) {
      return value;
    }
  }

  // Try exact match in static catalog
  if (MODEL_CATALOG[modelId]) {
    return MODEL_CATALOG[modelId];
  }

  // Try lowercase match in static catalog
  for (const [key, value] of Object.entries(MODEL_CATALOG)) {
    if (key.toLowerCase() === lowerModelId) {
      return value;
    }
  }

  // Try partial match in static catalog (for versioned model names)
  for (const [key, value] of Object.entries(MODEL_CATALOG)) {
    if (lowerModelId.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lowerModelId)) {
      return value;
    }
  }

  return undefined;
}

/**
 * Get the context window size for a model.
 *
 * @param modelId - The model ID
 * @returns Context window in tokens, or undefined if unknown
 */
export function getContextWindow(modelId: string): number | undefined {
  return getModelInfo(modelId)?.contextWindow;
}

/**
 * Calculate context utilization percentage.
 *
 * @param modelId - The model ID
 * @param usedTokens - Number of tokens used
 * @returns Utilization percentage (0-100), or undefined if model not found
 */
export function getContextUtilization(modelId: string, usedTokens: number): number | undefined {
  const contextWindow = getContextWindow(modelId);
  if (!contextWindow) return undefined;
  return Math.min(100, (usedTokens / contextWindow) * 100);
}

/**
 * Format context window for display.
 *
 * @param tokens - Number of tokens
 * @returns Formatted string like "128K" or "1M" or "10M"
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) {
    const millions = tokens / 1000000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Create ModelInfo from partial data with sensible defaults.
 * Useful for adapters that want to register models.
 */
export function createModelInfo(
  partial: Partial<ModelInfo> & { name: string; provider: string },
): ModelInfo {
  return {
    contextWindow: 128000, // sensible default
    maxOutputTokens: 4096,
    supportsVision: false,
    supportsToolUse: true,
    ...partial,
  };
}

/**
 * Adapter metadata shape (partial - what adapters might provide).
 * Adapters are source of truth when they provide these values.
 */
export interface AdapterModelMetadata {
  id?: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  supportsStructuredOutput?: boolean;
  isReasoningModel?: boolean;
}

/**
 * Get effective model info by merging adapter metadata with catalog.
 *
 * Priority:
 * 1. Adapter-provided values (source of truth)
 * 2. Runtime registry
 * 3. Static MODEL_CATALOG
 *
 * @param adapterMetadata - Metadata from the adapter (if available)
 * @param modelId - Model ID to look up in catalog (fallback)
 * @returns Merged model info, or undefined if nothing found
 */
export function getEffectiveModelInfo(
  adapterMetadata?: AdapterModelMetadata,
  modelId?: string,
): ModelInfo | undefined {
  // Determine which model ID to use for catalog lookup
  const lookupId = modelId || adapterMetadata?.model || adapterMetadata?.id;

  // Get catalog info as base
  const catalogInfo = lookupId ? getModelInfo(lookupId) : undefined;

  // If no adapter metadata, return catalog info
  if (!adapterMetadata) {
    return catalogInfo;
  }

  // If no catalog info and adapter has context window, create from adapter
  if (!catalogInfo && adapterMetadata.contextWindow) {
    return {
      name: adapterMetadata.model || adapterMetadata.id || "Unknown",
      provider: adapterMetadata.provider || "unknown",
      contextWindow: adapterMetadata.contextWindow,
      maxOutputTokens: adapterMetadata.maxOutputTokens,
      supportsVision: adapterMetadata.supportsVision,
      supportsToolUse: adapterMetadata.supportsToolUse,
      supportsStructuredOutput: adapterMetadata.supportsStructuredOutput,
      isReasoningModel: adapterMetadata.isReasoningModel,
    };
  }

  // Merge: adapter values override catalog values
  if (catalogInfo) {
    return {
      ...catalogInfo,
      // Adapter overrides
      ...(adapterMetadata.contextWindow !== undefined && {
        contextWindow: adapterMetadata.contextWindow,
      }),
      ...(adapterMetadata.maxOutputTokens !== undefined && {
        maxOutputTokens: adapterMetadata.maxOutputTokens,
      }),
      ...(adapterMetadata.supportsVision !== undefined && {
        supportsVision: adapterMetadata.supportsVision,
      }),
      ...(adapterMetadata.supportsToolUse !== undefined && {
        supportsToolUse: adapterMetadata.supportsToolUse,
      }),
      ...(adapterMetadata.supportsStructuredOutput !== undefined && {
        supportsStructuredOutput: adapterMetadata.supportsStructuredOutput,
      }),
      ...(adapterMetadata.isReasoningModel !== undefined && {
        isReasoningModel: adapterMetadata.isReasoningModel,
      }),
    };
  }

  return undefined;
}

/**
 * Get effective context window, prioritizing adapter metadata.
 *
 * @param adapterMetadata - Metadata from the adapter
 * @param modelId - Model ID for catalog lookup
 * @returns Context window size, or undefined if unknown
 */
export function getEffectiveContextWindow(
  adapterMetadata?: AdapterModelMetadata,
  modelId?: string,
): number | undefined {
  // Adapter is source of truth
  if (adapterMetadata?.contextWindow) {
    return adapterMetadata.contextWindow;
  }
  // Fall back to catalog
  const lookupId = modelId || adapterMetadata?.model || adapterMetadata?.id;
  return lookupId ? getContextWindow(lookupId) : undefined;
}
