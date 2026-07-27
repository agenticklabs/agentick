// JSX.IntrinsicElements augmentation is auto-loaded by the tsconfig
// include glob (src/**) for in-workspace consumers. Downstream package
// consumers pick it up through the package's `types` entry which
// resolves to this file; the .d.ts is co-located under src/react/.
import "./react/jsx-intrinsics.js";

/**
 * @agentick/compiler-react — React compiler implementation.
 *
 * React-specific layer over `@agentick/compiler` (which owns the
 * compiler-agnostic IR collection, host shapes, bridges, and the
 * `defineCompiler` callback factory). This package binds those
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

// React-specific host config layer (binds @agentick/compiler's
// generic host shapes to react-reconciler's HostConfig contract).
export type { HostConfigDeps } from "./host/host-config.js";
export { createHostConfig } from "./host/host-config.js";

// React compiler integration
export { createCompiler } from "./react/compiler.js";
export type { FiberRoot } from "./react/compiler.js";

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
// and lifecycle dispatch from `@agentick/compiler`.
export { BridgeContext, BridgeProvider, useBridges } from "./react/bridge-context.js";
export type { BridgeProviderProps } from "./react/bridge-context.js";
export {
  LifecycleContext,
  LifecycleProvider,
  useLifecycleDispatch,
} from "./react/lifecycle-context.js";
export type { LifecycleProviderProps } from "./react/lifecycle-context.js";
// Interceptor context — the PULL half of the ADR 89 §4 projection (the
// per-mount registry the tree-side guard/transform hooks land in).
export {
  InterceptorContext,
  InterceptorProvider,
  useCommandInterceptorRegistry,
} from "./react/interceptor-context.js";
export type { InterceptorProviderProps } from "./react/interceptor-context.js";

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
  // Tree-side IN-PATH interceptors (ADR 89 §4)
  useCommandInterceptor,
  useGuardToolDispatch,
  useTransformToolDispatch,
  useTransformModelInput,
} from "./react/hooks/index.js";
export type { ContextInfo } from "./react/hooks/index.js";
export type {
  GuardDecision,
  GuardFn,
  InterceptorInput,
  InterceptorOutput,
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
export { Project } from "./react/components/index.js";
export type { ProjectProps } from "./react/components/index.js";
export { ProviderTool } from "./react/components/index.js";
export type { ProviderToolProps } from "./react/components/index.js";
export { Output } from "./react/components/index.js";
export type { OutputProps } from "./react/components/index.js";
export { System, User, Assistant, Paragraph, H1, H2, H3 } from "./react/components/index.js";
// HTML/SVG-colliding content blocks — the wrappers jsx-intrinsics.ts points at.
export { Text, Code, Image, Audio, Video } from "./react/components/index.js";
export { ToolGate } from "./react/components/index.js";
export type { ToolGateProps } from "./react/components/index.js";

// Layer C — Harness
export { CompilerHarness } from "./harness/compiler-harness.js";
export type { CompilerHarnessOptions } from "./harness/compiler-harness.js";

// CompilerFactory factory — the canonical way to wire React's
// compiler into createApp. Also defaulted by @agentick/app/react.
export { reactCompiler } from "./factory.js";

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
