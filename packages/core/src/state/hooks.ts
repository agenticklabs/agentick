/**
 * V2 Hooks Implementation
 *
 * React-inspired hooks for function components in the tick-based agent model.
 * Key difference from React: async-first, effects can be async.
 *
 * Rules of Hooks:
 * 1. Only call hooks at the top level of a function component
 * 2. Only call hooks from function components or custom hooks
 * 3. Call hooks in the same order every render
 */

import type {
  FiberNode,
  HookState,
  UpdateQueue,
  Update,
  RenderContext,
  StateHookResult,
  ReducerHookResult,
  RefObject,
  AsyncResult,
  EffectCallback,
  Dispatch,
} from "../compiler/types";
import { HookTag, EffectPhase } from "../compiler/types";
import {
  signal as createSignal,
  computed,
  createCOMStateSignal,
  createReadonlyCOMStateSignal,
  type Signal,
  type ComputedSignal,
  type ReadonlySignal,
  isSignal,
  isComputed,
} from "./signal";
import { shouldSkipRecompile } from "../compiler/fiber-compiler";
import type { COM } from "../com/object-model";
import type { COMTimelineEntry, COMInput } from "../com/types";
import type { TickState } from "../component/component";
import type { CompiledStructure } from "../compiler/types";
import type { ExecutionMessage } from "../engine/execution-types";

// ============================================================================
// Render Context (Global During Render)
// ============================================================================

let renderContext: RenderContext | null = null;

/**
 * Get current render context. Throws if called outside render.
 */
export function getCurrentContext(): RenderContext {
  if (renderContext === null) {
    throw new Error(
      "Invalid hook call. Hooks can only be called inside a function component.\n" +
        "Possible causes:\n" +
        "1. Calling a hook outside a component\n" +
        "2. Calling hooks conditionally or in a loop\n" +
        "3. Mismatched tentickle package versions",
    );
  }
  return renderContext;
}

/**
 * Set render context (called by compiler).
 */
export function setRenderContext(ctx: RenderContext | null): void {
  renderContext = ctx;
}

/**
 * Get current fiber (for advanced use).
 */
export function getCurrentFiber(): FiberNode | null {
  return renderContext?.fiber ?? null;
}

// ============================================================================
// Context Access Hooks
// ============================================================================

/**
 * Get the COM (Context Object Model) for the current render.
 *
 * Use this instead of receiving COM as a component parameter.
 * This makes components have standard React-like signatures: `(props) => JSX.Element`
 *
 * @example
 * ```tsx
 * // Before (legacy pattern with magic args):
 * const MyComponent = (props, com, state) => { ... };
 *
 * // After (recommended hook pattern):
 * const MyComponent = (props) => {
 *   const com = useCom();
 *   const state = useTickState();
 *   // ...
 * };
 * ```
 */
export function useCom(): COM {
  return getCurrentContext().com;
}

/**
 * Get the TickState for the current render.
 *
 * TickState contains:
 * - `tick`: Current tick number (1-indexed)
 * - `previous`: COMInput from previous tick (conversation history)
 * - `current`: COMOutput from current tick (model response)
 * - `stop(reason)`: Function to stop execution
 * - `queuedMessages`: Messages received during execution
 *
 * @example
 * ```tsx
 * const MyComponent = (props) => {
 *   const state = useTickState();
 *   console.log(`Tick ${state.tick}`);
 *   // Access previous conversation via state.previous?.timeline
 * };
 * ```
 */
export function useTickState(): TickState {
  return getCurrentContext().tickState;
}

// ============================================================================
// Work Scheduling
// ============================================================================

/**
 * Schedule work for a fiber using the scheduler from the current render context.
 * This ensures concurrent compilations don't interfere with each other.
 */
// function scheduleWork(fiber: FiberNode): void {
//   // During render, we have renderContext available with the correct scheduler
//   const ctx = renderContext;
//   if (ctx?.scheduleWork) {
//     ctx.scheduleWork(fiber);
//   }
// }

// ============================================================================
// Hook State Management
// ============================================================================

/**
 * Mount a new hook during initial render.
 * If hydrating, attempts to restore state from hydration data.
 */
function mountWorkInProgressHook(): HookState {
  const ctx = getCurrentContext();

  // Track hook index for hydration
  const hookIndex = ctx.hookIndex ?? 0;
  ctx.hookIndex = hookIndex + 1;

  const hook: HookState = {
    memoizedState: undefined as unknown,
    queue: null,
    effect: null,
    next: null,
    tag: HookTag.State,
  };

  // Check for hydration data
  if (ctx.isHydrating && ctx.hydrationData?.hooks) {
    const hydrationHook = ctx.hydrationData.hooks[hookIndex];
    if (hydrationHook) {
      // Restore memoized state from hydration
      hook.memoizedState = hydrationHook.value;
    }
  }

  if (ctx.workInProgressHook === null) {
    ctx.fiber.memoizedState = hook;
  } else {
    ctx.workInProgressHook.next = hook;
  }
  ctx.workInProgressHook = hook;

  return hook;
}

/**
 * Check if a hook should skip initialization because it's being hydrated.
 * Returns the hydrated value if available.
 */
function getHydratedValue<T>(hookIndex: number): T | undefined {
  const ctx = getCurrentContext();
  if (ctx.isHydrating && ctx.hydrationData?.hooks) {
    const hydrationHook = ctx.hydrationData.hooks[hookIndex];
    if (hydrationHook) {
      return hydrationHook.value as T;
    }
  }
  return undefined;
}

function updateWorkInProgressHook(): HookState {
  const ctx = getCurrentContext();
  const current = ctx.currentHook;

  if (current === null) {
    throw new Error(
      "Rendered more hooks than during the previous render. " +
        "Hooks must be called in the same order every render.",
    );
  }

  const newHook: HookState = {
    memoizedState: current.memoizedState,
    baseState: current.baseState,
    queue: current.queue,
    effect: current.effect,
    next: null,
    tag: current.tag,
  };

  if (ctx.workInProgressHook === null) {
    ctx.fiber.memoizedState = newHook;
  } else {
    ctx.workInProgressHook.next = newHook;
  }
  ctx.workInProgressHook = newHook;
  ctx.currentHook = current.next;

  return newHook;
}

