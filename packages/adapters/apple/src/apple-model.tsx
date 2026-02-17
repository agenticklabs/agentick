// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@agentick/core/jsx";
import { createElement } from "@agentick/core/jsx-runtime";
import { createAppleModel } from "./apple";
import { type AppleAdapterConfig } from "./types";

/**
 * Props for AppleModel component.
 */
export interface AppleModelProps extends AppleAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * AppleModel component for declarative model configuration in JSX.
 *
 * Creates an Apple Foundation Models adapter internally and wraps it in a Model component.
 *
 * @example
 * ```tsx
 * <AppleModel bridgePath="./apple-fm-bridge" />
 * ```
 */
export function AppleModel(props: AppleModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createAppleModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
