/**
 * Hooks
 *
 * Custom hooks for Agentick components.
 */

// Re-export React hooks for convenience
export { useState, useEffect, useRef, useCallback, useMemo, useContext } from "react";

// Context hooks
export { useCom, useTickState, COMProvider, TickStateProvider, AgentickProvider } from "./context";

// COM state hook
export { useComState } from "./com-state";

// Runtime context (per-session state)
export {
  createRuntimeStore,
  useRuntimeStore,
  RuntimeProvider,
  storeHasPendingData,
  storeResolvePendingData,
  storeRunTickStartCallbacks,
  storeRunTickEndCallbacks,
  storeRunAfterCompileCallbacks,
  storeClearLifecycleCallbacks,
  storeClearDataCache,
  storeGetSerializableDataCache,
  storeSetDataCache,
  storeInvalidateData,
  type RuntimeStore,
  type CacheEntry,
  type SerializableCacheEntry,
  type KnobRegistration,
} from "./runtime-context";

// Knobs
export {
  knob,
  isKnob,
  useKnob,
  type KnobDescriptor,
  type KnobOpts,
  type KnobPrimitive,
  type KnobConstraints,
} from "./knob";
export {
  Knobs,
  useKnobsContext,
  useKnobsContextOptional,
  type KnobsContextValue,
  type KnobInfo,
  type KnobGroup,
  type KnobsRenderFn,
} from "./knobs-component";

// Lifecycle hooks
export {
  useOnMount,
  useOnUnmount,
  useOnTickStart,
  useOnTickEnd,
  useAfterCompile,
  useContinuation,
} from "./lifecycle";

// Data hook
export { useData, useInvalidateData } from "./data";

// Signal hooks and utilities
export {
  // React hooks
  useSignal,
  useComputed,
  // Standalone signal functions
  signal,
  computed,
  effect,
  createSignal,
  // Batching and utilities
  batch,
  untracked,
  // Type guards
  isSignal,
  isComputed,
  isEffect,
  // COM state integration
  createCOMStateSignal,
  createReadonlyCOMStateSignal,
  // Context utilities
  runWithSignalContext,
  runWithSignalContextAsync,
  // Symbols (for advanced use)
  SIGNAL_SYMBOL,
  COMPUTED_SYMBOL,
  EFFECT_SYMBOL,
  COM_SIGNAL_SYMBOL,
  WATCH_SIGNAL_SYMBOL,
  PROPS_SIGNAL_SYMBOL,
  REQUIRED_INPUT_SYMBOL,
  // Types
  type Signal,
  type ComputedSignal,
  type ReadonlySignal,
  type EffectRef,
  type SignalOptions,
} from "./signal";

// Formatter context
export { FormatterBoundary, useFormatter, type FormatterContextValue } from "./formatter-context";

// Message context
export {
  createMessageStore,
  MessageProvider,
  useMessageContext,
  useOnMessage,
  useQueuedMessages,
  useLastMessage,
  type MessageStore,
  type MessageHandler,
  type MessageContextValue,
} from "./message-context";

// Timeline hooks (re-exported from jsx/components/timeline for convenience)
export {
  useTimelineContext,
  useTimelineContextOptional,
  useConversationHistory,
} from "../jsx/components/timeline";

// Context info hook (real-time context utilization)
export {
  useContextInfo,
  useContextInfoStore,
  createContextInfoStore,
  ContextInfoProvider,
  type ContextInfo,
  type ContextInfoStore,
} from "./context-info";

// Types
export * from "./types";
