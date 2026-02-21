/**
 * Model component - React function component version.
 *
 * Uses React hooks (useEffect) for lifecycle instead of Agentick Component class.
 */

import React, { useEffect, useDebugValue } from "react";
import { useCom } from "../../hooks/context.js";
import type { ModelConfig, EngineModel } from "../../model/model.js";
import type { ComponentBaseProps } from "../jsx-types.js";
import type { ProviderGenerationOptions } from "../../types.js";
import type { MessageTransformationConfig } from "../../model/model.js";
import type { COM } from "../../com/object-model.js";

// Helper for createElement
const h = React.createElement;

/**
 * Props for Model component.
 */
export interface ModelComponentProps extends ComponentBaseProps, Omit<ModelConfig, "model"> {
  /**
   * The model adapter instance or identifier.
   * If a string, will be resolved from the model registry.
   */
  model: EngineModel | string;

  /**
   * Provider-specific options.
   * Used for model generation/streaming calls and other operations.
   * Each adapter can extend this type using module augmentation.
   */
  providerOptions?: ProviderGenerationOptions;

  /**
   * Optional callback when model is mounted.
   */
  onMount?: (ctx: COM) => Promise<void> | void;

  /**
   * Optional callback when model is unmounted.
   */
  onUnmount?: (ctx: COM) => Promise<void> | void;
}

/**
 * Model component that dynamically sets the model adapter for the current execution.
 *
 * Model is a configuration component - it sets which model adapter to use.
 * It does NOT contain content (messages, timeline entries, etc.).
 *
 * When mounted, sets the model on the COM.
 * When unmounted, clears the model.
 *
 * @example
 * ```tsx
 * <>
 *   <Model model={myModel} />
 *   <Message role="user" content="Hello" />
 * </>
 * ```
 */
export function Model(props: ModelComponentProps): React.ReactElement {
  const { model, onMount, onUnmount, ...options } = props;
  const ctx = useCom();

  // Debug value shows model identifier for React DevTools
  useDebugValue(
    typeof model === "string"
      ? `Model: ${model}`
      : `Model: ${(model as any).metadata?.id ?? "custom"}`,
  );

  // Set model on mount, clear on unmount
  useEffect(() => {
    ctx.setModel(model);
    ctx.resetModelOptions();

    // Register token estimator if adapter provides one
    const resolvedModel = typeof model === "string" ? null : model;
    if (resolvedModel?.metadata?.tokenEstimator) {
      ctx.setTokenEstimator(resolvedModel.metadata.tokenEstimator);
    }

    // Call user's onMount if provided
    if (onMount) {
      const result = onMount(ctx);
      if (result instanceof Promise) {
        result.catch(() => {}); // Fire and forget
      }
    }

    return () => {
      ctx.unsetModel();

      // Call user's onUnmount if provided
      if (onUnmount) {
        const result = onUnmount(ctx);
        if (result instanceof Promise) {
          result.catch(() => {}); // Fire and forget
        }
      }
    };
  }, [model, ctx, onMount, onUnmount]);

  // Set model options during render
  useEffect(() => {
    ctx.setModelOptions(options);
  }, [ctx, options]);

  // Model is configuration-only - doesn't render anything
  return h(React.Fragment, null);
}

// Export ModelComponent as an alias for backwards compatibility in type detection
export const ModelComponent = Model;

// ============================================================================
// ModelOptions Component
// ============================================================================

/**
 * Props for ModelOptions component.
 * Configuration for how content is transformed for model input.
 */
export interface ModelOptionsProps extends ComponentBaseProps {
  /**
   * Unified message transformation configuration.
   * Controls how event and ephemeral messages are transformed for the model.
   * Can override model-level defaults set in adapter capabilities.
   *
   * @see MessageTransformationConfig
   */
  messageTransformation?: Partial<MessageTransformationConfig>;

  /**
   * Model temperature (0-2).
   */
  temperature?: number;

  /**
   * Maximum tokens to generate.
   */
  maxTokens?: number;
}

/**
 * ModelOptions component for configuring how content is transformed for model input.
 *
 * @example
 * ```tsx
 * <ModelOptions
 *   messageTransformation={{
 *     roleMapping: {
 *       event: 'user',
 *       ephemeral: 'user',
 *     },
 *   }}
 * />
 * ```
 */
export function ModelOptions(props: ModelOptionsProps): React.ReactElement {
  const ctx = useCom();

  // Set model options during render
  useEffect(() => {
    ctx.setModelOptions(props);
  }, [ctx, props]);

  // ModelOptions is configuration-only - doesn't render anything
  return h(React.Fragment, null);
}

// Export ModelOptionsComponent as an alias for backwards compatibility
export const ModelOptionsComponent = ModelOptions;
