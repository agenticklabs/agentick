// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@agentick/core/jsx";
import { createElement } from "@agentick/core/jsx-runtime";
import { createOpenAIModel } from "./openai.js";
import { type OpenAIAdapterConfig } from "./types.js";

/**
 * Props for OpenAIModel component.
 * Extends adapter config with optional Model component props.
 */
export interface OpenAIModelProps extends OpenAIAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * OpenAIModel component for declarative model configuration in JSX.
 *
 * Creates an OpenAI model adapter internally and wraps it in a Model component.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <OpenAIModel model="gpt-4o" />
 *
 * // With config
 * <OpenAIModel
 *   model="gpt-4o"
 *   temperature={0.7}
 *   maxTokens={1000}
 * />
 *
 * // With custom base URL (e.g., Azure OpenAI)
 * <OpenAIModel
 *   model="gpt-4"
 *   baseURL="https://my-resource.openai.azure.com"
 *   apiKey={process.env.AZURE_OPENAI_KEY}
 * />
 * ```
 */
export function OpenAIModel(props: OpenAIModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createOpenAIModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
