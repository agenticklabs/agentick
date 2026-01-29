/**
 * Boundary System for Tentickle
 *
 * Boundaries extend Context with collection-phase effects. They provide a generic
 * mechanism for components that affect how their children are processed during
 * compilation, without hardcoding specific component checks in the compiler.
 *
 * The abstraction ladder:
 * - createContext: render-phase values, read via useContext
 * - createBoundary: render-phase values + collection-phase effects
 * - createFormatter: convenience for formatter boundaries (collection-time)
 * - createPolicy: convenience for policy boundaries (format-time, auto-accumulating)
 *
 * @example Formatter boundary (like XML, Markdown)
 * ```tsx
 * // XML/Markdown use the unified FormatterBoundary
 * <XML>
 *   <Content />
 * </XML>
 *
 * // To get the current formatter during render:
 * const formatter = useBoundary(FormatterBoundary);
 * if (formatter) {
 *   const formatted = formatter.formatter(blocks);
 * }
 * ```
 *
 * @example Policy boundary (like TokenBudget)
 * ```tsx
 * // Policies auto-accumulate - nested policies are combined
 * <TokenBudget maxTokens={8000} strategy="drop-oldest">
 *   <Timeline />
 *   <TokenBudget maxTokens={2000} strategy="truncate">
 *     <User>{message}</User>  {/* Both policies apply \*\/}
 *   </TokenBudget>
 * </TokenBudget>
 *
 * // To get all active policies during render:
 * const policyValue = useBoundary(PolicyBoundary);
 * if (policyValue) {
 *   console.log('Active policies:', policyValue.policies.map(p => p.name));
 * }
 * ```
 *
 * @module tentickle/boundary
 */

import { createElement } from "../jsx/jsx-runtime";
import type { JSX } from "../jsx/jsx-runtime";
import { createContext, useContext, type Context } from "./context";
import type { Formatter } from "../renderers";
import type { COMTimelineEntry } from "../com/types";

// ============================================================================
// Types
// ============================================================================

/**
 * Symbol used to mark boundary provider components.
 * The fiber compiler detects this to handle boundary effects.
 */
export const BOUNDARY_PROVIDER_SYMBOL = Symbol.for("tentickle.boundary.provider");

/**
 * Boundary class determines how the compiler handles the boundary.
 * - 'formatter': Affects content rendering during collection (e.g., XML, Markdown)
 * - 'policy': Affects entries after collection, during formatInput (e.g., TokenBudget)
 */
export type BoundaryClass = "formatter" | "policy";

/**
 * Definition for creating a boundary.
 *
 * @template T - The type of value this boundary holds
 */
export interface BoundaryDefinition<T> {
  /** Default value when no provider above */
  defaultValue: T | null;

  /** Display name for debugging */
  displayName?: string;

  /** Boundary class - determines how compiler handles it */
  class: BoundaryClass;
}

/**
 * A Boundary object created by createBoundary().
 *
 * Boundaries ARE contexts with additional collection-phase effects.
 *
 * @template T - The type of value this boundary holds
 */
export interface Boundary<T> {
  /** The underlying context (boundaries ARE contexts) */
  readonly Context: Context<T | null>;

  /** Provider component */
  readonly Provider: BoundaryProvider<T>;

  /** Boundary class */
  readonly class: BoundaryClass;

  /** Display name for debugging */
  displayName?: string;

  /**
   * Internal: the definition.
   * @internal
   */
  readonly _definition: BoundaryDefinition<T>;
}

/**
 * Props for a boundary Provider component.
 */
export interface BoundaryProviderProps<T> {
  /** The value to provide */
  value: T;
  /** Child components */
  children?: any;
}

/**
 * Internal data attached to boundary providers.
 * @internal
 */
export interface BoundaryProviderData<T> {
  class: BoundaryClass;
  definition: BoundaryDefinition<T>;
}

/**
 * A boundary Provider component type.
 */
