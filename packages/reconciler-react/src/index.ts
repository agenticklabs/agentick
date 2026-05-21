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

// React DevTools bridge
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disableReactDevTools,
} from "./react/devtools-bridge.js";
export type {
  EnableReactDevToolsOptions,
  EnableReactDevToolsOutcome,
} from "./react/devtools-bridge.js";

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

// Bridges
export { InMemoryDataBridge } from "./bridges/in-memory-data-bridge.js";
export type { InMemoryDataBridgeOptions } from "./bridges/in-memory-data-bridge.js";
export {
  stubBridges,
  stubTimelineBridge,
  inMemoryKnobBridge,
  inMemoryStateBridge,
  stubLoopBridge,
  stubSessionBridge,
} from "./bridges/stub-bridges.js";
export type { StubBridgesOptions } from "./bridges/stub-bridges.js";

// Bridge context + hooks
export { BridgeContext, BridgeProvider, useBridges } from "./react/bridge-context.js";
export type { BridgeProviderProps } from "./react/bridge-context.js";
export {
  LifecycleContext,
  LifecycleProvider,
  useLifecycleStore,
} from "./react/lifecycle-context.js";
export type { LifecycleProviderProps } from "./react/lifecycle-context.js";
export {
  useData,
  useKnob,
  useTimeline,
  useLoopControl,
  useSession,
  useOnTickStart,
  useOnTickEnd,
  useOnExecutionStart,
  useOnExecutionEnd,
  useOnError,
  useOnMount,
  useOnUnmount,
  useOnLifecycleCustom,
  useToolBridge,
  useSessionState,
} from "./react/hooks/index.js";

// React-flavored createTool (extends @agentick/tool with use() hook)
export { createTool } from "./react/create-tool.js";
export type { ReactToolSpec, CreatedReactTool } from "./react/create-tool.js";

// Components
export { FormatScope, Markdown, XML, PlainText } from "./react/components/index.js";
export type { FormatScopeProps, NamedFormatScopeProps } from "./react/components/index.js";
export { Message } from "./react/components/index.js";
export type { MessageProps } from "./react/components/index.js";
export { Timeline } from "./react/components/index.js";
export type {
  TimelineProps,
  TimelineRenderFn,
  ConversationHistoryOptions,
  TimelineBudgetOptions,
} from "./react/components/index.js";
export { compactEntries, getEntryTokens } from "./react/components/index.js";
export type {
  CompactionStrategy,
  CompactionFunction,
  CompactionResult,
  CompactOptions,
  CompactResult,
  TokenBudgetInfo,
} from "./react/components/index.js";

// Passthrough contributor (exported so custom registries can opt-in)
export { contentPassthroughContributor } from "./collect/contributors/content-passthrough.js";

// Stub bridges — re-export the in-memory timeline variant for tests
export type { InMemoryTimelineBridge } from "./bridges/stub-bridges.js";

// Layer C — Harness
export { ReconcilerHarness } from "./harness/reconciler-harness.js";
export type { ReconcilerHarnessOptions } from "./harness/reconciler-harness.js";
export { LifecycleStore } from "./harness/lifecycle-store.js";
export type { LifecycleHandlerKind } from "./harness/lifecycle-store.js";
