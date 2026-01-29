/**
 * Generic hook registry that can be used for any hook system.
 *
 * @template THookName - The hook name type (e.g., 'onMount', 'render', 'generate', etc.)
 * @template TSelector - The selector type for scoping hooks (e.g., string, Function, object, etc.)
 * @template THookMiddleware - The middleware type for hooks
 */
export class HookRegistry<THookName extends string | number | symbol, TSelector, THookMiddleware> {
  private hooks = new Map<THookName, Map<TSelector | undefined, THookMiddleware[]>>();

  /**
   * Register middleware for a hook.
   *
   * Overloads:
   * - register(hookName, selector, middleware) - specific hook, specific selector
   * - register(hookName, middleware) - specific hook, global selector
   * - register(selector, middleware) - all hooks, specific selector (requires getAllHookNames)
   * - register(middleware) - all hooks, global selector (requires getAllHookNames)
   */
  register(hookName: THookName, selector: TSelector | undefined, middleware: THookMiddleware): void;
  register(hookName: THookName, middleware: THookMiddleware): void;
  register(selector: TSelector, middleware: THookMiddleware): void;
  register(middleware: THookMiddleware): void;
  register(
    arg1: THookName | TSelector | THookMiddleware,
    arg2?: TSelector | THookMiddleware | undefined,
    arg3?: THookMiddleware,
  ): void {
    // Determine which overload was called based on argument types
    if (arg3 !== undefined) {
      // register(hookName, selector, middleware)
      const hookName = arg1 as THookName;
      const selector = arg2 as TSelector | undefined;
      const middleware = arg3 as THookMiddleware;
      const hookMap = this.hooks.get(hookName) || new Map();
      const existing = hookMap.get(selector) || [];
      hookMap.set(selector, [...existing, middleware]);
      this.hooks.set(hookName, hookMap);
    } else if (arg2 !== undefined) {
      // Could be register(hookName, middleware) or register(selector, middleware)
      // Check if arg1 is a hook name (string/number/symbol) or a selector
      if (typeof arg1 === "string" || typeof arg1 === "number" || typeof arg1 === "symbol") {
        // register(hookName, middleware) - specific hook, global selector
        const hookName = arg1 as THookName;
        const middleware = arg2 as THookMiddleware;
        const hookMap = this.hooks.get(hookName) || new Map();
        const existing = hookMap.get(undefined) || [];
        hookMap.set(undefined, [...existing, middleware]);
        this.hooks.set(hookName, hookMap);
      } else {
        // register(selector, middleware) - all hooks, specific selector
        // This requires knowing all hook names - we'll need to iterate over existing hooks
        const selector = arg1 as TSelector;
        const middleware = arg2 as THookMiddleware;
        // Register for all existing hook names
        for (const hookName of this.hooks.keys()) {
          const hookMap = this.hooks.get(hookName) || new Map();
          const existing = hookMap.get(selector) || [];
          hookMap.set(selector, [...existing, middleware]);
          this.hooks.set(hookName, hookMap);
        }
      }
    } else {
      // register(middleware) - all hooks, global selector
      const middleware = arg1 as THookMiddleware;
      // Register for all existing hook names
      for (const hookName of this.hooks.keys()) {
        const hookMap = this.hooks.get(hookName) || new Map();
        const existing = hookMap.get(undefined) || [];
        hookMap.set(undefined, [...existing, middleware]);
        this.hooks.set(hookName, hookMap);
      }
    }
  }

  /**
   * Get all middleware for a hook, ordered by selector specificity.
   *
   * @param hookName - The name of the hook
   * @param resolveSelectors - Function to resolve which selectors match for this hook call
   * @returns Array of middleware in order of specificity (most specific first)
   */
  getMiddleware(
    hookName: THookName,
    resolveSelectors: (hookMap: Map<TSelector | undefined, THookMiddleware[]>) => TSelector[],
  ): THookMiddleware[] {
    const hookMap = this.hooks.get(hookName);
    if (!hookMap) {
      return [];
    }

    const middleware: THookMiddleware[] = [];

    // Get matching selectors in order of specificity
    const matchingSelectors = resolveSelectors(hookMap);

    // Collect middleware from matching selectors
    for (const selector of matchingSelectors) {
      const hooks = hookMap.get(selector);
      if (hooks) {
        middleware.push(...hooks);
      }
    }

    // Always add global hooks last (undefined selector)
    const globalHooks = hookMap.get(undefined);
    if (globalHooks) {
      middleware.push(...globalHooks);
    }

    return middleware;
  }

  /**
   * Get all registered hooks for a given hook name.
   * Useful for debugging or introspection.
   */
  getHookMap(hookName: THookName): Map<TSelector | undefined, THookMiddleware[]> | undefined {
    return this.hooks.get(hookName);
  }

  /**
   * Clear all hooks for a given hook name.
   */
  clearHook(hookName: THookName): void {
    this.hooks.delete(hookName);
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}
