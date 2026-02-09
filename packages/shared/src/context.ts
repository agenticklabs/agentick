/**
 * Context utilization information.
 * Updated after each tick with current token usage and model info.
 */
export interface ContextInfo {
  /** Model ID (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  modelId: string;
  /** Human-readable model name */
  modelName?: string;
  /** Provider name (e.g., "openai", "anthropic") */
  provider?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Input tokens used this tick */
  inputTokens: number;
  /** Output tokens generated this tick */
  outputTokens: number;
  /** Total tokens this tick */
  totalTokens: number;
  /** Context utilization percentage (0-100) */
  utilization?: number;
  /** Max output tokens for this model */
  maxOutputTokens?: number;
  /** Model capabilities */
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;
  /** Estimated total context tokens (from token estimation, pre-model-call) */
  estimatedContextTokens?: number;
  /** Current tick number */
  tick: number;
  /** Cumulative usage across all ticks in this execution */
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}
