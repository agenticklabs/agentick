/**
 * react-reconciler instance + container/root lifecycle.
 *
 * One compiler per mount. Mount-local: `createCompiler(deps)` returns
 * a small driver bundle (createRoot, updateContainer, flushSyncWork)
 * that wraps the per-mount compiler. No module-level singletons.
 *
 * react-reconciler 0.33 API:
 *   - `createContainer(...)` returns a `FiberRoot`
 *   - `updateContainerSync(element, root)` queues a synchronous update
 *   - `flushSyncWork()` processes the queue + runs passive effects
 *
 * We render synchronously to completion on each iteration of the
 * render-until-stable loop — see `21-reconciler-implementation.md`
 * §Compile-until-stable.
 */

import ReactReconciler from "react-reconciler";
import type { ReactNode } from "react";
import type { HostConfigDeps } from "../host/host-config.js";
import { createHostConfig } from "../host/host-config.js";

export type FiberRoot = ReturnType<ReturnType<typeof ReactReconciler>["createContainer"]>;

export interface Compiler {
  /** Create a FiberRoot tied to this compiler's container. */
  createRoot(): FiberRoot;
  /** Queue a synchronous update + run all work + run passive effects. */
  render(element: ReactNode, root: FiberRoot): void;
  /**
   * Synchronously flush pending passive effects (`useEffect`). React
   * schedules these via the Scheduler (setImmediate in Node), so a
   * plain `render()` leaves them pending; the lifecycle-hook family
   * (ADR 54) registers via `useEffect` and MUST be live before the
   * first tick — mount calls this before resolving `mountReady`.
   */
  flushPassiveEffects(): void;
}

/**
 * Construct a per-mount compiler. Each call produces an independent
 * `ReactReconciler` instance bound to the supplied `HostConfigDeps` —
 * mounts do not share state.
 */
export function createCompiler(deps: HostConfigDeps): Compiler {
  const config = createHostConfig(deps);
  const instance = ReactReconciler(config as Parameters<typeof ReactReconciler>[0]);

  // Auto-register with the global React DevTools hook. If DevTools
  // isn't connected (no `enableReactDevTools()` call) this is a no-op
  // — the registration sits dormant until DevTools attaches. Safe to
  // always invoke; failures are swallowed (best-effort).
  try {
    (
      instance as unknown as {
        injectIntoDevTools?: (info: Record<string, unknown>) => void;
      }
    ).injectIntoDevTools?.({
      bundleType: process.env.NODE_ENV === "development" ? 1 : 0,
      version: "0.0.0",
      rendererPackageName: "@agentick/compiler-react",
      findFiberByHostInstance: () => null,
    });
  } catch {
    // best-effort
  }

  return {
    createRoot(): FiberRoot {
      // react-reconciler 0.33 createContainer signature:
      // (container, tag, hydrationCallbacks, isStrictMode,
      //  concurrentUpdatesByDefaultOverride, identifierPrefix,
      //  onUncaughtError, onCaughtError, onRecoverableError,
      //  transitionCallbacks)
      const createContainer = instance.createContainer as (...args: unknown[]) => FiberRoot;
      return createContainer(
        deps.container,
        0, // LegacyRoot — we render synchronously
        null,
        false,
        null,
        "",
        deps.onUncaughtError ?? defaultOnError("uncaught"),
        deps.onCaughtError ?? defaultOnError("caught"),
        deps.onRecoverableError ?? defaultOnError("recoverable"),
        null,
      );
    },

    render(element: ReactNode, root: FiberRoot): void {
      const updateContainerSync = (
        instance as unknown as {
          updateContainerSync?: (
            el: ReactNode,
            r: FiberRoot,
            parent?: unknown,
            cb?: () => void,
          ) => void;
        }
      ).updateContainerSync;
      if (updateContainerSync) {
        updateContainerSync(element, root, null, undefined);
      } else {
        // Fallback for older react-reconciler shapes.
        (
          instance.updateContainer as (
            el: ReactNode,
            r: FiberRoot,
            parent?: unknown,
            cb?: () => void,
          ) => void
        )(element, root, null, undefined);
      }
      const flushSyncWork = (instance as unknown as { flushSyncWork?: () => void }).flushSyncWork;
      if (flushSyncWork) flushSyncWork();
    },
    flushPassiveEffects: () => {
      (instance as unknown as { flushPassiveEffects?: () => void }).flushPassiveEffects?.();
    },
  };
}

function defaultOnError(kind: "uncaught" | "caught" | "recoverable") {
  return (err: Error): void => {
    // Surface unhandled host-config errors to stderr. Concrete harnesses
    // SHOULD override these callbacks via `HostConfigDeps`.
    // eslint-disable-next-line no-console
    console.error(`[@agentick/compiler-react ${kind}]`, err);
  };
}
