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

// Layer B — Contributor protocol + collect walker
export type { CollectContext, Contributor } from "./collect/contributor.js";
export type { IRFragment } from "./collect/fragments.js";
export { NO_FRAGMENTS } from "./collect/fragments.js";
export { ContributorRegistry } from "./collect/registry.js";
export { collect } from "./collect/collect.js";
export type { CollectInput, CollectResult } from "./collect/collect.js";
export { createBuiltInRegistry } from "./collect/contributors/built-ins.js";
export { sectionContributor } from "./collect/contributors/section.js";
export { messageContributor } from "./collect/contributors/message.js";
export { toolContributor } from "./collect/contributors/tool.js";
export { resourceContributor } from "./collect/contributors/resource.js";
export { outputContributor } from "./collect/contributors/output.js";
export { mcpContributor } from "./collect/contributors/mcp.js";
export { modelContributor } from "./collect/contributors/model.js";
