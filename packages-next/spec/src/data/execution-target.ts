/**
 * Execution target — what the executor harness is asked to run against.
 *
 * `[PLACEHOLDER]` capabilities synthesized from v1's `ContextUpdateEvent`
 * fields (`packages/shared/src/streaming.ts`). Sign-off needed.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §ExecutionTarget
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { ProviderOptions } from "./rendered-tree.js";

/**
 * Capabilities advertised by an execution target. Drives loop-executor
 * decisions (tool exposure, streaming opt-in, max-output negotiation).
 */
export interface TargetCapabilities {
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly supportsStreaming?: boolean;
  /** Native structured-output support (json_schema responseFormat). */
  readonly supportsJsonSchema?: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly [key: string]: unknown;
}

/**
 * Base execution target. The `kind` discriminator opens the door to future
 * families (code-execution, tool-only, custom executors). Today only
 * `language-model` ships.
 */
export interface ExecutionTarget {
  readonly kind: "language-model" | (string & {});
  readonly provider?: string;
  readonly modelId?: string;
  readonly capabilities?: TargetCapabilities;
  /**
   * Provider-specific escape hatch. Typed via the module-augmentable
   * {@link ProviderOptions} interface — adapter packages contribute
   * typed slots (e.g., `openai`, `anthropic`) via `declare module
   * "@agentick/spec-next"`. The spec ships an empty seed, so call sites
   * stay type-safe across provider-specific knobs.
   */
  readonly providerOptions?: ProviderOptions;
  /**
   * Self-described pricing (USD/MTok) — the adapter is the authority
   * on its own model's economics (#186). Consumers resolve
   * adopter-table > target.pricing > seed. Shape defined in
   * `@agentick/model-next` (ModelPricing); carried structurally here.
   */
  readonly pricing?: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cachedInputPerMTok?: number;
    readonly cacheWritePerMTok?: number;
  };
}

export interface LanguageModelTarget extends ExecutionTarget {
  readonly kind: "language-model";
}
