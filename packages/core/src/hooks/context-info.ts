/**
 * Context Info Hook
 *
 * Provides real-time access to context utilization information within JSX components.
 * Updated by the session after each tick with token usage and model capabilities.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const contextInfo = useContextInfo();
 *
 *   if (contextInfo?.utilization && contextInfo.utilization > 80) {
 *     // Context is getting full, maybe summarize or truncate
 *     return <Section id="summary">Summarized content...</Section>;
 *   }
 *
 *   return <Section id="full">Full detailed content...</Section>;
 * }
 * ```
 */

import React, { createContext, useContext, type ReactNode } from "react";

// Helper for createElement
const h = React.createElement;

// ============================================================
// Context Info Types
// ============================================================

/**
 * Context utilization information.
 * Updated after each tick with current token usage and model info.
 */
export interface ContextInfo {
  /** Model ID (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  modelId: string;
  /** Human-readable model name */
  modelName?: string;
  /** Provider name (e.g., "openai", "anthropic") */
  provider?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Input tokens used this tick */
  inputTokens: number;
  /** Output tokens generated this tick */
  outputTokens: number;
  /** Total tokens this tick */
  totalTokens: number;
  /** Context utilization percentage (0-100) */
  utilization?: number;
  /** Max output tokens for this model */
  maxOutputTokens?: number;
  /** Model capabilities */
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;
  /** Estimated total context tokens (from token estimation, pre-model-call) */
  estimatedContextTokens?: number;
  /** Current tick number */
  tick: number;
  /** Cumulative usage across all ticks in this execution */
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}

/**
 * Context info store - holds current context utilization state.
 */
export interface ContextInfoStore {
  /** Current context info (null before first tick completes) */
  current: ContextInfo | null;
  /** Update the context info */
  update: (info: ContextInfo) => void;
  /** Clear the context info */
  clear: () => void;
}

// ============================================================
// Store Factory
// ============================================================

/**
 * Create a new context info store.
 */
export function createContextInfoStore(): ContextInfoStore {
  let current: ContextInfo | null = null;

  return {
    get current() {
      return current;
    },
    update(info: ContextInfo) {
      current = info;
    },
    clear() {
      current = null;
    },
  };
}

// ============================================================
// React Context
// ============================================================

const ContextInfoContext = createContext<ContextInfoStore | null>(null);

/**
 * Get the context info store from context.
 * Returns null if not within a provider (for optional access).
 */
export function useContextInfoStore(): ContextInfoStore | null {
  return useContext(ContextInfoContext);
}

/**
 * Hook to access current context utilization info.
 *
 * Returns null if:
 * - Not within a session (no ContextInfoProvider)
 * - Before first tick completes
 *
 * @example Basic usage
 * ```tsx
 * function MyComponent() {
 *   const contextInfo = useContextInfo();
 *
 *   if (!contextInfo) {
 *     return null; // Not available yet
 *   }
 *
 *   console.log(`Using ${contextInfo.utilization}% of context`);
 *   return <Section id="content">...</Section>;
 * }
 * ```
 *
 * @example Conditional rendering based on context usage
 * ```tsx
 * function AdaptiveContent() {
 *   const contextInfo = useContextInfo();
 *
 *   // If context is over 75% full, use abbreviated content
 *   const isContextTight = contextInfo?.utilization && contextInfo.utilization > 75;
 *
 *   return isContextTight
 *     ? <Section id="brief">Brief summary...</Section>
 *     : <Section id="detailed">Full detailed content...</Section>;
 * }
 * ```
 *
 * @example Access model capabilities
 * ```tsx
 * function ImageTool() {
 *   const contextInfo = useContextInfo();
 *
 *   // Only render image tool if model supports vision
 *   if (!contextInfo?.supportsVision) {
 *     return null;
 *   }
 *
 *   return <Tool name="analyze_image" ... />;
 * }
 * ```
 */
export function useContextInfo(): ContextInfo | null {
  const store = useContext(ContextInfoContext);
  return store?.current ?? null;
}

/**
 * Provider for context info.
 * Used internally by Session to make context info available to components.
 */
export function ContextInfoProvider({
  store,
  children,
}: {
  store: ContextInfoStore;
  children?: ReactNode;
}): React.ReactElement {
  return h(ContextInfoContext.Provider, { value: store }, children);
}
