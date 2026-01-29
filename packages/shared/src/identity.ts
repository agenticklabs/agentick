/**
 * Symbol-based identity utilities for minification-safe type checking.
 *
 * Functions can be marked with symbols to identify them even after minification
 * where function names are mangled.
 *
 * @example
 * ```typescript
 * // Define a symbol for your component type
 * const MY_COMPONENT_SYMBOL = Symbol.for('tentickle.myComponent');
 *
 * // Mark the component
 * export const MyComponent = markWithSymbol(MY_COMPONENT_SYMBOL, (props) => {
 *   return createElement(MyComponent, props);
 * });
 *
 * // Check identity (minification-safe)
 * if (hasSymbol(someFunction, MY_COMPONENT_SYMBOL)) {
 *   // It's a MyComponent
 * }
 * ```
 */

/**
 * Symbol used to mark host primitive components.
 * These are structural primitives that should be handled by the renderer,
 * not executed as functions.
 */
export const HOST_PRIMITIVE_SYMBOL = Symbol.for("tentickle.hostPrimitive");

/**
 * Symbol used to mark semantic components.
 */
export const SEMANTIC_COMPONENT_SYMBOL = Symbol.for("tentickle.semanticComponent");

/**
 * Symbol used to mark content components.
 */
export const CONTENT_COMPONENT_SYMBOL = Symbol.for("tentickle.contentComponent");

/**
 * Check if a value has a specific symbol marker.
 *
 * @param value - The value to check
 * @param symbol - The symbol to look for
 * @returns True if the value has the symbol marker
 */
export function hasSymbol(value: unknown, symbol: symbol): boolean {
  return (
    typeof value === "function" && (value as unknown as Record<symbol, unknown>)[symbol] === true
  );
}

/**
 * Mark a function with a symbol for identity checking.
 * Returns the same function with the symbol attached.
 *
 * @param symbol - The symbol to attach
 * @param fn - The function to mark
 * @returns The same function with the symbol attached
 */
export function markWithSymbol<T extends Function>(symbol: symbol, fn: T): T {
  (fn as Record<symbol, unknown>)[symbol] = true;
  return fn;
}

/**
 * Mark a function as a host primitive.
 * Host primitives are structural components that should be handled by the
 * renderer directly, not executed as functions.
 *
 * @param fn - The function to mark as a host primitive
 * @returns The same function marked as a host primitive
 */
export function markAsHostPrimitive<T extends Function>(fn: T): T {
  return markWithSymbol(HOST_PRIMITIVE_SYMBOL, fn);
}

/**
 * Check if a value is a host primitive component.
 * Minification-safe - uses symbol identity, not function name.
 *
 * @param value - The value to check
 * @returns True if it's a host primitive
 */
export function isHostPrimitive(value: unknown): boolean {
  return hasSymbol(value, HOST_PRIMITIVE_SYMBOL);
}

/**
 * Mark a function as a semantic component.
 *
 * @param fn - The function to mark
 * @returns The same function marked as a semantic component
 */
export function markAsSemanticComponent<T extends Function>(fn: T): T {
  return markWithSymbol(SEMANTIC_COMPONENT_SYMBOL, fn);
}

/**
 * Check if a value is a semantic component.
 *
 * @param value - The value to check
 * @returns True if it's a semantic component
 */
export function isSemanticComponent(value: unknown): boolean {
  return hasSymbol(value, SEMANTIC_COMPONENT_SYMBOL);
}

/**
 * Mark a function as a content component.
 *
 * @param fn - The function to mark
 * @returns The same function marked as a content component
 */
export function markAsContentComponent<T extends Function>(fn: T): T {
  return markWithSymbol(CONTENT_COMPONENT_SYMBOL, fn);
}

/**
 * Check if a value is a content component.
 *
 * @param value - The value to check
 * @returns True if it's a content component
 */
export function isContentComponent(value: unknown): boolean {
  return hasSymbol(value, CONTENT_COMPONENT_SYMBOL);
}
