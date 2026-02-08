import type { Middleware } from "@agentick/kernel";
import type { COMInput } from "../com/types";
import type { EngineResponse } from "../engine/engine-response";
import { BaseHookRegistry } from "../hooks/base-hook-registry";

/**
 * Model operation names.
 */
export type ModelHookName = "fromEngineState" | "generate" | "stream" | "toEngineState";

/**
 * Model selector for hook registration.
 * For now, we only support global hooks (all models).
 * Future: Could support model-specific hooks by model ID or type.
 */
export type ModelSelector = undefined; // Global (all models)

/**
 * Hook middleware type for model operations.
 */
export type ModelHookMiddleware<T extends ModelHookName> = Middleware<ModelHookArgs<T>>;

/**
 * Arguments for each model hook.
 */
export type ModelHookArgs<T extends ModelHookName> = T extends "fromEngineState"
  ? [input: COMInput]
  : T extends "generate"
    ? [input: unknown] // Opaque model input
    : T extends "stream"
      ? [input: unknown] // Opaque model input
      : T extends "toEngineState"
        ? [output: unknown] // Opaque model output
        : never;

/**
 * Return type for each model hook.
 */
export type ModelHookReturn<T extends ModelHookName> = T extends "fromEngineState"
  ? Promise<unknown> // Opaque model input
  : T extends "generate"
    ? Promise<unknown> // Opaque model output
    : T extends "stream"
      ? AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> // Opaque stream chunks
      : T extends "toEngineState"
        ? Promise<EngineResponse>
        : never;

/**
 * Model-specific hook registry.
 * Uses BaseHookRegistry to reduce code duplication.
 *
 * Note: Global hooks via configureEngine() have been deprecated.
 * Use Agentick.use() for middleware registration instead.
 */
export class ModelHookRegistry extends BaseHookRegistry<
  ModelHookName,
  ModelSelector,
  ModelHookMiddleware<ModelHookName>
> {
  protected getAllHookNames(): readonly ModelHookName[] {
    return ["fromEngineState", "generate", "stream", "toEngineState"] as const;
  }

  /**
   * Get all middleware for a model hook.
   * Returns instance-specific hooks only.
   *
   * Note: Global hooks via configureEngine() have been deprecated.
   * Use Agentick.use() for middleware registration instead.
   */
  getMiddleware<T extends ModelHookName>(hookName: T): ModelHookMiddleware<T>[] {
    return this.registry.getMiddleware(
      hookName,
      () => [], // No selectors for now - only global hooks
    );
  }
}
