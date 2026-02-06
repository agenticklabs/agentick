/**
 * Base props that all components can accept.
 * These are handled universally by EngineComponent and the compiler.
 */
export interface ComponentBaseProps {
  /**
   * Reference name for accessing this component instance.
   * Use ctx.getRef<ComponentType>('myRef') to access the instance.
   *
   * @example
   * ```tsx
   * <Harness ref="myHarness" component={MyAgent} props={input} />
   * const harness = ctx.getRef<HarnessComponent>('myHarness');
   * ```
   */
  ref?: string;

  /**
   * Key for React-like reconciliation (optional).
   * Used by compiler to track component instances across renders.
   */
  key?: string | number;
}
