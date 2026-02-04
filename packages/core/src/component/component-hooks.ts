import type { Middleware } from "@tentickle/kernel";
import type { EngineComponent, TickState, RecoveryAction, AfterCompileContext } from "./component";
import type { COM } from "../com/object-model";
import type { COMInput } from "../com/types";
import type { JSX } from "../jsx/jsx-runtime";
import { BaseHookRegistry } from "../hooks/base-hook-registry";
import type { CompiledStructure } from "../compiler/types";
import type { ExecutionMessage } from "../engine/execution-types";

/**
 * Component lifecycle method names.
 */
export type ComponentHookName =
  | "onMount"
  | "onUnmount"
  | "onStart"
  | "onTickStart"
  | "render"
  | "onAfterCompile"
  | "onTickEnd"
  | "onMessage"
  | "onComplete"
  | "onError";

/**
 * Component selector for hook registration.
 */
export type ComponentSelector =
  | string // Component name
  | { name?: string; tags?: string[] } // Selector object
  | Function // Component class/function reference
  | undefined; // Global (all components)

/**
 * Hook middleware type for component lifecycle methods.
 * Note: Component lifecycle "hooks" are actually callbacks (side effects only), not transformation middleware.
 */
export type ComponentHookMiddleware<T extends ComponentHookName> = Middleware<ComponentHookArgs<T>>;

/**
 * Arguments for each component hook.
 */
export type ComponentHookArgs<T extends ComponentHookName> = T extends "onMount"
  ? [com: COM]
  : T extends "onUnmount"
    ? [com: COM]
    : T extends "onStart"
      ? [com: COM]
      : T extends "onTickStart"
        ? [state: TickState]
        : T extends "render"
          ? [com: COM, state: TickState]
          : T extends "onAfterCompile"
            ? [com: COM, compiled: CompiledStructure, state: TickState, ctx: AfterCompileContext]
            : T extends "onTickEnd"
              ? [com: COM, state: TickState]
              : T extends "onMessage"
                ? [com: COM, message: ExecutionMessage, state: TickState]
                : T extends "onComplete"
                  ? [com: COM, finalState: COMInput]
                  : T extends "onError"
                    ? [com: COM, state: TickState]
                    : never;

/**
 * Return type for each component hook.
 */
export type ComponentHookReturn<T extends ComponentHookName> = T extends "onMount"
  ? void | Promise<void>
  : T extends "onUnmount"
    ? void | Promise<void>
    : T extends "onStart"
      ? void | Promise<void>
      : T extends "onTickStart"
        ? void | Promise<void>
        : T extends "render"
          ? JSX.Element | null | Promise<JSX.Element | null>
          : T extends "onAfterCompile"
            ? void | Promise<void>
            : T extends "onTickEnd"
              ? void | Promise<void>
              : T extends "onMessage"
                ? void | Promise<void>
                : T extends "onComplete"
                  ? JSX.Element | null | Promise<JSX.Element | null>
                  : T extends "onError"
                    ? RecoveryAction | void | Promise<RecoveryAction | void>
                    : never;

/**
 * Component-specific hook registry.
 * Uses BaseHookRegistry to reduce code duplication while supporting component selectors.
 */
export class ComponentHookRegistry extends BaseHookRegistry<
  ComponentHookName,
  ComponentSelector,
  ComponentHookMiddleware<ComponentHookName>
> {
  protected getAllHookNames(): readonly ComponentHookName[] {
    return [
      "onMount",
      "onUnmount",
      "onStart",
      "onTickStart",
      "render",
      "onAfterCompile",
      "onTickEnd",
      "onMessage",
      "onComplete",
      "onError",
    ] as const;
  }

  /**
   * Get all middleware for a component hook, ordered by specificity.
   * Order: component-defined -> class-based -> tag-based -> name-based -> global
   */
  getMiddleware<T extends ComponentHookName>(
    hookName: T,
    componentClass: any,
    componentName: string,
    componentTags: string[],
  ): ComponentHookMiddleware<T>[] {
    // 1. Get component-defined hooks (from ComponentClass.hooks or ComponentFunction.hooks)
    const componentDefinedHooks = this.getComponentDefinedHooks(hookName, componentClass);

    // 2. Get middleware from registry using component-specific resolution
    const registryMiddleware = this.registry.getMiddleware(hookName, (hookMap) => {
      const selectors: ComponentSelector[] = [];

      // Class/Function reference-based hooks (most specific)
      if (hookMap.has(componentClass)) {
        selectors.push(componentClass);
      }

      // Tag-based hooks
      for (const selector of hookMap.keys()) {
        if (
          selector &&
          typeof selector === "object" &&
          !Array.isArray(selector) &&
          "tags" in selector &&
          selector.tags
        ) {
          const requiredTags = selector.tags;
          if (requiredTags.some((tag) => componentTags.includes(tag))) {
            selectors.push(selector);
          }
        }
      }

      // Name-based hooks
      if (hookMap.has(componentName)) {
        selectors.push(componentName);
      }

      return selectors;
    });

    // Combine: component-defined hooks first, then registry middleware
    return [...componentDefinedHooks, ...registryMiddleware] as ComponentHookMiddleware<T>[];
  }

  /**
   * Get component-defined hooks from the component class/function.
   * Component hooks are now actual middleware (aligned with kernel), not callbacks.
   */
  private getComponentDefinedHooks<T extends ComponentHookName>(
    hookName: T,
    componentClass: any,
  ): ComponentHookMiddleware<T>[] {
    // Check for static hooks (classes) or .hooks property (functions)
    // These should be middleware, not callbacks
    const hooks = componentClass.hooks?.[hookName];
    if (!hooks || !Array.isArray(hooks)) {
      return [];
    }

    // Hooks are already middleware - return them directly
    // No conversion needed - they follow kernel middleware signature: (args, envelope, next)
    return hooks as ComponentHookMiddleware<T>[];
  }
}

/**
 * Auto-generate tags from component class/function name.
 * Splits camelCase into lowercase tags.
 */
export function autoGenerateTags(componentClass: any): string[] {
  const name = componentClass.name || "";
  if (!name) {
    return [];
  }

  // Split camelCase: TimelineManager -> ['timeline', 'manager']
  return name
    .split(/(?=[A-Z])/)
    .map((s: string) => s.toLowerCase())
    .filter((s: string) => s.length > 0);
}

/**
 * Get component tags (explicit or auto-generated).
 */
export function getComponentTags(componentClass: any): string[] {
  // Check for explicit tags
  // Classes: static tags
  if (componentClass.tags && Array.isArray(componentClass.tags)) {
    return componentClass.tags;
  }

  // Functions: .tags property
  if (
    typeof componentClass === "function" &&
    componentClass.tags &&
    Array.isArray(componentClass.tags)
  ) {
    return componentClass.tags;
  }

  // Fallback: auto-generate from name
  return autoGenerateTags(componentClass);
}

/**
 * Get component name from instance or class.
 */
export function getComponentName(instance: EngineComponent, componentClass: any): string {
  return instance.name || componentClass.name || "";
}
