/**
 * LifecycleContext — provides the per-mount `LifecycleStore` to React
 * components so `useOnTickStart` / `useOnTickEnd` / etc. can register
 * handlers.
 *
 * Distinct from `BridgeContext` because the LifecycleStore is a
 * harness-internal concern (per-mount handler registry), whereas
 * bridges are runtime-supplied capability accessors. They're wrapped
 * separately at the harness's render boundary.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { LifecycleStore } from "@agentick/reconciler-next";

export const LifecycleContext = createContext<LifecycleStore | null>(null);
LifecycleContext.displayName = "AgentickLifecycleContext";

export interface LifecycleProviderProps {
  readonly value: LifecycleStore;
  readonly children?: ReactNode;
}

export function LifecycleProvider({ value, children }: LifecycleProviderProps): React.ReactElement {
  return React.createElement(LifecycleContext.Provider, { value }, children);
}

export function useLifecycleStore(): LifecycleStore {
  const store = useContext(LifecycleContext);
  if (!store) {
    throw new Error(
      "useOnTickStart / useOnTickEnd / useOnExecutionEnd / useOnError called outside " +
        "a ReconcilerHarness mount. The harness installs the LifecycleContext on each render.",
    );
  }
  return store;
}
