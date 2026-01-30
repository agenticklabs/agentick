/**
 * V2 Context Hooks
 *
 * React contexts for COM, TickState, and other engine-provided values.
 */

import React, { useContext, type ReactNode } from "react";
import type { TickState } from "./types";
import type { COM } from "../com/object-model";
import { RuntimeProvider, type RuntimeStore } from "./runtime-context";
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
 *   const com = useCom();
 *   const history = com.timeline;
 *   // ...
 * };
 * ```
 */
export function useCom(): COM {
  const com = useContext(COMContext);
  if (!com) {
    throw new Error("useCom must be used within a TentickleProvider");
  }
  return com;
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
 *   console.log(`Tick ${state.tick}`);
 *   // Access previous output via state.previous
 * };
 * ```
 */
export function useTickState(): TickState {
  const state = useContext(TickStateContext);
  if (!state) {
    throw new Error("useTickState must be used within a TentickleProvider");
  }
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

export interface TentickleProviderProps {
  com: COM;
  tickState: TickState;
  runtimeStore: RuntimeStore;
  children?: ReactNode; // Optional since React.createElement can pass it as third arg
}

/**
 * Combined provider for all Tentickle contexts.
 */
export function TentickleProvider({
  com,
  tickState,
  runtimeStore,
  children,
}: TentickleProviderProps): React.ReactElement {
  return h(
    RuntimeProvider,
    { store: runtimeStore },
    h(
      COMContext.Provider,
      { value: com },
      h(TickStateContext.Provider, { value: tickState }, children),
    ),
  );
}
