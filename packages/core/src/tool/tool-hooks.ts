import type { Middleware } from "@agentick/kernel";
import type { ContentBlock } from "@agentick/shared";
import { BaseHookRegistry } from "../hooks/base-hook-registry.js";
import type {
  ComponentHookArgs,
  ComponentHookName,
  ComponentHookReturn,
} from "../component/component-hooks.js";

/**
 * Tool operation names.
 */
export type ToolHookName = "run";

/**
 * Tool selector for hook registration.
 * For now, we only support global hooks (all tools).
 * Future: Could support tool-specific hooks by tool name or metadata.
 */
export type ToolSelector = undefined; // Global (all tools)

/**
 * Hook middleware type for tool operations.
 */
export type ToolHookMiddleware<T extends ToolHookName | ComponentHookName> = Middleware<
  T extends ToolHookName ? ToolHookArgs<T> : ComponentHookArgs<Exclude<T, ToolHookName>>
>;

/**
 * Arguments for tool hooks.
 */
export type ToolHookArgs<T extends ToolHookName> = T extends "run" ? [input: unknown] : never;

/**
 * Return type for tool hooks.
 */
export type ToolHookReturn<T extends ToolHookName | ComponentHookName> = T extends ToolHookName
  ? Promise<ContentBlock[]>
  : ComponentHookReturn<Extract<T, ComponentHookName>>;

/**
 * Tool-specific hook registry.
 * Uses BaseHookRegistry to reduce code duplication.
 *
 * Note: Global hooks via configureEngine() have been deprecated.
 * Use Agentick.use() for middleware registration instead.
 */
export class ToolHookRegistry extends BaseHookRegistry<
  ToolHookName | ComponentHookName,
  ToolSelector,
  ToolHookMiddleware<ToolHookName | ComponentHookName>
> {
  protected getAllHookNames(): readonly (ToolHookName | ComponentHookName)[] {
    const toolHookNames: ToolHookName[] = ["run"];
    const componentHookNames: ComponentHookName[] = [
      "onMount",
      "onUnmount",
      "onStart",
      "onTickStart",
      "render",
      "onTickEnd",
      "onComplete",
      "onError",
    ];
    return [...toolHookNames, ...componentHookNames] as const;
  }

  /**
   * Get all middleware for a tool hook.
   * Returns instance-specific hooks only.
   *
   * Note: Global hooks via configureEngine() have been deprecated.
   * Use Agentick.use() for middleware registration instead.
   */
  getMiddleware(
    hookName: ToolHookName | ComponentHookName,
  ): ToolHookMiddleware<ToolHookName | ComponentHookName>[] {
    return this.registry.getMiddleware(
      hookName,
      () => [], // No selectors for now - only global hooks
    );
  }
}
