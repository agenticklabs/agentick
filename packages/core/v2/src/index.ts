/**
 * Tentickle V2
 *
 * React-reconciler based implementation.
 *
 * This is a drop-in replacement for v1. The main change is the FiberCompiler
 * which now uses react-reconciler internally instead of a custom implementation.
 *
 * Key differences from V1:
 * - Uses react-reconciler for tree management and standard React hooks
 * - Async data via useData() hook (resolve-then-render pattern)
 * - Components are sync (standard React)
 * - Same API surface - Session doesn't need to change
 */

// Core Compiler (drop-in replacement for v1)
export { FiberCompiler, createFiberCompiler } from "./compiler/fiber-compiler";
export { collect } from "./compiler/collector";
export type {
  CompiledStructure,
  CompiledSection,
  CompiledTool,
  CompileResult,
} from "./compiler/types";

// Hooks (for components)
export {
  // Context
  useCom,
  useTickState,
  TentickleProvider,
  COMProvider,
  TickStateProvider,
  // Runtime (per-session state)
  createRuntimeStore,
  useRuntimeStore,
  type RuntimeStore,
  type SerializableCacheEntry,
  // Lifecycle
  useTickStart,
  useTickEnd,
  useAfterCompile,
  // Data
  useData,
  useInvalidateData,
  // Signals
  useSignal,
  useComputed,
  createSignal,
} from "./hooks";

// Components (same as v1)
export {
  // Structural
  Section,
  Entry,
  Message,
  Tool,
  Ephemeral,
  // Content
  Text,
  Code,
  Image,
  Json,
  Document,
  Audio,
  Video,
  // Renderers
  Markdown,
  XML,
  createRendererComponent,
} from "./components";

// Renderers
export { markdownRenderer, xmlRenderer, MarkdownRenderer, XMLRenderer } from "./renderers";
export type { Renderer, SemanticContentBlock } from "./renderers/types";

// Reconciler (advanced usage)
export { createContainer, createRoot, registerRendererComponent } from "./reconciler";

// Hibernation (session persistence)
export {
  hibernate,
  hydrate,
  isValidSnapshot,
  getSnapshotAge,
  cloneSnapshot,
  type SessionSnapshot,
  type SerializableTimelineEntry,
  type HibernateOptions,
  type HydrateResult,
} from "./hibernation";
