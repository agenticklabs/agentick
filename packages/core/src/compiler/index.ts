/**
 * Compiler - Tick-Based Agent Architecture
 *
 * A React-inspired fiber architecture designed specifically for AI agent execution.
 * Unlike React, this compiler is async-first and tick-based - no concurrent mode needed.
 *
 * Key Features:
 * - Hooks in function components (useState, useEffect, etc.)
 * - AI-specific hooks (useComState, useTickStart, useAfterCompile)
 * - Full class component support (signals, lifecycle methods)
 * - Pure content block rendering
 * - Async-first (effects can be async)
 * - Compile stabilization (recompile until stable)
 *
 * @example Function component with hooks
 * ```tsx
 * function ChatAgent({ maxTurns }: { maxTurns: number }) {
 *   const [turns, setTurns] = useState(0);
 *   const [timeline, setTimeline] = useComState('timeline', []);
 *
 *   useTickStart((com, state) => {
 *     if (state.current?.timeline) {
 *       setTimeline(t => [...t, ...state.current.timeline]);
 *       setTurns(t => t + 1);
 *     }
 *   });
 *
 *   useTickEnd((com, state) => {
 *     if (turns >= maxTurns) {
 *       state.stop('max turns reached');
 *     }
 *   });
 *
 *   useEffect(async () => {
 *     await logToServer({ turns, messageCount: timeline.length });
 *   }, [turns]);
 *
 *   return (
 *     <>
 *       <Section id="system">
 *         <Text>You are a helpful assistant.</Text>
 *       </Section>
 *       <Timeline>
 *         {timeline.map((msg, i) => (
 *           <Message key={i} role={msg.role}>{msg.content}</Message>
 *         ))}
 *       </Timeline>
 *     </>
 *   );
 * }
 * ```
 *
 * @example Class component (existing pattern)
 * ```tsx
 * class ChatAgent extends Component {
 *   timeline = comState<Message[]>('timeline', []);
 *   turns = signal(0);
 *
 *   async onTickStart(com, state) {
 *     if (state.current?.timeline) {
 *       this.timeline.update(t => [...t, ...state.current.timeline]);
 *       this.turns.update(t => t + 1);
 *     }
 *   }
 *
 *   render(com, state) {
 *     return (
 *       <Timeline>
 *         {this.timeline().map(...)}
 *       </Timeline>
 *     );
 *   }
 * }
 * ```
 *
 * @example Non-rendering component
 * ```tsx
 * function ExecutionController() {
 *   const [turns, setTurns] = useState(0);
 *
 *   useTickEnd((com, state) => {
 *     setTurns(t => t + 1);
 *     if (turns >= 10) state.stop('max turns');
 *   });
 *
 *   return null;  // No output - just manages execution
 * }
 * ```
 *
 * @example Pure content blocks
 * ```tsx
 * function ContentProvider() {
 *   const blocks = [
 *     { type: 'text', text: 'Block 1' },
 *     { type: 'text', text: 'Block 2' },
 *   ];
 *
 *   return (
 *     <Message role="assistant">
 *       <Text>Hello!</Text>
 *       {blocks}
 *     </Message>
 *   );
 * }
 * ```
 *
 * @module tentickle/compiler
 */

// ============================================================================
// Compiler
// ============================================================================

export {
  FiberCompiler,
  type SerializedFiberNode,
  type SerializedHookState,
  type HookType,
  type FiberSummary,
} from "./fiber-compiler";

// ============================================================================
// Reconciliation Scheduler
// ============================================================================

export {
  ReconciliationScheduler,
  type ReconcileEvent,
  type SchedulerConfig,
  type SchedulerState,
  type SchedulerStatus,
} from "./scheduler";

// ============================================================================
// Fiber Utilities
// ============================================================================

export {
  createFiber,
  createWorkInProgress,
  cloneFiber,
  getChildFibers,
  findFiberByKey,
  traverseFiber,
  traverseFiberBottomUp,
  getHookCount,
  getHookAtIndex,
  fiberToDebugString,
  fiberTreeToDebugString,
  findNearestRenderer,
  setFiberRenderer,
} from "./fiber";

// ============================================================================
// Types
// ============================================================================

export type {
  FiberNode,
  FiberCompilerConfig,
  FunctionComponent,
  ClassComponent,
  ComponentType,
  ComponentInstance,
  HookState,
  Effect,
  EffectCallback,
  EffectCleanup,
  UpdateQueue,
  Update,
  Dispatch,
  RenderContext,
  FiberChild,
  NormalizedChild,
  AsyncResult,
  CompileResult,
  ReconcileOptions,
  StateHookResult,
  ReducerHookResult,
  RefObject,
  ContentBlockType,
  CompileStabilizationOptions,
  CompileStabilizationResult,
  TickControl,
} from "./types";

export { StructureRenderer } from "./structure-renderer";

export { FiberFlags, HookTag, EffectPhase, CONTENT_BLOCK_TYPES, isFragment } from "./types";

export { isContentBlock } from "@tentickle/shared";

// ============================================================================
// State Hooks
// ============================================================================

export { useState, useReducer, useSignal } from "../state/hooks";

// ============================================================================
// COM State Hooks
// ============================================================================

export { useComState, useWatch, useInput } from "../state/hooks";

// ============================================================================
// Effect Hooks
// ============================================================================

export {
  useEffect,
  useInit,
  useOnMount,
  useOnUnmount,
  useTickStart,
  useTickEnd,
  useAfterCompile,
} from "../state/hooks";

// ============================================================================
// Async Hooks
// ============================================================================

export { useAsync } from "../state/hooks";

// ============================================================================
// Memoization Hooks
// ============================================================================

export { useMemo, useComputed, useCallback } from "../state/hooks";

// ============================================================================
// Ref Hooks
// ============================================================================

export { useRef, useCOMRef } from "../state/hooks";

// ============================================================================
// Utility Hooks
// ============================================================================

export { usePrevious, useToggle, useCounter, useAbortSignal, useDebugValue } from "../state/hooks";

// ============================================================================
// Context Access Hooks
// ============================================================================

export { useCom, useTickState } from "../state/hooks";

// ============================================================================
// Tick Control Hooks
// ============================================================================

export { useTick, type UseTickResult } from "../state/hooks";

// ============================================================================
// Channel Hooks
// ============================================================================

export { useChannel, useChannelSubscription, type UseChannelResult } from "../state/hooks";

// ============================================================================
// React-style Context API
// ============================================================================

export {
  createContext,
  useContext,
  type Context,
  type ContextProviderProps,
} from "../state/context";

// ============================================================================
// Boundary System (extends Context)
// ============================================================================

export {
  createBoundary,
  createFormatter,
  createPolicy,
  useBoundary,
  FormatterBoundary,
  type Boundary,
  type BoundaryDefinition,
  type BoundaryClass,
  type BoundaryProviderProps,
  type FormatterBoundaryValue,
} from "../state/boundary";

// ============================================================================
// Conversation History Hooks
// ============================================================================

export {
  useConversationHistory,
  useQueuedMessages,
  useInjectHistory,
  injectHistory,
  useMessages,
  useMessageCount,
  type ConversationHistoryOptions,
} from "../state/hooks";

// ============================================================================
// Internal (for advanced use)
// ============================================================================

export { setRenderContext, getCurrentFiber, getCurrentContext } from "../state/hooks";
