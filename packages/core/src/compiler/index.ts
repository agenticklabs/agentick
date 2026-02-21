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
} from "./fiber-compiler.js";

// ============================================================================
// Collector
// ============================================================================

export { collect } from "./collector.js";

// ============================================================================
// Structure Renderer
// ============================================================================

export { StructureRenderer } from "./structure-renderer.js";

// ============================================================================
// Scheduler
// ============================================================================

export {
  ReconciliationScheduler,
  type ReconcileEvent,
  type ReconciliationSchedulerOptions,
  type SchedulerState,
} from "./scheduler.js";

// ============================================================================
// Types
// ============================================================================

export type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledEphemeral,
  CompileResult,
} from "./types.js";

export { createEmptyCompiledStructure } from "./types.js";

// ============================================================================
// Hooks (re-exported from hooks directory)
// ============================================================================

// Context hooks
export { useCom, useTickState, AgentickProvider } from "../hooks/index.js";

// Lifecycle hooks
export {
  useOnMount,
  useOnUnmount,
  useOnTickStart,
  useOnTickEnd,
  useAfterCompile,
  useContinuation,
} from "../hooks/index.js";

// Data hook
export { useData, useInvalidateData } from "../hooks/index.js";

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
} from "../hooks/index.js";

// Standard React hooks are used directly from React
// import { useState, useEffect, useMemo, useCallback, useRef, useReducer } from 'react';
