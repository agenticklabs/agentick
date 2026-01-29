import { HookRegistry } from "./hook-registry";

/**
 * Base class for hook registries that provides common overloaded register methods.
 * Reduces code duplication across ModelHookRegistry, ToolHookRegistry, etc.
 */
export abstract class BaseHookRegistry<THookName extends string, TSelector, THookMiddleware> {
  protected registry: HookRegistry<THookName, TSelector, THookMiddleware>;

  constructor() {
    this.registry = new HookRegistry<THookName, TSelector, THookMiddleware>();
  }

  /**
   * Get all possible hook names for this registry.
   * Must be implemented by subclasses.
   */
  protected abstract getAllHookNames(): readonly THookName[];

  /**
   * Check if a value is a hook name.
   * Can be overridden by subclasses to provide custom logic.
   * Default implementation checks if the value is in getAllHookNames().
   */
  protected isHookName(value: any): value is THookName {
    return this.getAllHookNames().includes(value);
  }

  /**
   * Register middleware for a hook.
   *
   * Overloads:
   * - register(hookName, selector, middleware) - specific hook, specific selector
   * - register(hookName, middleware) - specific hook, global selector
   * - register(selector, middleware) - all hooks, specific selector (if selectors are supported)
   * - register(middleware) - all hooks, global selector
   */
  register<T extends THookName>(
    hookName: T,
    selector: TSelector | undefined,
    middleware: THookMiddleware,
  ): void;
  register<T extends THookName>(hookName: T, middleware: THookMiddleware): void;
  register(selector: TSelector, middleware: THookMiddleware): void;
  register(middleware: THookMiddleware): void;
  register<T extends THookName>(
    arg1: T | TSelector | THookMiddleware,
    arg2?: TSelector | THookMiddleware | undefined,
    arg3?: THookMiddleware,
  ): void {
    const allHookNames = this.getAllHookNames();

    // Determine which overload was called
    if (arg3 !== undefined) {
      // register(hookName, selector, middleware)
      const hookName = arg1 as T;
      const selector = arg2 as TSelector | undefined;
      const middleware = arg3 as THookMiddleware;
      this.registry.register(hookName, selector, middleware);
    } else if (arg2 !== undefined) {
      // Could be register(hookName, middleware) or register(selector, middleware)
      // Check if arg1 is a hook name
      if (this.isHookName(arg1)) {
        // register(hookName, middleware) - specific hook, global selector
        const hookName = arg1 as T;
        const middleware = arg2 as THookMiddleware;
        this.registry.register(hookName, undefined, middleware);
      } else {
        // register(selector, middleware) - all hooks, specific selector
        const selector = arg1 as TSelector;
        const middleware = arg2 as THookMiddleware;
        for (const hookName of allHookNames) {
          this.registry.register(hookName, selector, middleware);
        }
      }
    } else {
      // register(middleware) - all hooks, global selector
      const middleware = arg1 as THookMiddleware;
      for (const hookName of allHookNames) {
        this.registry.register(hookName, undefined, middleware);
      }
    }
  }

  /**
   * Copy all hooks from another registry of the same type.
   * Useful for inheriting hooks from parent engine to child engine.
   *
   * @param sourceRegistry - The registry to copy hooks from
   */
  copyHooksFrom(sourceRegistry: BaseHookRegistry<THookName, TSelector, THookMiddleware>): void {
    const allHookNames = this.getAllHookNames();

    for (const hookName of allHookNames) {
      const sourceHookMap = sourceRegistry.registry.getHookMap(hookName);
      if (sourceHookMap) {
        // Copy all middleware for each selector (including undefined for global)
        for (const [selector, middlewareArray] of sourceHookMap.entries()) {
          for (const middleware of middlewareArray) {
            this.registry.register(hookName, selector, middleware);
          }
        }
      }
    }
  }
}
