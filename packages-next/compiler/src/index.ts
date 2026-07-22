/**
 * `@agentick/compiler-next` — compiler-agnostic base.
 *
 * Owns:
 *   - Layer A: generic host tree shapes (HostInstance, HostScope,
 *     CompilerContainer) — the contract concrete compilers
 *     (React, Angular, …) build against.
 *   - Layer B: the contributor protocol + collect walker + built-in
 *     contributors that turn a host tree into the spec's RenderedTree IR.
 *   - Bridges: reference `InMemoryDataBridge` + protocol mocks
 *     (`fakeBridges`, `fakeTimelineHarness`, etc.) for tests.
 *   - `LifecycleDispatch` — the compiler's half of the lifecycle
 *     projection (ADR 89 §4): per-mount handler dispatch + the
 *     tick-start/execution-start catch-up cache used by `useOnX` hooks
 *     in any compiler. The events come from the session's
 *     command-hook forwarders.
 *   - `defineCompiler` — callback-style `CompilerProtocol` factory.
 *
 * What does NOT live here:
 *   - React-specific binding (`react-reconciler`'s HostConfig, JSX
 *     runtime, hooks, components). Those live in
 *     `@agentick/compiler-react-next`.
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

export type { CompilerContainer } from "./host/container.js";
export { createContainer } from "./host/container.js";

// Layer B — Contributor protocol + collect walker
export type { CollectContext, Contributor } from "./collect/contributor.js";
export type { IRFragment } from "./collect/fragments.js";
export { NO_FRAGMENTS } from "./collect/fragments.js";
export { ContributorRegistry } from "./collect/registry.js";
export { collect } from "./collect/collect.js";
export type { CollectInput, CollectResult } from "./collect/collect.js";
// Surfacing projections (ADR 63)
export { builtInToolsProjection, builtInDefaultProjections } from "./collect/projection.js";
export type {
  DefaultProjection,
  ProjectionResult,
  ProjectionSources,
} from "./collect/projection.js";
export { createBuiltInRegistry } from "./collect/contributors/built-ins.js";
// Contributor conformance helper (contributors + producing packages derive
// from spec; this is the compile-time drift gate — see README §Contributor
// ownership).
export type {
  Exhausted,
  UnhandledSpecKeys,
  BaseBlockKey,
} from "./collect/contributors/spec-conformance.js";
export { sectionContributor } from "./collect/contributors/section.js";
export type { SectionProps } from "./collect/contributors/section.js";
export { messageContributor } from "./collect/contributors/message.js";
export type { MessageProps } from "./collect/contributors/message.js";
export { projectContributor } from "./collect/contributors/project.js";
export type { ProjectProps } from "./collect/contributors/project.js";
export { toolContributor } from "./collect/contributors/tool.js";
export type { ToolProps } from "./collect/contributors/tool.js";
export { providerToolContributor } from "./collect/contributors/provider-tool.js";
export type { ProviderToolProps } from "./collect/contributors/provider-tool.js";
export { resourceContributor } from "./collect/contributors/resource.js";
export type { ResourceProps } from "./collect/contributors/resource.js";
export { outputContributor } from "./collect/contributors/output.js";
export type { OutputProps } from "./collect/contributors/output.js";
export { mcpContributor } from "./collect/contributors/mcp.js";
export type { MCPProps } from "./collect/contributors/mcp.js";
export { modelContributor } from "./collect/contributors/model.js";
export type { ModelProps } from "./collect/contributors/model.js";
export { modelDeclarationContributor } from "./collect/contributors/model-declaration.js";
export type { ModelDeclarationProps } from "./collect/contributors/model-declaration.js";
export {
  imageContributor,
  documentContributor,
  audioContributor,
  videoContributor,
} from "./collect/contributors/media.js";
export type {
  ImageProps,
  DocumentProps,
  AudioProps,
  VideoProps,
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
export type {
  TextBlockProps,
  CodeProps,
  JsonProps,
  XmlBlockProps,
  CsvProps,
  HtmlProps,
  ReasoningProps,
} from "./collect/contributors/textual-blocks.js";
export {
  userActionContributor,
  systemEventContributor,
  stateChangeContributor,
} from "./collect/contributors/event-blocks.js";
export type {
  UserActionProps,
  SystemEventProps,
  StateChangeProps,
} from "./collect/contributors/event-blocks.js";
export { customBlockContributor } from "./collect/contributors/custom-block.js";
export type { CustomProps } from "./collect/contributors/custom-block.js";
export { contentPassthroughContributor } from "./collect/contributors/content-passthrough.js";
export type { ContentProps } from "./collect/contributors/content-passthrough.js";

// Bridges — reference (production) impl
export { InMemoryDataBridge } from "./bridges/in-memory-data-bridge.js";
export type { InMemoryDataBridgeOptions } from "./bridges/in-memory-data-bridge.js";
export { InMemoryModelBridge } from "./bridges/in-memory-model-bridge.js";

// Test doubles — re-exported from the package root for ergonomics.
// Adopters writing new tests should prefer the `@agentick/compiler-next/testing`
// subpath import directly per the test-doubles convention.
export {
  fakeBridges,
  stubLoopBridge,
  stubSessionBridge,
  fakeTimelineHarness,
  fakeKnobsHarness,
  mockStateHarness,
} from "./testing/fake-bridges.js";
export type { FakeBridgesOptions } from "./testing/fake-bridges.js";

// Lifecycle dispatch — the per-mount projection half used by useOnX hooks
export { LifecycleDispatch } from "./lifecycle-dispatch.js";
export type { LifecycleHandlerKind } from "./lifecycle-dispatch.js";

// Callback-style factory
export { defineCompiler, type DefineCompilerInput } from "./define-compiler.js";