function mountOrUpdateHook(tag: HookTag): HookState {
  const ctx = getCurrentContext();
  const isMount = ctx.currentHook === null && ctx.fiber.alternate === null;
  const hook = isMount ? mountWorkInProgressHook() : updateWorkInProgressHook();
  hook.tag = tag;
  return hook;
}

/**
 * Extract signal values for dependency comparison.
 * Signals/computed values are unwrapped to their current value.
 */
function unwrapDeps(deps: unknown[] | undefined | null): unknown[] | undefined | null {
  if (!deps) return deps;

  return deps.map((dep) => {
    // If it's a signal or computed, read its current value
    if (isSignal(dep) || isComputed(dep)) {
      return (dep as any)();
    }
    return dep;
  });
}

// ============================================================================
// STATE HOOKS
// ============================================================================

/**
 * useState - Local component state.
 *
 * @deprecated Use `useSignal` instead for better composability and consistency.
 *
 * State persists across renders via fiber storage.
 *
 * @example
 * ```tsx
 * // Old (deprecated):
 * const [count, setCount] = useState(0);
 *
 * // New (recommended):
 * const count = useSignal(0);
 * count.set(10) or count.update(n => n + 1)
 * ```
 */
export function useState<S>(initialState: S | (() => S)): StateHookResult<S> {
  return useReducer(
    (state: S, action: S | ((prev: S) => S)) =>
      typeof action === "function" ? (action as (prev: S) => S)(state) : action,
    initialState as S,
    typeof initialState === "function" ? (initialState as () => S) : undefined,
  );
}

/**
 * useReducer - State with reducer pattern.
 */
export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): ReducerHookResult<S, A> {
  const hook = mountOrUpdateHook(HookTag.Reducer);
  const ctx = getCurrentContext();
  const fiber = ctx.fiber;
  // Capture scheduler at creation time to ensure concurrent compilations don't interfere
  const scheduler = ctx.scheduleWork;

  if (hook.queue === null) {
    // Mount: initialize
    // During hydration, memoizedState was already set from snapshot in mountWorkInProgressHook
    // Only initialize if we don't have a hydrated value
    const hasHydratedValue = ctx.isHydrating && hook.memoizedState !== undefined;
    const initialState = hasHydratedValue
      ? (hook.memoizedState as S)
      : init
        ? init(initialArg)
        : initialArg;

    hook.memoizedState = initialState;
    hook.baseState = initialState;

    const queue: UpdateQueue<A> = {
      pending: [], // Array instead of circular linked list - safer for concurrent dispatch
      dispatch: null,
      lastRenderedState: initialState as unknown as A,
    };
    hook.queue = queue as unknown as UpdateQueue;

    const dispatch = (action: A) => {
      dispatchAction(fiber, hook, queue as unknown as UpdateQueue<A>, reducer, action, scheduler);
    };
    queue.dispatch = dispatch as unknown as Dispatch<A>;
  } else {
    // Update: process pending updates
    const queue = hook.queue as unknown as UpdateQueue<A>;
    let newState = hook.baseState as S;

    // Process all pending updates from the array
    if (queue.pending.length > 0) {
      for (const update of queue.pending) {
        newState = reducer(newState, update.action as A);
      }
      // Clear the queue after processing
      queue.pending = [];
    }

    hook.memoizedState = newState;
    queue.lastRenderedState = newState as unknown as A;
  }

  return [hook.memoizedState as S, hook.queue!.dispatch as unknown as (action: A) => void];
}

function dispatchAction<S, A>(
  fiber: FiberNode,
  hook: HookState,
  queue: UpdateQueue<A>,
  reducer: (state: S, action: A) => S,
  action: A,
  scheduler?: (fiber: FiberNode) => void,
): void {
  const update: Update<A> = { action };

  // Array.push is atomic in JavaScript's single-threaded model,
  // avoiding race conditions that could occur with circular linked list manipulation
  // when multiple async operations dispatch concurrently.
  queue.pending.push(update);

  // Eagerly compute for bailout
  const current = hook.memoizedState as S;
  const newState = reducer(current, action);

  if (Object.is(current, newState)) {
    return; // Bailout
  }

  // Use the captured scheduler, not the global one
  if (scheduler) {
    scheduler(fiber);
  }
}

/**
 * useSignal - Signal-based state in function components.
 *
 * Provides full signal API (not just [value, setter]).
 * Automatically triggers recompiles when the signal is updated (like useState).
 *
 * @example
 * ```tsx
 * function Counter() {
 *   const count = useSignal(0);
 *   return <Text>Count: {count()}</Text>;
 * }
 * ```
 */
export function useSignal<T>(initialValue: T): Signal<T> {
  const hook = mountOrUpdateHook(HookTag.Signal);
  const ctx = getCurrentContext();
  const fiber = ctx.fiber;
  // Capture scheduler at creation time to ensure concurrent compilations don't interfere
  const scheduler = ctx.scheduleWork;

  if (hook.memoizedState === undefined) {
    const baseSignal = createSignal(initialValue);

    // Wrap set and update to trigger recompiles (like useState)
    // This makes useSignal behave consistently with useState for triggering renders
    const originalSet = baseSignal.set;
    const originalUpdate = baseSignal.update;

    const wrappedSet = (value: T | ((prev: T) => T)): void => {
      originalSet(value);
      // Trigger recompile if we have a fiber and we're not in a phase that should skip
      // Use the captured scheduler, not the global one
      if (fiber && !shouldSkipRecompile() && scheduler) {
        scheduler(fiber);
      }
    };

    const wrappedUpdate = (updater: (value: T) => T): void => {
      originalUpdate(updater);
      // Trigger recompile if we have a fiber and we're not in a phase that should skip
      // Use the captured scheduler, not the global one
      if (fiber && !shouldSkipRecompile() && scheduler) {
        scheduler(fiber);
      }
    };

    // Create wrapped signal with original signal's functionality
    const wrappedSignal = baseSignal as Signal<T>;
    wrappedSignal.set = wrappedSet;
    wrappedSignal.update = wrappedUpdate;

    hook.memoizedState = wrappedSignal;
  }

  return hook.memoizedState as Signal<T>;
}

