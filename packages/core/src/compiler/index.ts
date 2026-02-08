/**
 * Compiler
 *
 * The fiber compiler using react-reconciler.
 *
 * @module agentick/compiler
 */

// ============================================================================
// Compiler
// ============================================================================

export {
  FiberCompiler,
  createFiberCompiler,
  type FiberCompilerConfig,
  type ReconcileOptions,
  type SerializedFiberNode,
  type SerializedHookState,
  type HookType,
  type FiberSummary,
} from "./fiber-compiler";

// ============================================================================
// Collector
// ============================================================================

export { collect } from "./collector";

// ============================================================================
// Structure Renderer
// ============================================================================

export { StructureRenderer } from "./structure-renderer";

// ============================================================================
// Scheduler
// ============================================================================

export {
  ReconciliationScheduler,
  type ReconcileEvent,
  type ReconciliationSchedulerOptions,
  type SchedulerState,
} from "./scheduler";

// ============================================================================
// Types
// ============================================================================

export type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledTool,
  CompiledEphemeral,
  CompileResult,
} from "./types";

export { createEmptyCompiledStructure } from "./types";

// ============================================================================
// Hooks (re-exported from hooks directory)
// ============================================================================

// Context hooks
export { useCom, useTickState, AgentickProvider } from "../hooks";

// Lifecycle hooks
export {
  useOnMount,
  useOnUnmount,
  useOnTickStart,
  useOnTickEnd,
  useAfterCompile,
  useContinuation,
} from "../hooks";

// Data hook
export { useData, useInvalidateData } from "../hooks";

// Signal hooks and utilities
export {
  useSignal,
  useComputed,
  createSignal,
  signal,
  computed,
  effect,
  batch,
  untracked,
  runWithSignalContext,
  runWithSignalContextAsync,
} from "../hooks";

// Standard React hooks are used directly from React
// import { useState, useEffect, useMemo, useCallback, useRef, useReducer } from 'react';
