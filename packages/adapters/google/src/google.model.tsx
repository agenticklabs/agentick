// ============================================================================
// JSX Component
// ============================================================================

import { type ModelComponentProps, Model } from "@tentickle/core/jsx";
import { createElement } from "@tentickle/core/jsx-runtime";
import { createGoogleModel } from "./google";
import { type GoogleAdapterConfig } from "./types";

/**
 * Props for GoogleModel component.
 * Extends adapter config with optional Model component props.
 */
export interface GoogleModelProps extends GoogleAdapterConfig {
  /** Optional callback when model is mounted */
  onMount?: ModelComponentProps["onMount"];
  /** Optional callback when model is unmounted */
  onUnmount?: ModelComponentProps["onUnmount"];
}

/**
 * GoogleModel component for declarative model configuration in JSX.
 *
 * Creates a Google model adapter internally and wraps it in a Model component.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <GoogleModel model="gemini-2.5-flash" />
 *
 * // With config
 * <GoogleModel
 *   model="gemini-2.5-flash"
 *   temperature={0.7}
 *   maxTokens={1000}
 * />
 *
 * // With Vertex AI
 * <GoogleModel
 *   model="gemini-2.5-flash"
 *   vertexai={true}
 *   project="my-project"
 *   location="us-central1"
 * />
 * ```
 */
export function GoogleModel(props: GoogleModelProps) {
  const { onMount, onUnmount, ...adapterConfig } = props;
  const adapter = createGoogleModel(adapterConfig);
  return createElement(Model, { model: adapter, onMount, onUnmount });
}
