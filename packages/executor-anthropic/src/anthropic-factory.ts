/**
 * `anthropic(modelId, options?)` — factory placeholder.
 *
 * Returns an `ExecutorFactory` once the executor body lands. See
 * `docs/proposals/v2/anthropic-adapter-plan.md` for the planned shape.
 */

import type { AnthropicExecutorOptions } from "./anthropic-executor.js";

export interface AnthropicFactoryOptions extends Omit<AnthropicExecutorOptions, "model"> {
  /** Placeholder — see implementation plan for the full shape. */
  readonly scopeId?: string;
}

export {};
