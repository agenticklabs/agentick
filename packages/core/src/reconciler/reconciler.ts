/**
 * V2 Reconciler
 *
 * Creates the react-reconciler instance with our host config.
 */

import ReactReconciler from "react-reconciler";
import { hostConfig, registerRendererComponent } from "./host-config";
import type { TentickleContainer, TentickleNode } from "./types";
import type { Renderer } from "../renderers/types";
import { markdownRenderer } from "../renderers/markdown";

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
export function createContainer(renderer: Renderer = markdownRenderer): TentickleContainer {
  return {
    children: [],
    renderer,
  };
}

/**
 * Create a fiber root for a container.
 */
export function createRoot(container: TentickleContainer): FiberRoot {
  // Arguments match react-reconciler 0.29.x
  // Note: @types/react-reconciler 0.28.x has fewer args, so we use type assertion
  return (reconciler.createContainer as any)(
    container,
    0, // LegacyRoot (ConcurrentRoot = 1)
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    "", // identifierPrefix
    // uncaughtError
    (error: Error) => {
      console.error("Uncaught error in Tentickle:", error);
    },
    // onCaughtError
    (error: Error) => {
      console.error("Caught error in Tentickle:", error);
    },
    // onRecoverableError
    (error: Error) => {
      console.warn("Recoverable error in Tentickle:", error);
    },
    // transitionCallbacks - not used
    null,
  );
}

/**
 * Update the container with new elements.
 */
export function updateContainer(
  element: React.ReactNode,
  root: FiberRoot,
  callback?: () => void,
): void {
  reconciler.updateContainer(element, root, null, callback);
}

/**
 * Flush all pending work synchronously.
 */
export function flushSync<T>(fn: () => T): T {
  return reconciler.flushSync(fn);
}

/**
 * Flush all pending passive effects (useEffect callbacks).
 *
 * In a non-DOM environment, passive effects don't automatically flush.
 * Call this after flushSync to ensure useEffect callbacks run immediately.
 */
export function flushPassiveEffects(): boolean {
  return reconciler.flushPassiveEffects();
}

/**
 * Get all children from a container.
 */
export function getContainerChildren(container: TentickleContainer): TentickleNode[] {
  return container.children;
}

// Re-export
export { registerRendererComponent };
export type { TentickleNode, TentickleContainer };
