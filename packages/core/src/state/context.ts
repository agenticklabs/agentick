/**
 * React-style Context API for Tentickle
 *
 * Provides createContext and useContext for sharing values down the component tree
 * without prop drilling. Follows React's context pattern exactly.
 *
 * @example
 * ```tsx
 * // Create a context with default value
 * const ThemeContext = createContext<'light' | 'dark'>('light');
 *
 * // Provide a value
 * const App = () => (
 *   <ThemeContext.Provider value="dark">
 *     <ChildComponent />
 *   </ThemeContext.Provider>
 * );
 *
 * // Consume the value
 * const ChildComponent = () => {
 *   const theme = useContext(ThemeContext);
 *   return <Text>Current theme: {theme}</Text>;
 * };
 * ```
 *
 * @module tentickle/context
 */

import { createElement, Fragment } from "../jsx/jsx-runtime";
import type { JSX } from "../jsx/jsx-runtime";
import { getCurrentContext } from "./hooks";

// ============================================================================
// Types
// ============================================================================

/**
 * Symbol used to mark context provider components.
 * The fiber compiler detects this to handle context propagation.
 */
export const CONTEXT_PROVIDER_SYMBOL = Symbol.for("tentickle.context.provider");

/**
 * A Context object created by createContext().
 *
 * @template T - The type of value this context holds
 */
export interface Context<T> {
  /**
   * The default value returned by useContext when no Provider is found.
   * @internal
   */
  readonly _defaultValue: T;

  /**
   * Display name for debugging (shown in DevTools).
   */
  displayName?: string;

  /**
   * Provider component that supplies the context value to descendants.
   *
   * @example
   * ```tsx
   * <MyContext.Provider value={someValue}>
   *   {children}
   * </MyContext.Provider>
   * ```
   */
  readonly Provider: ContextProvider<T>;
}

/**
 * Props for a context Provider component.
 */
export interface ContextProviderProps<T> {
  /** The value to provide to consuming components */
  value: T;
  /** Child components that can consume this context */
  children?: any;
}

/**
 * A context Provider component type.
 */
export type ContextProvider<T> = {
  (props: ContextProviderProps<T>): JSX.Element;
  /** @internal - Reference to the context object */
  [CONTEXT_PROVIDER_SYMBOL]: Context<T>;
  /** Display name for debugging */
  displayName?: string;
};

// ============================================================================
// createContext
// ============================================================================

/**
 * Creates a Context object that can be used to pass values down the component tree.
 *
 * Components can provide values via `<Context.Provider value={...}>` and
 * consume them via `useContext(Context)`.
 *
 * @param defaultValue - The value returned by useContext when no Provider is found
 * @param displayName - Optional name for debugging (shown in DevTools)
 * @returns A Context object with a Provider component
 *
 * @example
 * ```tsx
 * // Create context
 * const UserContext = createContext<User | null>(null, 'UserContext');
 *
 * // Provide value
 * <UserContext.Provider value={currentUser}>
 *   <App />
 * </UserContext.Provider>
 *
 * // Consume value
 * const user = useContext(UserContext);
 * ```
 */
export function createContext<T>(defaultValue: T, displayName?: string): Context<T> {
  // Create the context object
  const context: Context<T> = {
    _defaultValue: defaultValue,
    displayName,
    Provider: null as any, // Set below
  };

  // Create the Provider component
  function Provider(props: ContextProviderProps<T>): JSX.Element {
    // Provider just renders its children
    // The fiber compiler detects this component via CONTEXT_PROVIDER_SYMBOL
    // and handles the context stack push/pop during render
    return createElement(Fragment, { children: props.children });
  }

  // Mark as context provider so compiler can detect it
  (Provider as ContextProvider<T>)[CONTEXT_PROVIDER_SYMBOL] = context;
  Provider.displayName = displayName ? `${displayName}.Provider` : "Context.Provider";

  // Attach provider to context
  (context as any).Provider = Provider;

  return context;
}

// ============================================================================
// useContext
// ============================================================================

/**
 * Reads the current value of a context.
 *
 * Returns the value from the nearest Provider ancestor, or the default value
 * if no Provider is found.
 *
 * @param context - The Context object (created by createContext)
 * @returns The current context value
 *
 * @example
 * ```tsx
 * const ThemeContext = createContext('light');
 *
 * function ThemedButton() {
 *   const theme = useContext(ThemeContext);
 *   return <Text>Theme is: {theme}</Text>;
 * }
 * ```
 */
export function useContext<T>(context: Context<T>): T {
  const renderCtx = getCurrentContext();

  // Check if we have a value in the context map
  if (renderCtx.contextMap?.has(context)) {
    return renderCtx.contextMap.get(context) as T;
  }

  // Return default value if no provider found
  return context._defaultValue;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a component is a context provider.
 * Used by the fiber compiler during render.
 *
 * @internal
 */
export function isContextProvider(component: unknown): component is ContextProvider<unknown> {
  return (
    typeof component === "function" &&
    CONTEXT_PROVIDER_SYMBOL in component &&
    (component as any)[CONTEXT_PROVIDER_SYMBOL] !== undefined
  );
}

/**
 * Get the context object from a provider component.
 *
 * @internal
 */
export function getProviderContext<T>(provider: ContextProvider<T>): Context<T> {
  return provider[CONTEXT_PROVIDER_SYMBOL];
}
