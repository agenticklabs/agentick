/**
 * V2 Policy Context
 *
 * React context for providing policies to child components.
 * Replaces the v1 createPolicy pattern.
 */

import React, { createContext, useContext, type ReactNode } from "react";

// Helper for createElement
const h = React.createElement;

// ============================================================
// Policy Context Types
// ============================================================

export interface PolicyDefinition<T> {
  Provider: React.FC<{ value: T; children: ReactNode }>;
  usePolicy: () => T | null;
}

// ============================================================
// createPolicy Factory
// ============================================================

/**
 * Create a policy with context provider and hook.
 *
 * @param name - Policy name (for debugging)
 * @param processor - Optional processor function (not used in v2 stub)
 */
export function createPolicy<T, E = unknown>(
  _name: string,
  _processor?: (entries: E[], props: T) => Promise<E[]>,
): PolicyDefinition<T> {
  const PolicyContext = createContext<T | null>(null);

  function PolicyProvider({
    value,
    children,
  }: {
    value: T;
    children: ReactNode;
  }): React.ReactElement {
    return h(PolicyContext.Provider, { value }, children);
  }

  function usePolicy(): T | null {
    return useContext(PolicyContext);
  }

  return {
    Provider: PolicyProvider,
    usePolicy,
  };
}
