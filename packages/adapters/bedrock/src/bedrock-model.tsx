// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@agentick/core/jsx";
import { createElement } from "@agentick/core/jsx-runtime";
import { createBedrockModel } from "./bedrock.js";
import { type BedrockAdapterConfig } from "./types.js";

/**
 * Props for BedrockModel component.
 * Extends adapter config with optional Model component props.
 */
export interface BedrockModelProps extends BedrockAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * BedrockModel component for declarative model configuration in JSX.
 *
 * Creates a Bedrock model adapter internally and wraps it in a Model component.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <BedrockModel model="us.anthropic.claude-sonnet-4-20250514-v1:0" />
 *
 * // With config
 * <BedrockModel
 *   model="us.anthropic.claude-sonnet-4-20250514-v1:0"
 *   region="us-west-2"
 *   maxTokens={4096}
 * />
 *
 * // With explicit credentials
 * <BedrockModel
 *   model="us.anthropic.claude-sonnet-4-20250514-v1:0"
 *   credentials={{
 *     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *   }}
 * />
 * ```
 */
export function BedrockModel(props: BedrockModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createBedrockModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