export type BoundaryProvider<T> = {
  (props: BoundaryProviderProps<T>): JSX.Element;
  /** @internal - Boundary data for compiler detection */
  [BOUNDARY_PROVIDER_SYMBOL]: BoundaryProviderData<T>;
  /** Display name for debugging */
  displayName?: string;
};

// ============================================================================
// createBoundary
// ============================================================================

/**
 * Creates a Boundary that extends Context with collection-phase effects.
 *
 * Boundaries can provide:
 * - Context values (readable via useBoundary/useContext during render)
 * - Formatter effects (affect content rendering during collection)
 * - Policy effects (process entries after collection)
 *
 * @param definition - The boundary definition
 * @returns A Boundary object with a Provider component
 *
 * @example
 * ```tsx
 * const MyBoundary = createBoundary({
 *   defaultValue: null,
 *   displayName: 'MyBoundary',
 *   class: 'formatter',
 *   formatter: (value) => new MyRenderer(),
 * });
 *
 * // Use it
 * <MyBoundary.Provider value={{}}>
 *   {children}
 * </MyBoundary.Provider>
 * ```
 */
export function createBoundary<T>(definition: BoundaryDefinition<T>): Boundary<T> {
  const displayName = definition.displayName || "Boundary";

  // Create underlying context (boundaries ARE contexts)
  const Context = createContext<T | null>(definition.defaultValue, displayName);

  // Create the Provider component
  function Provider(props: BoundaryProviderProps<T>): JSX.Element {
    // Provider wraps Context.Provider
    // The fiber compiler detects this via BOUNDARY_PROVIDER_SYMBOL
    // and applies the boundary effects during traversal
    return createElement(Context.Provider, {
      value: props.value,
      children: props.children,
    });
  }

  // Mark as boundary provider so compiler can detect it
  const boundaryData: BoundaryProviderData<T> = {
    class: definition.class,
    definition,
  };
  (Provider as BoundaryProvider<T>)[BOUNDARY_PROVIDER_SYMBOL] = boundaryData;
  Provider.displayName = `${displayName}.Provider`;

  // Create the boundary object
  const boundary: Boundary<T> = {
    Context,
    Provider: Provider as BoundaryProvider<T>,
    class: definition.class,
    displayName,
    _definition: definition,
  };

  return boundary;
}

// ============================================================================
// useBoundary
// ============================================================================

/**
 * Reads the current value of a boundary.
 *
 * This is a convenience wrapper around useContext that works with Boundary objects.
 * Returns the value from the nearest Provider ancestor, or null if no Provider is found.
 *
 * @param boundary - The Boundary object (created by createBoundary)
 * @returns The current boundary value, or null
 *
 * @example
 * ```tsx
 * const TokenBudgetBoundary = createPolicy<TokenBudgetProps>('TokenBudget', process);
 *
 * function TokenCounter() {
 *   const budget = useBoundary(TokenBudgetBoundary);
 *   if (!budget) return null;
 *   return <System>Budget: {budget.maxTokens} tokens</System>;
 * }
 * ```
 */
export function useBoundary<T>(boundary: Boundary<T>): T | null {
  return useContext(boundary.Context);
}

// ============================================================================
// FormatterBoundary (unified for all formatters)
// ============================================================================

/**
 * Value type for the FormatterBoundary.
 * Just contains a formatter function - ContentRenderer is an internal implementation detail.
 */
export interface FormatterBoundaryValue {
  /** The formatter function - transforms semantic blocks to content blocks */
  formatter: Formatter;
}

