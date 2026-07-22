// JSX.IntrinsicElements augmentation is auto-loaded by the tsconfig
// include glob (src/**) for in-workspace consumers. Downstream package
// consumers pick it up through the package's `types` entry which
// resolves to this file; the .d.ts is co-located under src/react/.
import "./react/jsx-intrinsics.js";

/**
 * @agentick/reconciler-react-next — React reconciler implementation.
 *
 * React-specific layer over `@agentick/reconciler-next` (which owns the
 * reconciler-agnostic IR collection, host shapes, bridges, and the
 * `defineReconciler` callback factory). This package binds those
 * generics to `react-reconciler` and ships the JSX components / hooks
 * adopters write agents with.
 *
 * The leading `/// <reference>` above pulls in the
 * `JSX.IntrinsicElements` augmentation so adopters and tests can write
 * lowercase host intrinsics (`<message>`, `<tool>`, `<section>`, ...)
 * with proper type checking. See `src/react/jsx-intrinsics.d.ts` for
 * the full surface and HTML-overlap policy.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

// React-specific host config layer (binds @agentick/reconciler-next's
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
// and lifecycle dispatch from `@agentick/reconciler-next`.
export { BridgeContext, BridgeProvider, useBridges } from "./react/bridge-context.js";
export type { BridgeProviderProps } from "./react/bridge-context.js";
export {
  LifecycleContext,
  LifecycleProvider,
  useLifecycleDispatch,
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
  useOnToolStart,
  useOnToolEnd,
  useOnModelGenerateStart,
  useOnModelGenerateEnd,
  useContextInfo,
  useRenderContext,
  useActiveModel,
  useOnError,
  useOnMount,
  useOnUnmount,
  useOnLifecycleCustom,
  useToolBridge,
  useModelBridge,
  useModelRegistration,
} from "./react/hooks/index.js";
export type { ContextInfo } from "./react/hooks/index.js";

// React-flavored createTool (extends @agentick/tool-next with use() hook)
export { createTool } from "./react/create-tool.js";
export type { ReactToolSpec, CreatedReactTool } from "./react/create-tool.js";

// Components. Per ADR 27, <Knobs> / <Timeline> / <Gates> moved to their
// respective /react subpaths in `@agentick/knobs-next/react`,
// `@agentick/timeline-next/react`, `@agentick/gates-next`. Hooks `useKnob`,
// `useTimeline`, `useSessionState` moved similarly.
export { FormatScope, Markdown, XML, PlainText } from "./react/components/index.js";
export type { FormatScopeProps, NamedFormatScopeProps } from "./react/components/index.js";
export { Message } from "./react/components/index.js";
export type { MessageProps } from "./react/components/index.js";
export { Section } from "./react/components/index.js";
export type { SectionProps } from "./react/components/index.js";
export { Project } from "./react/components/index.js";
export type { ProjectProps } from "./react/components/index.js";
export { System, User, Assistant, Paragraph, H1, H2, H3 } from "./react/components/index.js";

// Layer C — Harness
export { ReconcilerHarness } from "./harness/reconciler-harness.js";
export type { ReconcilerHarnessOptions } from "./harness/reconciler-harness.js";

// ReconcilerFactory factory — the canonical way to wire React's
// reconciler into createApp. Also defaulted by @agentick/app-next/react.
export { reactReconciler } from "./factory.js";

// One-shot template entry points for static-template use cases
// (prompts, resources, MCP server prompts, snapshot tests, docs
// generators). Strip down the full harness — no session, no journal,
// no operation wrap. See template.ts for the contract.
//
// - `compileTemplate(element, opts)` → `RenderedTree` IR + diagnostics
// - `renderTemplate(element, opts)`  → formatted string + diagnostics
//
// Naming mirrors the mental model: COMPILE produces IR; RENDER
// produces the final output (string). `renderTemplate` uses
// `compileTemplate` internally + a formatter pass.
export { compileTemplate, renderTemplate } from "./template.js";
export type {
  CompileTemplateOptions,
  CompileTemplateResult,
  RenderTemplateOptions,
  RenderTemplateResult,
} from "./template.js";
