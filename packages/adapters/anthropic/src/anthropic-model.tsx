// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@agentick/core/jsx";
import { createElement } from "@agentick/core/jsx-runtime";
import { createAnthropicModel } from "./anthropic.js";
import { type AnthropicAdapterConfig } from "./types.js";

/**
 * Props for AnthropicModel component.
 * Extends adapter config with optional Model component props.
 */
export interface AnthropicModelProps extends AnthropicAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * AnthropicModel component for declarative model configuration in JSX.
 *
 * Creates an Anthropic model adapter internally and wraps it in a Model component.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <AnthropicModel model="claude-sonnet-4-20250514" />
 *
 * // With config
 * <AnthropicModel
 *   model="claude-sonnet-4-20250514"
 *   maxTokens={4096}
 * />
 *
 * // With custom base URL
 * <AnthropicModel
 *   model="claude-sonnet-4-20250514"
 *   baseURL="https://my-proxy.example.com"
 *   apiKey={process.env.ANTHROPIC_API_KEY}
 * />
 * ```
 */
export function AnthropicModel(props: AnthropicModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createAnthropicModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
