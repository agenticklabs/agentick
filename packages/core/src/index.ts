/**
 * @agentick/core - Core engine for Agentick
 *
 * Main entry point with all essential exports
 */

// ============================================================================
// Kernel primitives
// ============================================================================
export * from "@agentick/kernel";

// ============================================================================
// App & Session
// ============================================================================
export * from "./app/types.js";
export { createApp, Agentick, AgentickInstance, run, runComponent, SessionImpl } from "./app.js";

// ============================================================================
// JSX Components (re-export from jsx/components)
// ============================================================================
export {
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
  Ephemeral,
  type EphemeralProps,
  type EphemeralPosition,
  Grounding,
  type GroundingProps,
  Collapsed,
  type CollapsedProps,
  // Auto-summary for collapsed components
  autoMessageSummary,
  autoSectionSummary,
  autoContentSummary,
  // Token budget (types + pure functions, used via Timeline props)
  compactEntries,
  type CompactionStrategy,
  type CompactionFunction,
  type CompactionResult,
  type CompactOptions,
  type CompactResult,
  type TokenBudgetInfo,
  // Timeline types
  type TimelineContextValue,
  type TimelineRenderFn,
  type TimelineProps,
  type TimelineBudgetOptions,
} from "./jsx/components/index.js";

// ============================================================================
// React Hooks (re-exported from React)
// ============================================================================
export { useState, useEffect, useReducer, useMemo, useCallback, useRef } from "react";

// ============================================================================
// Agentick Hooks
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
  useOnExecutionEnd,
  useOnExecutionStart,
  useContinuation,
  // Data hooks
  useData,
  useInvalidateData,
  type UseDataOptions,
  useComState,
  type UseComStateOptions,
  type HookPersistenceOptions,
  // Timeline
  useTimeline,
  // Resolve
  useResolved,
  // Expandable content
  Expandable,
  type ExpandableProps,
  // Gates
  gate,
  useGate,
  type GateDescriptor,
  type GateState,
  type GateValue,
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
} from "./hooks/index.js";

// ============================================================================
// Tools
// ============================================================================
export { createTool, useToolProcedure } from "./tool/index.js";
export type { ToolClass, ToolDefinition, ToolMetadata, ToolPropOverrides } from "./tool/index.js";

// ============================================================================
// Model
// ============================================================================
export { createAdapter } from "./model/adapter.js";
export type { ModelClass } from "./model/adapter.js";
export type { EngineModel, ModelMetadata } from "./model/model.js";
export * from "./types.js";

// ============================================================================
// COM Types
// ============================================================================
export type { COMTimelineEntry, COMSection, COMInput, TokenEstimator } from "./com/types.js";

// ============================================================================
// Local Transport
// ============================================================================
export { createLocalTransport } from "./local-transport.js";

// ============================================================================
// DevTools
// ============================================================================
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disconnectReactDevTools,
} from "./reconciler/reconciler.js";