/**
 * The unified formatter boundary used by XML, Markdown, JSON, etc.
 *
 * All formatter components (XML, Markdown, JSON) use this single boundary.
 * The value contains a formatter function. Use `useBoundary(FormatterBoundary)`
 * to get the current formatter regardless of which formatter type is active.
 *
 * **Inner wins semantics:** When formatters are nested, the innermost formatter
 * is used for content within its scope.
 *
 * @example
 * ```tsx
 * // In a component - get the current formatter
 * const formatterValue = useBoundary(FormatterBoundary);
 * if (formatterValue) {
 *   const formatted = formatterValue.formatter(blocks);
 * }
 *
 * // XML, Markdown, etc. use this boundary internally
 * function XML({ children }) {
 *   return (
 *     <FormatterBoundary.Provider value={{ formatter: (blocks) => xmlRenderer.format(blocks) }}>
 *       {children}
 *     </FormatterBoundary.Provider>
 *   );
 * }
 * ```
 */
export const FormatterBoundary: Boundary<FormatterBoundaryValue> =
  createBoundary<FormatterBoundaryValue>({
    defaultValue: null,
    displayName: "Formatter",
    class: "formatter",
  });

// ============================================================================
// createFormatter
// ============================================================================

/**
 * Creates a formatter component that uses the unified FormatterBoundary.
 *
 * This is a convenience function for creating formatter components like XML, Markdown.
 * It creates a component that wraps children in FormatterBoundary.Provider with the
 * provided formatter function.
 *
 * @param name - Display name for debugging
 * @param formatter - The formatter function or factory
 * @returns A component function that provides the formatter to children
 *
 * @example
 * ```tsx
 * // Create a custom formatter
 * const CustomFormat = createFormatter('CustomFormat', (blocks) => {
 *   return blocks.map(block => ({ type: 'text', text: `[${block.text}]` }));
 * });
 *
 * // Use it
 * <CustomFormat>
 *   <Content />
 * </CustomFormat>
 * ```
 */
export function createFormatter(
  name: string,
  formatter: Formatter | (() => Formatter),
): (props: { children?: any }) => JSX.Element {
  const resolvedFormatter =
    typeof formatter === "function" && formatter.length === 0
      ? (formatter as () => Formatter)()
      : (formatter as Formatter);

  function FormatterComponent(props: { children?: any }): JSX.Element {
    return createElement(FormatterBoundary.Provider, {
      value: { formatter: resolvedFormatter },
      children: props.children,
    });
  }

  FormatterComponent.displayName = name;
  return FormatterComponent;
}

// ============================================================================
// PolicyBoundary (unified for all policies)
// ============================================================================

/**
 * Policy process function type.
 * Transforms timeline entries (filtering, summarization, etc.).
 */
export type PolicyProcessFunction<TConfig = unknown> = (
  entries: COMTimelineEntry[],
  config: TConfig,
) => COMTimelineEntry[] | Promise<COMTimelineEntry[]>;

/**
 * A single policy in the policy chain.
 */
export interface PolicyEntry<TConfig = unknown> {
  /** Policy name for debugging/identification */
  name: string;
  /** The process function that transforms entries */
  process: PolicyProcessFunction<TConfig>;
  /** Configuration for this policy instance */
  config: TConfig;
}

/**
 * Value type for the PolicyBoundary.
 * Holds an array of accumulated policies.
 */
export interface PolicyBoundaryValue {
  /** Accumulated policies from all ancestors plus current */
  policies: PolicyEntry[];
}

/**
 * The unified policy boundary used by TokenBudget, etc.
 *
 * All policy components use this single boundary. Policies **accumulate** -
 * nested policies don't replace parent policies, they add to them.
 * Use `useBoundary(PolicyBoundary)` to get ALL active policies in scope.
 *
 * **Accumulating semantics:** When policies are nested, ALL policies apply
 * to content within their combined scope, processed in order (outer first).
 *
 * @example
 * ```tsx
 * // In a component - get all active policies
 * const policyValue = useBoundary(PolicyBoundary);
 * if (policyValue) {
 *   console.log('Active policies:', policyValue.policies.map(p => p.name));
 *   // e.g., ['TokenBudget', 'Summarizer']
 * }
 * ```
 *
 * @example Nested policies accumulate - both TokenBudget AND Summarizer apply
 * ```tsx
 * <TokenBudget maxTokens={8000}>
 *   <Summarizer threshold={5000}>
 *     <Timeline />
 *   </Summarizer>
 * </TokenBudget>
 * ```
 */