// ============================================================================
// COM STATE HOOKS
// ============================================================================

/**
 * useComState - COM-bound shared state.
 *
 * Returns a signal bound to COM state. State is shared across all components
 * and persisted. Changes automatically trigger recompilation.
 *
 * @example
 * ```tsx
 * function Timeline() {
 *   const messages = useComState('timeline', []);
 *   return <Timeline>{messages().map(...)}</Timeline>;
 * }
 * ```
 */
export function useComState<T>(key: string, initialValue: T): Signal<T> {
  const hook = mountOrUpdateHook(HookTag.ComState);
  const ctx = getCurrentContext();

  if (hook.memoizedState === undefined) {
    const signal = createCOMStateSignal(ctx.com, key, initialValue);
    hook.memoizedState = signal;

    // Cleanup on unmount
    hook.effect = {
      phase: EffectPhase.Unmount,
      create: () => undefined,
      destroy: () => (signal as { dispose: () => void }).dispose(),
      deps: null,
      pending: false,
      next: null,
    };
  }

  // Safe to cast: initialValue is required, so T is never undefined
  return hook.memoizedState as Signal<T>;
}

/**
 * useWatch - Read-only COM state observation.
 * Returns a ReadonlySignal for reactive access to the watched state.
 *
 * @example
 * ```tsx
 * function StatusDisplay() {
 *   const status = useWatch('agentStatus', 'idle');
 *   return <Text>Status: {status()}</Text>;
 * }
 * ```
 */
export function useWatch<T>(key: string, defaultValue?: T): ReadonlySignal<T | undefined> {
  const hook = mountOrUpdateHook(HookTag.WatchState);
  const ctx = getCurrentContext();

  if (hook.memoizedState === undefined) {
    const signal = createReadonlyCOMStateSignal(ctx.com, key, defaultValue);
    hook.memoizedState = signal;

    hook.effect = {
      phase: EffectPhase.Unmount,
      create: () => undefined,
      destroy: () => (signal as { dispose: () => void }).dispose(),
      deps: null,
      pending: false,
      next: null,
    };
  }

  return hook.memoizedState as ReadonlySignal<T | undefined>;
}

/**
 * useInput - Reactive prop access with default value.
 */
export function useInput<T>(propKey: string, defaultValue?: T): T | undefined {
  const ctx = getCurrentContext();
  const value = ctx.fiber.props[propKey];
  return (value !== undefined ? value : defaultValue) as T | undefined;
}

// ============================================================================
// EFFECT HOOKS
// ============================================================================

/**
 * useEffect - Side effect after commit.
 *
 * Unlike React, callback CAN be async.
 * Signals/computed values in deps array are automatically unwrapped.
 *
 * During hydration:
 * - Mount effects (deps = []) are skipped (state is restored, not fresh)
 * - Effects with deps still run (deps might have changed since snapshot)
 *
 * @example
 * ```tsx
 * function Logger() {
 *   const message = useComState('message', '');
 *
 *   useEffect(async () => {
 *     await logToServer(message());  // Read signal value
 *     return () => console.log('cleanup');
 *   }, [message]);  // Signal auto-tracked by value
 * }
 * ```
 */
export function useEffect(create: EffectCallback, deps?: unknown[]): void {
  const hook = mountOrUpdateHook(HookTag.Effect);
  const ctx = getCurrentContext();

  // Unwrap signals in deps for comparison
  const unwrappedDeps = unwrapDeps(deps);

  // Check if this is a mount effect during hydration
  // Mount effects have empty deps array: useEffect(fn, [])
  const isMountEffect = Array.isArray(unwrappedDeps) && unwrappedDeps.length === 0;
  const isHydratingMount = ctx.isHydrating && isMountEffect && hook.effect === null;

  // Skip mount effects during hydration - state is restored, not fresh
  if (isHydratingMount) {
    // Still create the effect structure but mark as not pending
    hook.effect = {
      phase: EffectPhase.Commit,
      create,
      destroy: null,
      deps: unwrappedDeps ?? null,
      pending: false, // Don't run during hydration
      next: null,
    };
    return;
  }

  const hasDepsChanged =
    hook.effect === null ||
    unwrappedDeps === undefined ||
    unwrappedDeps === null ||
    !areHookInputsEqual(unwrappedDeps, hook.effect.deps);

  if (hasDepsChanged) {
    hook.effect = {
      phase: EffectPhase.Commit,
      create,
      destroy: hook.effect?.destroy ?? null,
      deps: unwrappedDeps ?? null,
      pending: true,
      next: null,
    };
  }
}

/**
 * useInit - Component initialization that runs once on mount.
 * Can be async and should be awaited if it returns a Promise.
 * Runs DURING render, blocking until complete.
 *
 * Use for: loading initial data, setting up state before first render
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const data = useComState('data', []);
 *
 *   await useInit(async (com, state) => {
 *     const initialData = await loadData();
 *     data.set(initialData);
 *   });
 *
 *   return <Section>{data().map(...)}</Section>;
 * }
 * ```
 */
export async function useInit(
  callback: (com: COM, state: TickState) => void | Promise<void>,
): Promise<void> {
  const ctx = getCurrentContext();
  const hook = mountOrUpdateHook(HookTag.Memo);

  if (hook.memoizedState === undefined) {
    const result = callback(ctx.com, ctx.tickState);
    const promise = result instanceof Promise ? result : Promise.resolve();
    hook.memoizedState = promise;
    await promise;
    return;
  }

  // Already initialized - return cached promise
  (await hook.memoizedState) as Promise<void>;
}

