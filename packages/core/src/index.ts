/**
 * @tentickle/core - Core engine for Tentickle
 *
 * Main entry point with all essential exports
 */

// ============================================================================
// Kernel primitives
// ============================================================================
export * from "@tentickle/kernel";

// ============================================================================
// App & Session
// ============================================================================
export * from "./app/types.js";
export {
  createApp,
  createAgent,
  Tentickle,
  TentickleInstance,
  run,
  runComponent,
  SessionImpl,
} from "./app.js";
export type { AgentConfig } from "./agent";

// ============================================================================
// JSX Components (re-export from jsx/components)
// ============================================================================
export {
  Agent,
  type AgentProps,
  Model,
  Section,
  Timeline,
  Message,
  User,
  Assistant,
  System,
  ToolResult as ToolResultComponent,
  Markdown,
  XML,
} from "./jsx/components/index";

// ============================================================================
// React Hooks (re-exported from React)
// ============================================================================
export { useState, useEffect, useReducer, useMemo, useCallback, useRef } from "react";

// ============================================================================
// Tentickle Hooks
// ============================================================================
export {
  useSignal,
  useComputed,
  useCom,
  useTickState,
  // Lifecycle hooks
  useOnMount,
  useOnUnmount,
  useOnTickStart,
  useOnTickEnd,
  useAfterCompile,
  useContinuation,
  // Data hooks
  useData,
  useInvalidateData,
  useComState,
  // Knobs
  knob,
  isKnob,
  useKnob,
  Knobs,
  useKnobsContext,
  useKnobsContextOptional,
  type KnobDescriptor,
  type KnobOpts,
  type KnobPrimitive,
  type KnobConstraints,
  type KnobRegistration,
  type KnobsContextValue,
  type KnobInfo,
  type KnobGroup,
  type KnobsRenderFn,
  // Context utilization
  useContextInfo,
  useContextInfoStore,
  createContextInfoStore,
  ContextInfoProvider,
  type ContextInfo,
  type ContextInfoStore,
} from "./hooks";

// ============================================================================
// Tools
// ============================================================================
export { createTool } from "./tool/index";
export type { ToolDefinition, ToolMetadata } from "./tool/index";

// ============================================================================
// Model
// ============================================================================
export { createAdapter } from "./model/adapter";
export type { ModelClass } from "./model/adapter";
export * from "./types";

// ============================================================================
// DevTools
// ============================================================================
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disconnectReactDevTools,
} from "./reconciler/reconciler";
