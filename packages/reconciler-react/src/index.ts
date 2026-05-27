/**
 * @agentick/reconciler-react — React reconciler implementation.
 *
 * React-specific layer over `@agentick/reconciler` (which owns the
 * reconciler-agnostic IR collection, host shapes, bridges, and the
 * `defineReconciler` callback factory). This package binds those
 * generics to `react-reconciler` and ships the JSX components / hooks
 * adopters write agents with.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

// React-specific host config layer (binds @agentick/reconciler's
// generic host shapes to react-reconciler's HostConfig contract).
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

// Bridge + lifecycle context — React Context wrappers over the bridges
// and lifecycle store from `@agentick/reconciler`.
export { BridgeContext, BridgeProvider, useBridges } from "./react/bridge-context.js";
export type { BridgeProviderProps } from "./react/bridge-context.js";
export {
  LifecycleContext,
  LifecycleProvider,
  useLifecycleStore,
} from "./react/lifecycle-context.js";
export type { LifecycleProviderProps } from "./react/lifecycle-context.js";

// React hooks
export {
  useData,
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
} from "./react/hooks/index.js";

// React-flavored createTool (extends @agentick/tool with use() hook)
export { createTool } from "./react/create-tool.js";
export type { ReactToolSpec, CreatedReactTool } from "./react/create-tool.js";

// Components. Per ADR 27, <Knobs> / <Timeline> / <Gates> moved to their
// respective /react subpaths in `@agentick/knobs/react`,
// `@agentick/timeline/react`, `@agentick/gates`. Hooks `useKnob`,
// `useTimeline`, `useSessionState` moved similarly.
export { FormatScope, Markdown, XML, PlainText } from "./react/components/index.js";
export type { FormatScopeProps, NamedFormatScopeProps } from "./react/components/index.js";
export { Message } from "./react/components/index.js";
export type { MessageProps } from "./react/components/index.js";
export { Section } from "./react/components/index.js";
export type { SectionProps } from "./react/components/index.js";
export {
  System,
  User,
  Assistant,
  Paragraph,
  H1,
  H2,
  H3,
} from "./react/components/index.js";

// Layer C — Harness
export { ReconcilerHarness } from "./harness/reconciler-harness.js";
export type { ReconcilerHarnessOptions } from "./harness/reconciler-harness.js";