/**
 * useOnMount - Run once when component mounts as a side effect.
 * Runs AFTER render (as an effect), does not block rendering.
 * Use for non-critical side effects like logging, analytics.
 *
 * For blocking initialization, use `useInit` instead.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   useOnMount((com) => {
 *     log.info('Component mounted');
 *   });
 *   return <Text>Hello</Text>;
 * }
 * ```
 */
export function useOnMount(callback: (com: COM) => void | Promise<void>): void {
  const ctx = getCurrentContext();

  useEffect(() => {
    callback(ctx.com);
  }, []);
}

/**
 * useOnUnmount - Run once when component unmounts.
 */
export function useOnUnmount(callback: (com: COM) => void | Promise<void>): void {
  const ctx = getCurrentContext();

  useEffect(() => {
    return () => callback(ctx.com);
  }, []);
}

/**
 * useTickStart - Run at start of each tick, before render.
 *
 * @deprecated Use `useOnTickStart` instead for consistent naming convention.
 */
export function useTickStart(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  const hook = mountOrUpdateHook(HookTag.TickStart);
  const ctx = getCurrentContext();

  // Always pending - runs every tick
  hook.effect = {
    phase: EffectPhase.TickStart,
    create: () => callback(ctx.com, ctx.tickState),
    destroy: null,
    deps: null,
    pending: true,
    next: null,
  };
  hook.memoizedState = callback;
}

/**
 * useTickEnd - Run at end of each tick, after model execution.
 *
 * @deprecated Use `useOnTickEnd` instead for consistent naming convention.
 */
export function useTickEnd(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  const hook = mountOrUpdateHook(HookTag.TickEnd);
  const ctx = getCurrentContext();

  hook.effect = {
    phase: EffectPhase.TickEnd,
    create: () => callback(ctx.com, ctx.tickState),
    destroy: null,
    deps: null,
    pending: true,
    next: null,
  };
  hook.memoizedState = callback;
}

/**
 * useAfterCompile - Run after compile, can request recompile.
 *
 * @deprecated Use `useOnAfterCompile` instead for consistent naming convention.
 */
export function useAfterCompile(
  callback: (com: COM, compiled: CompiledStructure, state: TickState) => void,
): void {
  const hook = mountOrUpdateHook(HookTag.AfterCompile);
  const _ctx = getCurrentContext();

  // Store callback and create effect
  hook.memoizedState = callback;
  hook.effect = {
    phase: EffectPhase.AfterCompile,
    create: () => {
      // Will be called by compiler with compiled structure
      return undefined;
    },
    destroy: null,
    deps: null,
    pending: true,
    next: null,
  };
}

/**
 * useOnMessage - Handle execution messages.
 *
 * Called immediately when messages are sent to the running execution via:
 * - RuntimeSession.sendMessage() - Direct programmatic injection
 * - ExecutionHandle.send() - Via handle reference
 * - Channel events with type='message' - From client
 *
 * Messages are processed immediately when they arrive, not at tick boundaries.
 * Use com.abort() to interrupt execution if needed, or update state for the next tick.
 * Messages are also available in TickState.queuedMessages during render.
 *
 * @example
 * ```tsx
 * function InteractiveAgent() {
 *   const feedback = useComState('userFeedback', []);
 *
 *   useOnMessage((com, message, state) => {
 *     if (message.type === 'stop') {
 *       com.abort('User requested stop');
 *     } else if (message.type === 'feedback') {
 *       feedback.update(f => [...f, message.content]);
 *     }
 *   });
 *
 *   return <Section>{feedback().map(f => <Paragraph>{f}</Paragraph>)}</Section>;
 * }
 * ```
 */
export function useOnMessage(
  callback: (com: COM, message: ExecutionMessage, state: TickState) => void | Promise<void>,
): void {
  const hook = mountOrUpdateHook(HookTag.OnMessage);

  // Store the latest callback in memoizedState
  // This will be retrieved and called by notifyOnMessage in FiberCompiler
  hook.memoizedState = callback;

  // Mark with OnMessage tag for identification during traversal
  hook.effect = {
    phase: EffectPhase.OnMessage,
    create: () => undefined, // Will be called dynamically with message
    destroy: null,
    deps: null,
    pending: false, // Not pending by default - only runs when message arrives
    next: null,
  };
}

// ============================================================================
// LIFECYCLE HOOKS (useOn* naming convention)
// ============================================================================

/**
 * useOnTickStart - Run at start of each tick, before render.
 *
 * This is the canonical hook for tick-start lifecycle.
 * Alias: useTickStart (deprecated, prefer useOnTickStart)
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   useOnTickStart((com, state) => {
 *     console.log(`Starting tick ${state.tick}`);
 *   });
 *   return <System>You are helpful.</System>;
 * }
 * ```
 */
export function useOnTickStart(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  useTickStart(callback);
}

/**
 * useOnAfterRender - Run after render/reconciliation, before compile.
 *
 * Use this to inspect or modify state after all components have rendered
 * but before the context is compiled and sent to the model.
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   useOnAfterRender((com, state) => {
 *     console.log('Components rendered, about to compile');
 *   });
 *   return <System>You are helpful.</System>;
 * }
 * ```
 */
export function useOnAfterRender(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  const hook = mountOrUpdateHook(HookTag.AfterRender);
  const ctx = getCurrentContext();

  hook.effect = {
    phase: EffectPhase.AfterRender,
    create: () => callback(ctx.com, ctx.tickState),
    destroy: null,
    deps: null,
    pending: true,
    next: null,
  };
  hook.memoizedState = callback;
}

/**
 * useOnAfterCompile - Run after compile, before model call.
 *
 * Use this to transform the compiled structure before it's sent to the model.
 * Can request recompile if needed.
 *
 * This is the canonical hook for after-compile lifecycle.
 * Alias: useAfterCompile (deprecated, prefer useOnAfterCompile)
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   useOnAfterCompile((com, compiled, state) => {
 *     // Inspect or modify compiled structure
 *     if (compiled.tokenCount > 10000) {
 *       // Request summarization
 *     }
 *   });
 *   return <System>You are helpful.</System>;
 * }
 * ```
 */