export const PolicyBoundary: Boundary<PolicyBoundaryValue> = createBoundary<PolicyBoundaryValue>({
  defaultValue: null,
  displayName: "Policy",
  class: "policy",
});

// ============================================================================
// createPolicy
// ============================================================================

/**
 * Creates a policy component that auto-accumulates into PolicyBoundary.
 *
 * Policy boundaries affect the timeline entries during the formatInput phase,
 * after all entries have been collected. Use this for filtering, transforming,
 * or managing entries (e.g., token budgets, summarization).
 *
 * **Auto-accumulation:** The created component automatically reads parent policies
 * from PolicyBoundary, appends its own policy, and provides the combined list.
 * You don't need to manually handle accumulation.
 *
 * @param name - Display name for debugging
 * @param process - Function to process entries
 * @returns An object with Provider component and usePolicy hook
 *
 * @example Creating a policy
 * ```typescript
 * const tokenBudget = createPolicy<TokenBudgetProps>(
 *   'TokenBudget',
 *   async (entries, props) => applyTokenBudget(entries, props)
 * );
 *
 * // Use the Provider - auto-accumulates with parent policies
 * // <tokenBudget.Provider value={{ maxTokens: 4000, strategy: 'drop-oldest' }}>
 * //   <Timeline />
 * // </tokenBudget.Provider>
 *
 * // Read this specific policy's config with usePolicy hook
 * // const config = tokenBudget.usePolicy();
 * ```
 */
export function createPolicy<TConfig>(
  name: string,
  process: PolicyProcessFunction<TConfig>,
): {
  /** Provider component that auto-accumulates into PolicyBoundary */
  Provider: (props: { value: TConfig; children?: any }) => JSX.Element;
  /** Hook to read this specific policy's config (innermost) */
  usePolicy: () => TConfig | null;
  /** The policy name */
  name: string;
  /** The process function */
  process: PolicyProcessFunction<TConfig>;
} {
  // Create a context for this specific policy's config
  const PolicyConfigContext = createContext<TConfig | null>(null, `${name}Config`);

  function PolicyProvider(props: { value: TConfig; children?: any }): JSX.Element {
    // Get parent policies (auto-accumulation)
    const parentValue = useContext(PolicyBoundary.Context);
    const parentPolicies = parentValue?.policies || [];

    // Create new policy entry
    const newPolicy: PolicyEntry<TConfig> = {
      name,
      process: process as PolicyProcessFunction,
      config: props.value,
    };

    // Combine parent policies with this one
    const combinedPolicies = [...parentPolicies, newPolicy];

    // Provide both the combined policies AND this policy's specific config
    return createElement(PolicyBoundary.Provider, {
      value: { policies: combinedPolicies },
      children: createElement(PolicyConfigContext.Provider, {
        value: props.value,
        children: props.children,
      }),
    });
  }

  PolicyProvider.displayName = `${name}.Provider`;

  function usePolicy(): TConfig | null {
    return useContext(PolicyConfigContext);
  }

  return {
    Provider: PolicyProvider,
    usePolicy,
    name,
    process,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a component is a boundary provider.
 * Used by the fiber compiler during traversal.
 *
 * @internal
 */
export function isBoundaryProvider(component: unknown): component is BoundaryProvider<unknown> {
  return (
    typeof component === "function" &&
    BOUNDARY_PROVIDER_SYMBOL in component &&
    (component as any)[BOUNDARY_PROVIDER_SYMBOL] !== undefined
  );
}

/**
 * Get the boundary data from a provider component.
 *
 * @internal
 */
export function getBoundaryData<T>(provider: BoundaryProvider<T>): BoundaryProviderData<T> {
  return provider[BOUNDARY_PROVIDER_SYMBOL];
}
