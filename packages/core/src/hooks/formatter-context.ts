/**
 * V2 Formatter Context
 *
 * React context for providing formatters to child components.
 * Replaces the v1 FormatterBoundary pattern.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { ContentBlock } from "@agentick/shared";
import type { SemanticContentBlock } from "../renderers";

// Helper for createElement
const h = React.createElement;

// ============================================================
// Formatter Context Types
// ============================================================

export interface FormatterContextValue {
  /** Formatter function that transforms semantic blocks to content blocks */
  formatter: (blocks: SemanticContentBlock[]) => ContentBlock[];
}

// ============================================================
// React Context
// ============================================================

const FormatterContext = createContext<FormatterContextValue | null>(null);

/**
 * Get the current formatter from context.
 */
export function useFormatter(): FormatterContextValue | null {
  return useContext(FormatterContext);
}

/**
 * Provider for formatter context.
 */
function FormatterProvider({
  value,
  children,
}: {
  value: FormatterContextValue;
  children: ReactNode;
}): React.ReactElement {
  return h(FormatterContext.Provider, { value }, children);
}

/**
 * FormatterBoundary - provides formatter context to children.
 *
 * This is a compatibility shim for v1 code that used FormatterBoundary.Provider
 */
export const FormatterBoundary = {
  Provider: FormatterProvider,
};