export function useOnAfterCompile(
  callback: (com: COM, compiled: CompiledStructure, state: TickState) => void,
): void {
  useAfterCompile(callback);
}

/**
 * useOnTickEnd - Run at end of each tick, after model execution.
 *
 * Use this to process model response, decide on continuation, or clean up.
 *
 * This is the canonical hook for tick-end lifecycle.
 * Alias: useTickEnd (deprecated, prefer useOnTickEnd)
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   useOnTickEnd((com, state) => {
 *     console.log(`Tick ${state.tick} complete`);
 *     if (state.response?.stopReason === 'stop') {
 *       com.complete();
 *     }
 *   });
 *   return <System>You are helpful.</System>;
 * }
 * ```
 */
export function useOnTickEnd(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  useTickEnd(callback);
}

/**
 * useOnComplete - Run when session completes (all ticks done).
 *
 * This hook runs once when the session finishes execution, whether through:
 * - Natural completion (shouldContinue returns false)
 * - Explicit com.complete() call
 * - Error or abort
 *
 * Use this for cleanup, final logging, or teardown logic.
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   useOnComplete((com, state) => {
 *     console.log(`Session complete after ${state.tick} ticks`);
 *     // Cleanup resources
 *   });
 *   return <System>You are helpful.</System>;
 * }
 * ```
 */
export function useOnComplete(callback: (com: COM, state: TickState) => void | Promise<void>): void {
  const hook = mountOrUpdateHook(HookTag.Complete);
  const ctx = getCurrentContext();

  hook.effect = {
    phase: EffectPhase.Complete,
    create: () => callback(ctx.com, ctx.tickState),
    destroy: null,
    deps: null,
    pending: true,
    next: null,
  };
  hook.memoizedState = callback;
}

// ============================================================================
// ASYNC HOOKS
// ============================================================================

/**
 * useAsync - Async data fetching.
 *
 * Unlike React (which needs Suspense), we just track loading state.
 * The tick can wait for async work to complete.
 *
 * @example
 * ```tsx
 * function UserProfile({ userId }) {
 *   const { data: user, loading, error } = useAsync(
 *     () => fetchUser(userId),
 *     [userId]
 *   );
 *
 *   if (loading) return null;
 *   if (error) return <Text>Error: {error.message}</Text>;
 *
 *   return <Text>User: {user.name}</Text>;
 * }
 * ```
 */
