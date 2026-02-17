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
} from "./jsx/components/index";

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
export type { ToolClass, ToolDefinition, ToolMetadata, ToolPropOverrides } from "./tool/index";

// ============================================================================
// Model
// ============================================================================
export { createAdapter } from "./model/adapter";
export type { ModelClass } from "./model/adapter";
export type { EngineModel, ModelMetadata } from "./model/model";
export * from "./types";

// ============================================================================
// COM Types
// ============================================================================
export type { COMTimelineEntry, COMSection, COMInput, TokenEstimator } from "./com/types";

// ============================================================================
// Local Transport
// ============================================================================
export { createLocalTransport } from "./local-transport";

// ============================================================================
// DevTools
// ============================================================================
export {
  enableReactDevTools,
  isReactDevToolsConnected,
  disconnectReactDevTools,
} from "./reconciler/reconciler";
