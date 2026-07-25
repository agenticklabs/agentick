/**
 * BridgeContext — React Context carrying the runtime-supplied
 * `HookBridges` bundle into the JSX tree.
 *
 * The compiler harness wraps the user's element in
 * `<BridgeContext.Provider value={bridges}>` before each render. Hooks
 * (`useData`, `useKnob`, `useTimeline`, `useLoopControl`) consume the
 * context via `useBridges()`.
 *
 * Components rendered outside a `<BridgeContext.Provider>` (e.g.,
 * test-renders that bypass the harness) get a `null` context value;
 * any hook that needs a bridge throws a clear error in that case.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { HookBridges } from "@agentick/spec";

export const BridgeContext = createContext<HookBridges | null>(null);
BridgeContext.displayName = "AgentickBridgeContext";

export interface BridgeProviderProps {
  readonly value: HookBridges;
  readonly children?: ReactNode;
}

/**
 * Provider. Used by the compiler harness when wrapping the user's
 * element prior to render.
 */
export function BridgeProvider({ value, children }: BridgeProviderProps): React.ReactElement {
  return React.createElement(BridgeContext.Provider, { value }, children);
}

/**
 * Read the in-scope `HookBridges`. Throws if not within a provider.
 * Hooks consume this internally; user code rarely calls it directly.
 */
export function useBridges(): HookBridges {
  const bridges = useContext(BridgeContext);
  if (!bridges) {
    throw new Error(
      "useBridges (or a hook that depends on it) called outside a CompilerHarness mount. " +
        "Components must render inside <BridgeProvider> — the compiler harness wraps " +
        "automatically. Tests rendering outside the harness should wrap manually.",
    );
  }
  return bridges;
}
