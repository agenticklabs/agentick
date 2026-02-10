/**
 * Context Hooks
 *
 * React contexts for COM, TickState, and other engine-provided values.
 */

import React, { useContext, useDebugValue, type ReactNode } from "react";
import type { TickState } from "./types";
import type { COM } from "../com/object-model";
import { RuntimeProvider, type RuntimeStore } from "./runtime-context";
import { ContextInfoProvider, type ContextInfoStore } from "./context-info";
import { COMContext, TickStateContext } from "./context-internal";

// Helper for createElement
const h = React.createElement;

// Re-export contexts for provider usage
export { COMContext, TickStateContext };

/**
 * Get the COM (Context Object Model) for the current render.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const ctx = useCom();
 *   const history = ctx.timeline;
 *   // ...
 * };
 * ```
 */
export function useCom(): COM {
  const ctx = useContext(COMContext);
  if (!ctx) {
    throw new Error("useCom must be used within a AgentickProvider");
  }
  useDebugValue(ctx ? "COM" : "No COM");
  return ctx;
}

/**
 * Provider for COM context.
 */
export function COMProvider({
  value,
  children,
}: {
  value: COM;
  children: ReactNode;
}): React.ReactElement {
  return h(COMContext.Provider, { value }, children);
}

// ============================================================
// TickState Context
// ============================================================

/**
 * Get the current tick state.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const state = useTickState();
 *   console.log(`Tick ${state.tick}, timeline: ${state.timeline.length} entries`);
 * };
 * ```
 */
export function useTickState(): TickState {
  const state = useContext(TickStateContext);
  if (!state) {
    throw new Error("useTickState must be used within a AgentickProvider");
  }
  useDebugValue(state ? `Tick ${state.tick}` : "No TickState");
  return state;
}

/**
 * Provider for TickState context.
 */
export function TickStateProvider({
  value,
  children,
}: {
  value: TickState;
  children: ReactNode;
}): React.ReactElement {
  return h(TickStateContext.Provider, { value }, children);
}

// ============================================================
// Combined Provider
// ============================================================

export interface AgentickProviderProps {
  ctx: COM;
  tickState: TickState;
  runtimeStore: RuntimeStore;
  contextInfoStore?: ContextInfoStore;
  children?: ReactNode; // Optional since React.createElement can pass it as third arg
}

/**
 * Combined provider for all Agentick contexts.
 */
export function AgentickProvider({
  ctx,
  tickState,
  runtimeStore,
  contextInfoStore,
  children,
}: AgentickProviderProps): React.ReactElement {
  // Build provider chain: Runtime -> ContextInfo -> COM -> TickState
  // Using explicit ReactNode typing to avoid type inference issues
  let content: ReactNode = h(TickStateContext.Provider, { value: tickState }, children);
  content = h(COMContext.Provider, { value: ctx }, content);

  // Only add ContextInfoProvider if store is provided
  if (contextInfoStore) {
    content = h(ContextInfoProvider, { store: contextInfoStore }, content);
  }

  return h(RuntimeProvider, { store: runtimeStore }, content) as React.ReactElement;
}
