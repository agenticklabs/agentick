/**
 * # Tentickle Hooks
 *
 * Hook system for cross-cutting concerns in Tentickle. Hooks allow middleware-style
 * injection at various points in the execution lifecycle.
 *
 * ## Hook Types
 *
 * - **Engine Hooks** - Before/after model calls, tool execution
 * - **Component Hooks** - Lifecycle events (mount, unmount, render)
 * - **Tool Hooks** - Before/after tool execution
 * - **Model Hooks** - Input/output transformation
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Engine } from 'tentickle';
 *
 * const engine = new Engine({ model });
 *
 * // Add a hook for all model calls
 * engine.hooks.onModelCall.add(async (input, next) => {
 *   console.log('Model input:', input);
 *   const result = await next(input);
 *   console.log('Model output:', result);
 *   return result;
 * });
 * ```
 *
 * @see {@link HookRegistry} - Base hook registry
 * @see {@link EngineHookRegistry} - Engine-specific hooks
 *
 * @module tentickle/hooks
 */

export * from "./hook-registry";
export * from "./base-hook-registry";
