/**
 * Reconciler
 *
 * Creates the react-reconciler instance with our host config.
 */

import ReactReconciler from "react-reconciler";
import { hostConfig, registerRendererComponent } from "./host-config.js";
import type { AgentickContainer, AgentickNode } from "./types.js";
import type { Renderer } from "../renderers/types.js";
import { markdownRenderer } from "../renderers/markdown.js";

/**
 * The reconciler instance.
 */
export const reconciler = ReactReconciler(hostConfig);

/**
 * Fiber root type from the reconciler.
 */
export type FiberRoot = ReturnType<typeof reconciler.createContainer>;

/**
 * Create a new container for rendering.
 */
export function createContainer(renderer: Renderer = markdownRenderer): AgentickContainer {
  return {
    children: [],
    renderer,
  };
}

/**
 * Create a fiber root for a container.
 */
export function createRoot(container: AgentickContainer): FiberRoot {
  return (reconciler.createContainer as any)(
    container,
    0, // LegacyRoot (ConcurrentRoot = 1)
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    "", // identifierPrefix
    // uncaughtError
    (error: Error) => {
      console.error("Uncaught error in Agentick:", error);
    },
    // onCaughtError
    (error: Error) => {
      console.error("Caught error in Agentick:", error);
    },
    // onRecoverableError
    (error: Error) => {
      console.warn("Recoverable error in Agentick:", error);
    },
    // transitionCallbacks - not used
    null,
  );
}

/**
 * Queue a synchronous update to the container.
 *
 * In react-reconciler 0.33, `updateContainerSync` queues a sync update.
 * Follow with `flushSyncWork()` to process it and run all passive effects.
 */
export function updateContainer(
  element: React.ReactNode,
  root: FiberRoot,
  callback?: () => void,
): void {
  (reconciler as any).updateContainerSync(element, root, null, callback);
}

/**
 * Flush all pending synchronous work and passive effects.
 *
 * In react-reconciler 0.33, this single call replaces the old
 * `flushSync()` + `flushPassiveEffects()` combo. It synchronously
 * processes all queued updates AND runs useEffect callbacks.
 */
export function flushSyncWork(): void {
  (reconciler as any).flushSyncWork();
}

/**
 * Get all children from a container.
 */
export function getContainerChildren(container: AgentickContainer): AgentickNode[] {
  return container.children;
}

// Re-export
export { registerRendererComponent };
export type { AgentickNode, AgentickContainer };

// Re-export devtools bridge
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disconnectReactDevTools,
} from "./devtools-bridge.js";

/**
 * Inject renderer info into React DevTools.
 * This allows React DevTools to recognize Agentick as a custom renderer.
 */
try {
  (reconciler as any).injectIntoDevTools({
    bundleType: process.env.NODE_ENV === "development" ? 1 : 0,
    version: "1.0.0",
    rendererPackageName: "@agentick/core",
    findFiberByHostInstance: () => null,
  });
} catch {
  // DevTools injection is optional
}
