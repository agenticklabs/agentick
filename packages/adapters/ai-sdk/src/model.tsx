// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@agentick/core/jsx";
import { createElement } from "@agentick/core/jsx-runtime";
import { createAiSdkModel, type AiSdkAdapterConfig } from "./adapter.js";

/**
 * Props for AiSdkModel component.
 * Extends adapter config with optional Model component props.
 */
export interface AiSdkModelProps extends AiSdkAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * AiSdkModel component for declarative model configuration in JSX.
 *
 * Creates an AI SDK model adapter internally and wraps it in a Model component.
 * Works with any AI SDK provider (OpenAI, Anthropic, Google, etc.)
 *
 * @example
 * ```tsx
 * import { openai } from '@ai-sdk/openai';
 *
 * // Basic usage
 * <AiSdkModel model={openai('gpt-4o')} />
 *
 * // With config
 * <AiSdkModel
 *   model={openai('gpt-4o')}
 *   temperature={0.7}
 *   maxTokens={1000}
 * />
 *
 * // With Anthropic
 * <AiSdkModel
 *   model={anthropic('claude-3-5-sonnet-20241022')}
 *   temperature={0.5}
 * />
 *
 * // With Google
 * <AiSdkModel
 *   model={google('gemini-2.5-flash')}
 *   system="You are a helpful assistant"
 * />
 * ```
 */
export function AiSdkModel(props: AiSdkModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createAiSdkModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
