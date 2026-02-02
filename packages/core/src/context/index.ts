/**
 * Engine's Context wrapper - re-exports Kernel's Context with EngineContext types.
 *
 * This ensures that when Engine users call Context.create(), they get EngineContext
 * (which includes Engine-specific fields via module augmentation) instead of KernelContext.
 *
 * @module tentickle/context
 */

import {
  Context as KernelContext,
  type KernelContext as KernelContextType,
} from "@tentickle/kernel";
import type { EngineContext } from "../types";

/**
 * Context utilities for Engine.
 *
 * Re-exports Kernel's Context class but with EngineContext return types.
 * This ensures Engine users get properly typed contexts with Engine-specific fields.
 */
export class Context {
  /**
   * Creates a new EngineContext with defaults.
   * Returns EngineContext (KernelContext with Engine augmentations).
   */
  static create(overrides: Partial<Omit<EngineContext, "events">> = {}): EngineContext {
    // Call Kernel's Context.create() and cast to EngineContext
    // This is safe because EngineContext extends KernelContext and Engine augments it
    return KernelContext.create(
      overrides as Partial<Omit<KernelContextType, "events">>,
    ) as EngineContext;
  }

  /**
   * Runs a function within the given EngineContext.
   */
  static run<T>(context: EngineContext, fn: () => Promise<T>): Promise<T> {
    return KernelContext.run(context, fn);
  }

  /**
   * Gets the current EngineContext. Throws if not found.
   *
   * Note: EngineContext extends KernelContext, so it has all KernelContext properties
   * (metadata, user, etc.) available directly.
   */
  static get(): EngineContext {
    // Cast is safe: EngineContext extends KernelContext and only narrows executionHandle
    return KernelContext.get() as EngineContext;
  }

  /**
   * Gets the current EngineContext. Returns undefined if not found.
   *
   * Note: EngineContext extends KernelContext, so it has all KernelContext properties
   * (metadata, user, etc.) available directly.
   */
  static tryGet(): EngineContext | undefined {
    // Cast is safe: EngineContext extends KernelContext and only narrows executionHandle
    return KernelContext.tryGet() as EngineContext | undefined;
  }

  /**
   * Emits an event on the current context's event bus.
   */
  static emit(type: string, payload: any, source: string = "system"): void {
    KernelContext.emit(type, payload, source);
  }

  /**
   * Set the current tick number in the context.
   * Called by the engine at the start of each tick.
   */
  static setTick(tick: number): void {
    KernelContext.setTick(tick);
  }
}

export function context() {
  return Context.get();
}
