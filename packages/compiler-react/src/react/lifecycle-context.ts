/**
 * LifecycleContext — provides the per-mount `LifecycleDispatch` to React
 * components so `useOnTickStart` / `useOnTickEnd` / etc. can register
 * handlers.
 *
 * Distinct from `BridgeContext` because the LifecycleDispatch is a
 * harness-internal concern (per-mount handler registry + catch-up
 * cache — the compiler's half of the ADR 89 §4 lifecycle projection),
 * whereas bridges are runtime-supplied capability accessors. They're
 * wrapped separately at the harness's render boundary.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { LifecycleDispatch } from "@agentick/compiler";

export const LifecycleContext = createContext<LifecycleDispatch | null>(null);
LifecycleContext.displayName = "AgentickLifecycleContext";

export interface LifecycleProviderProps {
  readonly value: LifecycleDispatch;
  readonly children?: ReactNode;
}

export function LifecycleProvider({ value, children }: LifecycleProviderProps): React.ReactElement {
  return React.createElement(LifecycleContext.Provider, { value }, children);
}

export function useLifecycleDispatch(): LifecycleDispatch {
  const dispatch = useContext(LifecycleContext);
  if (!dispatch) {
    throw new Error(
      "useOnTickStart / useOnTickEnd / useOnExecutionEnd / useOnError called outside " +
        "a CompilerHarness mount. The harness installs the LifecycleContext on each render.",
    );
  }
  return dispatch;
}
