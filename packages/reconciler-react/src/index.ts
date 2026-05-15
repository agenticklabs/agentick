/**
 * @agentick/reconciler-react — reference reconciler harness.
 *
 * Public exports. Concrete components / hooks / contributors are added
 * as Phase 3 progresses.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

// Host layer (Layer A)
export type {
  HostInstance,
  ElementInstance,
  TextInstance,
  HostType,
  Props,
} from "./host/host-instance.js";
export {
  createElementInstance,
  createTextInstance,
  isElementInstance,
  isTextInstance,
} from "./host/host-instance.js";

export type { HostScope, FormatterScope, FormatterBinding } from "./host/host-context.js";
export {
  createHostScope,
  withFormatter,
  resolveFormatter,
  rootScope,
} from "./host/host-context.js";

export type { ReconcilerContainer } from "./host/container.js";
export { createContainer } from "./host/container.js";

export type { HostConfigDeps } from "./host/host-config.js";
export { createHostConfig } from "./host/host-config.js";

// React reconciler integration
export { createReconciler } from "./react/reconciler.js";
export type { FiberRoot } from "./react/reconciler.js";
