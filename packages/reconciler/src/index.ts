/**
 * `@agentick/reconciler` — reconciler-agnostic base.
 *
 * Owns:
 *   - Layer A: generic host tree shapes (HostInstance, HostScope,
 *     ReconcilerContainer) — the contract concrete reconcilers
 *     (React, Angular, …) build against.
 *   - Layer B: the contributor protocol + collect walker + built-in
 *     contributors that turn a host tree into the spec's RenderedTree IR.
 *   - Bridges: reference `InMemoryDataBridge` + protocol mocks
 *     (`stubBridges`, `mockTimelineHarness`, etc.) for tests.
 *   - `LifecycleStore` — generic per-mount lifecycle handler registry
 *     used by `useOnX` hooks in any reconciler.
 *   - `defineReconciler` — callback-style `ReconcilerProtocol` factory.
 *
 * What does NOT live here:
 *   - React-specific binding (`react-reconciler`'s HostConfig, JSX
 *     runtime, hooks, components). Those live in
 *     `@agentick/reconciler-react`.
 *
 * @see ../README.md
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

// Layer A — host tree shapes
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
  withPath,
  resolveFormatter,
  rootScope,
} from "./host/host-context.js";

export type { ReconcilerContainer } from "./host/container.js";
export { createContainer } from "./host/container.js";

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
export {
  imageContributor,
  documentContributor,
  audioContributor,
  videoContributor,
} from "./collect/contributors/media.js";
export {
  textBlockContributor,
  codeContributor,
  jsonContributor,
  xmlBlockContributor,
  csvContributor,
  htmlContributor,
  reasoningContributor,
} from "./collect/contributors/textual-blocks.js";
export {
  userActionContributor,
  systemEventContributor,
  stateChangeContributor,
} from "./collect/contributors/event-blocks.js";
export { customBlockContributor } from "./collect/contributors/custom-block.js";
export { contentPassthroughContributor } from "./collect/contributors/content-passthrough.js";

// Bridges — reference impl + protocol mocks for tests
export { InMemoryDataBridge } from "./bridges/in-memory-data-bridge.js";
export type { InMemoryDataBridgeOptions } from "./bridges/in-memory-data-bridge.js";
export {
  stubBridges,
  stubLoopBridge,
  stubSessionBridge,
  mockTimelineHarness,
  mockKnobsHarness,
  mockStateHarness,
} from "./bridges/stub-bridges.js";
export type { StubBridgesOptions } from "./bridges/stub-bridges.js";

// Lifecycle store — per-mount registry used by useOnX hooks
export { LifecycleStore } from "./lifecycle-store.js";
export type { LifecycleHandlerKind } from "./lifecycle-store.js";

// Callback-style factory
export { defineReconciler, type DefineReconcilerInput } from "./define-reconciler.js";
