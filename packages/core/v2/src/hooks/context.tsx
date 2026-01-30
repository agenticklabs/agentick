/** @jsxImportSource react */
/**
 * V2 Context Hooks
 *
 * React contexts for COM, TickState, and other engine-provided values.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { COM, TickState } from "./types";
import { RuntimeProvider, type RuntimeStore } from "./runtime-context";

// ============================================================
// COM Context
// ============================================================

const COMContext = createContext<COM | null>(null);

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
}): React.JSX.Element {
  return <COMContext.Provider value={value}>{children}</COMContext.Provider>;
}

// ============================================================
// TickState Context
// ============================================================

const TickStateContext = createContext<TickState | null>(null);

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
}): React.JSX.Element {
  return <TickStateContext.Provider value={value}>{children}</TickStateContext.Provider>;
}

// ============================================================
// Combined Provider
// ============================================================

export interface TentickleProviderProps {
  com: COM;
  tickState: TickState;
  runtimeStore: RuntimeStore;
  children: ReactNode;
}

/**
 * Combined provider for all Tentickle contexts.
 */
export function TentickleProvider({
  com,
  tickState,
  runtimeStore,
  children,
}: TentickleProviderProps): React.JSX.Element {
  return (
    <RuntimeProvider store={runtimeStore}>
      <COMContext.Provider value={com}>
        <TickStateContext.Provider value={tickState}>{children}</TickStateContext.Provider>
      </COMContext.Provider>
    </RuntimeProvider>
  );
}
