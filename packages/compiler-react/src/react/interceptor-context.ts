/**
 * InterceptorContext — provides the per-mount
 * {@link CommandInterceptorRegistry} to React components so the tree-side
 * interception hooks (`useGuardToolDispatch`, `useTransformToolDispatch`,
 * `useTransformModelInput`, `useCommandInterceptor`) can register REAL,
 * in-path interceptors on the framework's commands (ADR 89 §4).
 *
 * Sibling of {@link LifecycleContext} — that context carries the
 * observe-only per-mount dispatch (the PUSH half of the projection); this
 * one carries the in-path interceptor registry (the PULL half). Both are
 * harness-internal, wrapped at the harness's render boundary alongside the
 * runtime `BridgeContext`.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import React, { createContext, useContext, type ReactNode } from "react";
import type { CommandInterceptorRegistry } from "@agentick/compiler";

export const InterceptorContext = createContext<CommandInterceptorRegistry | null>(null);
InterceptorContext.displayName = "AgentickInterceptorContext";

export interface InterceptorProviderProps {
  readonly value: CommandInterceptorRegistry;
  readonly children?: ReactNode;
}

export function InterceptorProvider({
  value,
  children,
}: InterceptorProviderProps): React.ReactElement {
  return React.createElement(InterceptorContext.Provider, { value }, children);
}

/**
 * Read the in-scope per-mount {@link CommandInterceptorRegistry}. Throws
 * when called outside a CompilerHarness mount — the harness installs the
 * context on every render, so this only fires in a bare test-render that
 * bypasses the harness.
 */
export function useCommandInterceptorRegistry(): CommandInterceptorRegistry {
  const registry = useContext(InterceptorContext);
  if (!registry) {
    throw new Error(
      "useGuardToolDispatch / useTransformToolDispatch / useTransformModelInput / " +
        "useCommandInterceptor called outside a CompilerHarness mount. The harness installs " +
        "the InterceptorContext on each render.",
    );
  }
  return registry;
}