export function useAsync<T>(asyncFn: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncResult<T>>({
    data: undefined,
    loading: true,
    error: undefined,
  });

  // Track if deps changed
  const prevDeps = useRef<unknown[] | null>(null);
  const depsChanged = prevDeps.current === null || !areHookInputsEqual(deps, prevDeps.current);
  prevDeps.current = deps;

  // Only trigger on deps change
  if (depsChanged && state.loading === false) {
    setState({ data: undefined, loading: true, error: undefined });
  }

  useEffect(() => {
    let cancelled = false;

    asyncFn()
      .then((data) => {
        if (!cancelled) {
          setState({ data, loading: false, error: undefined });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ data: undefined, loading: false, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

// ============================================================================
// MEMOIZATION HOOKS
// ============================================================================

/**
 * useMemo - Memoize expensive computation.
 */
export function useMemo<T>(factory: () => T, deps: unknown[]): T {
  const hook = mountOrUpdateHook(HookTag.Memo);

  const memoState = hook.memoizedState as [T, unknown[]] | undefined;
  const prevDeps = memoState?.[1];

  if (prevDeps !== undefined && areHookInputsEqual(deps, prevDeps)) {
    return memoState![0];
  }

  const value = factory();
  hook.memoizedState = [value, deps];
  return value;
}

/**
 * useComputed - Create a reactive computed signal that persists across renders.
 *
 * Unlike useMemo which returns a plain value, useComputed returns a ComputedSignal
 * that automatically tracks dependencies and updates when they change.
 * The computed signal is disposed and recreated only when deps change.
 *
 * @example
 * ```typescript
 * const timeline = useComState('timeline', []);
 * const recentMessages = useComputed(() => timeline().slice(-10), []);
 *
 * // Read the computed value
 * const messages = recentMessages();  // or recentMessages.value
 * ```
 */
export function useComputed<T>(computation: () => T, deps: unknown[] = []): ComputedSignal<T> {
  const hook = mountOrUpdateHook(HookTag.Memo);

  const memoState = hook.memoizedState as [ComputedSignal<T>, unknown[]] | undefined;
  const prevDeps = memoState?.[1];

  // If deps haven't changed, return existing computed
  if (prevDeps !== undefined && areHookInputsEqual(deps, prevDeps)) {
    return memoState![0];
  }

  // Deps changed or first render - dispose old computed if it exists
  if (memoState?.[0]) {
    memoState[0].dispose();
  }

  // Create new computed signal
  const computedSignal = computed(computation);
  hook.memoizedState = [computedSignal, deps];

  return computedSignal;
}

/**
 * useCallback - Memoize callback function.
 */
export function useCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  deps: unknown[],
): T {
  return useMemo(() => callback, deps);
}

// ============================================================================
// REF HOOKS
// ============================================================================

/**
 * useRef - Mutable ref that persists across renders.
 */
export function useRef<T>(initialValue: T): RefObject<T> {
  const hook = mountOrUpdateHook(HookTag.Ref);
  const ctx = getCurrentContext();

  if (hook.memoizedState === undefined) {
    hook.memoizedState = { current: initialValue };
  } else if (
    ctx.isHydrating &&
    hook.memoizedState !== null &&
    typeof hook.memoizedState !== "object"
  ) {
    // During hydration, memoizedState is the raw value (not wrapped in { current })
    // because serialization extracts ref.current for JSON serialization
    hook.memoizedState = { current: hook.memoizedState as T };
  }

  return hook.memoizedState as RefObject<T>;
}

/**
 * useCOMRef - Get component ref from COM.
 */
export function useCOMRef<T>(refName: string): T | undefined {
  const ctx = getCurrentContext();
  return ctx.com.getRef<T>(refName);
}

// ============================================================================
// UTILITY HOOKS
// ============================================================================

/**
 * usePrevious - Track previous value.
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  const previous = ref.current;

  // Update ref during render (not in effect) so it's ready for next render
  ref.current = value;

  return previous;
}

/**
 * useToggle - Boolean toggle state.
 */
export function useToggle(initial = false): [boolean, () => void] {
  const sig = useSignal(initial);
  const toggle = useCallback(() => sig.set((v) => !v), []);
  return [sig(), toggle];
}

/**
 * useCounter - Numeric counter.
 */
export function useCounter(initial = 0): {
  count: number;
  increment: () => void;
  decrement: () => void;
  set: (n: number) => void;
  reset: () => void;
} {
  const [count, setCount] = useState(initial);

  return {
    count,
    increment: useCallback(() => setCount((c) => c + 1), []),
    decrement: useCallback(() => setCount((c) => c - 1), []),
    set: setCount,
    reset: useCallback(() => setCount(initial), [initial]),
  };
}

/**
 * useAbortSignal - Get abort signal for current execution.
 */
export function useAbortSignal(): AbortSignal | undefined {
  const ctx = getCurrentContext();
  return ctx.abortSignal;
}

/**
 * useDebugValue - Display value in devtools (no-op in production).
 */
export function useDebugValue<T>(value: T, formatter?: (value: T) => unknown): void {
  if (process.env["NODE_ENV"] === "development") {
    const ctx = getCurrentContext();
    ctx.fiber.debugName = String(formatter ? formatter(value) : value);
  }
}

// ============================================================================
// TICK CONTROL HOOKS
// ============================================================================

/**
 * Result of useTick() hook.
 */
export interface UseTickResult {
  /** Request a tick to be scheduled */
  requestTick(): void;

  /** Cancel a pending tick request */
  cancelTick(): void;

  /** Current tick status: 'idle' | 'running' | 'pending' */
  tickStatus: "idle" | "running" | "pending";

  /** Total number of ticks executed */
  tickCount: number;
}

/**
 * useTick - Control tick execution from within a component.
 *
 * This hook provides components with the ability to:
 * - Request a new tick (e.g., when enough messages have accumulated)
 * - Cancel a pending tick request
 * - Check the current tick status
 * - Get the total tick count
 *
 * @example
 * ```tsx
 * function BatchProcessor() {
 *   const { requestTick, tickStatus, tickCount } = useTick();
 *   const queue = useComState('queue', []);
 *
 *   useEffect(() => {
 *     // Request tick when queue has 10 items and we're idle
 *     if (queue().length >= 10 && tickStatus === 'idle') {
 *       requestTick();
 *     }
 *   }, [queue().length, tickStatus]);
 *
 *   return <Section>Tick {tickCount}: {queue().length} items</Section>;
 * }
 * ```
 */
export function useTick(): UseTickResult {
  const ctx = getCurrentContext();
  const tickControl = ctx.tickControl;
  const tickState = ctx.tickState;

  // Default values if tick control not available
  const defaultResult: UseTickResult = {
    requestTick: () => {
      if (process.env["NODE_ENV"] === "development") {
        console.warn(
          "[useTick] requestTick called but tickControl not available. " +
            "Tick control is only available when running in a Session context.",
        );
      }
    },
    cancelTick: () => {
      if (process.env["NODE_ENV"] === "development") {
        console.warn(
          "[useTick] cancelTick called but tickControl not available. " +
            "Tick control is only available when running in a Session context.",
        );
      }
    },
    tickStatus: "idle",
    tickCount: tickState?.tick ?? 0,
  };

  if (!tickControl) {
    return defaultResult;
  }

  return {
    requestTick: tickControl.requestTick,
    cancelTick: tickControl.cancelTick,
    tickStatus: tickControl.status,
    tickCount: tickControl.tickCount,
  };
}

// ============================================================================
// CHANNEL HOOKS
// ============================================================================

import type { Channel, ChannelEvent } from "../core/channel";

/**
 * Result of useChannel() hook.
 * Provides access to a named channel for pub/sub communication.
 */
export interface UseChannelResult {
  /**
   * The underlying Channel instance.
   * May be undefined if channels are not configured.
   */
  channel: Channel | undefined;

  /**
   * Subscribe to channel events.
   * Returns an unsubscribe function.
   *
   * @example
   * ```tsx
   * const { subscribe } = useChannel('updates');
   * useEffect(() => subscribe(handleEvent), []);
   * ```
   */
  subscribe: (handler: (event: ChannelEvent) => void) => () => void;

  /**
   * Publish an event to the channel.
   *
   * @example
   * ```tsx
   * const { publish } = useChannel('events');
   * publish({ type: 'status', payload: { ready: true } });
   * ```
   */
  publish: (event: Omit<ChannelEvent, "channel">) => void;

  /**
   * Wait for a response to a specific request.
   *
   * @example
   * ```tsx
   * const { waitForResponse, publish } = useChannel('confirmations');
   * publish({ type: 'request', id: 'confirm-1', payload: { action: 'delete' } });
   * const response = await waitForResponse('confirm-1', 30000);
   * ```
   */
  waitForResponse: (requestId: string, timeoutMs?: number) => Promise<ChannelEvent>;

  /**
   * Whether the channel is available.
   * False if channel service is not configured.
   */
  available: boolean;
}

/**
 * useChannel - Access a named channel for pub/sub communication.
 *
 * Channels enable real-time bidirectional communication between components
 * and external code (UI, other services, etc.).
 *
 * Use cases:
 * - User input during model execution (e.g., stop button, feedback)
 * - Progress updates to UI
 * - Tool confirmation dialogs
 * - Live data streaming to/from external systems
 *
 * @param name - Channel name (e.g., 'progress', 'user-input', 'tool:confirm')
 * @returns Channel access object with subscribe, publish, and waitForResponse
 *
 * @example Basic subscription
 * ```tsx
 * function ProgressDisplay() {
 *   const [progress, setProgress] = useState(0);
 *   const { subscribe, available } = useChannel('progress');
 *
 *   useEffect(() => {
 *     if (!available) return;
 *     return subscribe((event) => {
 *       if (event.type === 'update') {
 *         setProgress(event.payload.percent);
 *       }
 *     });
 *   }, [available]);
 *
 *   return <Section>Progress: {progress}%</Section>;
 * }
 * ```
 *
 * @example Request/Response pattern
 * ```tsx
 * function ConfirmationHandler() {
 *   const { publish, waitForResponse, available } = useChannel('confirmations');
 *
 *   const confirmAction = async (action: string) => {
 *     if (!available) throw new Error('Channels not available');
 *
 *     const requestId = crypto.randomUUID();
 *     publish({ type: 'request', id: requestId, payload: { action } });
 *     const response = await waitForResponse(requestId, 30000);
 *     return response.payload.confirmed;
 *   };
 *
 *   // ...
 * }
 * ```
 *
 * @example Publishing events
 * ```tsx
 * function StatusReporter() {
 *   const { publish } = useChannel('status');
 *
 *   useTickEnd(() => {
 *     publish({ type: 'tick-complete', payload: { timestamp: Date.now() } });
 *   });
 *
 *   return null;
 * }
 * ```
 */
export function useChannel(name: string): UseChannelResult {
  const ctx = getCurrentContext();

  // Get the channel from the context (provided by Session)
  const channel = ctx.getChannel?.(name);

  // Default no-op implementations for when channels aren't available
  const unavailableResult: UseChannelResult = {
    channel: undefined,
    subscribe: () => {
      if (process.env["NODE_ENV"] === "development") {
        console.warn(
          `[useChannel] subscribe called on '${name}' but channel service not available. ` +
            "Channels require ChannelService configuration.",
        );
      }
      return () => {}; // No-op unsubscribe
    },
    publish: () => {
      if (process.env["NODE_ENV"] === "development") {
        console.warn(
          `[useChannel] publish called on '${name}' but channel service not available. ` +
            "Channels require ChannelService configuration.",
        );
      }
    },
    waitForResponse: () => {
      return Promise.reject(
        new Error(
          `Channel '${name}' not available. Channels require ChannelService configuration.`,
        ),
      );
    },
    available: false,
  };

  if (!channel) {
    return unavailableResult;
  }

  return {
    channel,
    subscribe: (handler) => channel.subscribe(handler),
    publish: (event) => channel.publish({ ...event, channel: name }),
    waitForResponse: (requestId, timeoutMs) => channel.waitForResponse(requestId, timeoutMs),
    available: true,
  };
}

/**
 * useChannelSubscription - Subscribe to channel events with automatic cleanup.
 *
 * This is a convenience hook that combines useChannel with useEffect for
 * the common pattern of subscribing to a channel and cleaning up on unmount.
 *
 * @param name - Channel name
 * @param handler - Event handler function
 * @param deps - Dependencies array (handler is only updated when deps change)
 *
 * @example
 * ```tsx
 * function NotificationListener() {
 *   const [notifications, setNotifications] = useState<string[]>([]);
 *
 *   useChannelSubscription('notifications', (event) => {
 *     if (event.type === 'new') {
 *       setNotifications(n => [...n, event.payload.message]);
 *     }
 *   }, []);
 *
 *   return <Section>{notifications.map(n => <Text>{n}</Text>)}</Section>;
 * }
 * ```
 */
export function useChannelSubscription(
  name: string,
  handler: (event: ChannelEvent) => void,
  deps: unknown[] = [],
): void {
  const { subscribe, available } = useChannel(name);

  // Use a ref to store the latest handler to avoid stale closures
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!available) return;

    // Subscribe with a wrapper that always uses the latest handler
    return subscribe((event) => handlerRef.current(event));
  }, [available, ...deps]);
}

// ============================================================================
// CONVERSATION HISTORY HOOKS
// ============================================================================

/**
 * Options for filtering and limiting conversation history.
 */
export interface ConversationHistoryOptions {
  /**
   * Filter function to include/exclude entries.
   * @example Filter out system messages: (e) => e.message?.role !== 'system'
   */
  filter?: (entry: COMTimelineEntry) => boolean;

  /**
   * Maximum number of entries to return (from the end).
   * @example Last 10 messages: { limit: 10 }
   */
  limit?: number;

  /**
   * Include only entries from specific roles.
   * @example Only user/assistant: { roles: ['user', 'assistant'] }
   */
  roles?: Array<"user" | "assistant" | "tool" | "system">;
}

/**
 * Get the full conversation history across all ticks.
 *
 * Combines `state.previous.timeline` (history) with `state.current.timeline`
 * (current tick) into a single array.
 *
 * This is a utility hook that extracts data from TickState - it doesn't use the
 * fiber system and can be called anywhere you have access to TickState.
 *
 * @param state - The TickState from component context
 * @param options - Optional filtering and limiting
 * @returns Array of timeline entries
 *
 * @example Basic usage
 * ```tsx
 * const ChatAgent = ({ message }: Props) => {
 *   const history = useConversationHistory();
 *
 *   return (
 *     <>
 *       <Model model={claude} />
 *       <System>You are helpful.</System>
 *       {history.map((entry, i) => (
 *         <Message key={i} {...entry.message} />
 *       ))}
 *       <User>{message}</User>
 *     </>
 *   );
 * };
 * ```
 *
 * @example With options
 * ```tsx
 * const history = useConversationHistory({
 *   roles: ['user', 'assistant'],  // Exclude tool messages
 *   limit: 10,                      // Last 10 messages
 * });
 * ```
 */
export function useConversationHistory(options?: ConversationHistoryOptions): COMTimelineEntry[] {
  const state = useTickState();
  const com = useCom();

  // Combine previous, current, and injected timelines
  // - previous: History from previous ticks (including hydrated initial timeline)
  // - current: Model output from last tick (may be empty on tick 1)
  // - injected: Entries added via com.injectHistory() during this tick
  let entries: COMTimelineEntry[] = [
    ...((state.previous as COMInput | undefined)?.timeline || []),
    ...(state.current?.timeline || []),
    ...com.getInjectedHistory(),
  ];

  // Apply role filter if specified
  if (options?.roles) {
    const roleSet = new Set(options.roles);
    entries = entries.filter(
      (entry) => entry.message?.role && roleSet.has(entry.message.role as any),
    );
  }

  // Apply custom filter
  if (options?.filter) {
    entries = entries.filter(options.filter);
  }

  // Apply limit (from end)
  if (options?.limit && options.limit > 0) {
    entries = entries.slice(-options.limit);
  }

  return entries;
}

/**
 * Get just the messages from conversation history (convenience wrapper).
 *
 * @param options - Optional filtering and limiting
 * @returns Array of messages (excluding entries without messages)
 */
export function useMessages(
  options?: ConversationHistoryOptions,
): Array<COMTimelineEntry["message"]> {
  return useConversationHistory(options)
    .filter((entry) => entry.message)
    .map((entry) => entry.message);
}

/**
 * Get message count from conversation history.
 *
 * @returns Number of messages in history
 */
export function useMessageCount(): number {
  return useConversationHistory().filter((entry) => entry.message).length;
}

/**
 * Get messages queued for the next tick.
 *
 * Messages can be queued via:
 * - `session.queueMessage(msg)` - Queue a message for later processing
 * - `session.interrupt(msg)` - Interrupt and queue a message
 * - `RuntimeSession.sendMessage(msg)` - Direct programmatic injection
 *
 * Queued messages are available during render and can be used to show
 * pending messages in the UI or to process them in the current tick.
 *
 * @returns Array of queued execution messages
 *
 * @example Show pending messages
 * ```tsx
 * const ChatWithPending = () => {
 *   const history = useConversationHistory();
 *   const pending = useQueuedMessages();
 *
 *   return (
 *     <>
 *       {history.map((entry, i) => (
 *         <Message key={i} {...entry.message} />
 *       ))}
 *       {pending.length > 0 && (
 *         <System>Processing {pending.length} pending message(s)...</System>
 *       )}
 *     </>
 *   );
 * };
 * ```
 *
 * @example Process pending messages
 * ```tsx
 * const Agent = () => {
 *   const pending = useQueuedMessages();
 *
 *   // Access the first pending message if any
 *   const firstPending = pending[0];
 *   if (firstPending?.type === 'interrupt') {
 *     return <System>Handling interrupt: {firstPending.content}</System>;
 *   }
 *
 *   return <AssistantMessage />;
 * };
 * ```
 */
export function useQueuedMessages(): ExecutionMessage[] {
  const state = useTickState();
  return state.queuedMessages ?? [];
}

// ============================================================================
// History Injection Hooks
// ============================================================================

/**
 * Inject historical timeline entries into the conversation.
 *
 * Use this to load an existing conversation when the component mounts.
 * The entries are injected once (on first render) and then available via
 * `useConversationHistory()` and `<Timeline />`.
 *
 * This hook only injects on the first render. On subsequent renders (tick 2+),
 * the timeline naturally includes all entries via `TickState.previous.timeline`.
 *
 * @param entries - Timeline entries to inject, or a function that returns them
 * @param deps - Dependency array (like useEffect). If omitted, injects once on mount.
 *
 * @example Basic usage with static entries
 * ```tsx
 * const ChatAgent = ({ conversationHistory }: Props) => {
 *   useInjectHistory(conversationHistory);
 *   return <Timeline />;
 * };
 * ```
 *
 * @example Async loading in useInit
 * ```tsx
 * const ChatAgent = ({ conversationId }: Props) => {
 *   const [loaded, setLoaded] = useState(false);
 *
 *   await useInit(async () => {
 *     const conversation = await loadConversation(conversationId);
 *     injectHistory(conversation.entries);  // Use standalone function
 *     setLoaded(true);
 *   });
 *
 *   if (!loaded) return null;
 *   return <Timeline />;
 * };
 * ```
 */
export function useInjectHistory(
  entries: COMTimelineEntry[] | (() => COMTimelineEntry[]),
  deps?: unknown[],
): void {
  const com = useCom();
  const hasInjected = useRef(false);

  // Resolve entries (can be array or function)
  const resolvedEntries = typeof entries === "function" ? entries() : entries;

  // Only inject once (unless deps change)
  const shouldInject = deps
    ? !hasInjected.current // With deps, use ref to track
    : !hasInjected.current; // Without deps, also use ref

  if (shouldInject && resolvedEntries.length > 0) {
    com.injectHistory(resolvedEntries);
    hasInjected.current = true;
  }
}

/**
 * Standalone function to inject history (for use in useInit or async contexts).
 *
 * Unlike the hook, this can be called anywhere you have access to COM.
 *
 * @param com - The COM instance
 * @param entries - Timeline entries to inject
 *
 * @example
 * ```tsx
 * const ChatAgent = ({ conversationId }: Props) => {
 *   const com = useCom();
 *
 *   await useInit(async () => {
 *     const conversation = await loadConversation(conversationId);
 *     injectHistory(com, conversation.entries);
 *   });
 *
 *   return <Timeline />;
 * };
 * ```
 */
export function injectHistory(com: COM, entries: COMTimelineEntry[]): void {
  com.injectHistory(entries);
}

// ============================================================================
// Helpers
// ============================================================================

function areHookInputsEqual(nextDeps: unknown[], prevDeps: unknown[] | null): boolean {
  if (prevDeps === null) return false;

  if (process.env["NODE_ENV"] === "development" && nextDeps.length !== prevDeps.length) {
    console.warn(
      "Hook dependency array changed size between renders. " +
        "The array must remain constant in length.",
    );
  }

  for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
    if (Object.is(nextDeps[i], prevDeps[i])) continue;
    return false;
  }

  return true;
}
