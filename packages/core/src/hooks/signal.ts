/**
 * Signal implementation for reactive state management.
 *
 * Signals provide a lightweight, framework-agnostic way to manage reactive state.
 * Similar to Angular/SolidJS signals.
 *
 * This is the full signal library with:
 * - AsyncLocalStorage for concurrency safety
 * - Auto-tracking computed signals
 * - Batch operations
 * - COM state integration
 * - Compiler integration for automatic recompilation
 *
 * @example
 * ```typescript
 * // Create a signal
 * const count = signal(0);
 *
 * // Read value
 * console.log(count()); // 0
 *
 * // Update value
 * count.set(10);
 * console.log(count()); // 10
 *
 * // Update with function
 * count.update(n => n + 1);
 * console.log(count()); // 11
 *
 * // Computed signal (memoized, auto-updates)
 * const doubled = computed(() => count() * 2);
 * console.log(doubled()); // 22
 *
 * // Cleanup when done
 * count.dispose();
 * ```
 *
 * @see docs/state-management.md for full documentation
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { useRef, useState, useEffect, useContext, useDebugValue } from "react";
import { COMContext } from "./context.js";

// Import for render phase detection
import {
  isCompilerRendering,
  shouldSkipRecompile,
  getActiveCompiler,
} from "../compiler/fiber-compiler.js";

// ============================================================================
// Signal Execution Context (Concurrency Safety)
// ============================================================================

/**
 * Tracking context for computed/effect dependency detection.
 * When a signal is read inside a computed/effect, it registers
 * itself as a dependency via this context.
 */
interface TrackingContext {
  onDependency: (source: ReactiveSource) => void;
}

/**
 * SignalContext holds per-execution state for signals.
 *
 * While batch() and computed() are synchronous operations that complete
 * without yielding to the event loop, using AsyncLocalStorage provides:
 *
 * 1. **Defensive design** - If async code is ever introduced in batch/computed,
 *    it won't break.
 * 2. **Explicit isolation** - Each Agentick execution has its own context,
 *    making the concurrency model clear.
 * 3. **Consistency** - Same pattern as RenderContext.scheduleWork.
 *
 * Note: In current usage, batch/tracking are synchronous, so the global
 * fallback works identically to ALS for single-execution scenarios.
 */
class SignalContext {
  /** Stack of tracking contexts for computed/effect dependency tracking */
  trackingStack: TrackingContext[] = [];

  /** Current batch nesting depth */
  batchDepth = 0;

  /** Effects waiting to be flushed after batch completes */
  pendingEffects = new Set<() => void>();

  /** Whether a microtask flush is scheduled */
  flushScheduled = false;
}

/**
 * AsyncLocalStorage for signal execution context.
 * Each Agentick execution (app.run, session.tick) runs within its own context.
 */
const signalContextStorage = new AsyncLocalStorage<SignalContext>();

/**
 * Global fallback context for signals used outside of Agentick execution.
 * This allows standalone signal usage (e.g., in tests, scripts) while
 * maintaining full concurrency safety within Agentick.
 */
const globalSignalContext = new SignalContext();

/**
 * Get the current signal context.
 * Returns the ALS context if available, otherwise the global fallback.
 */
function getSignalContext(): SignalContext {
  return signalContextStorage.getStore() ?? globalSignalContext;
}

/**
 * Run a function within a signal context.
 * Used by FiberCompiler to establish per-execution context.
 *
 * @internal
 */
export function runWithSignalContext<T>(fn: () => T): T {
  return signalContextStorage.run(new SignalContext(), fn);
}

/**
 * Run an async function within a signal context.
 * Used by FiberCompiler to establish per-execution context.
 *
 * @internal
 */
export async function runWithSignalContextAsync<T>(fn: () => Promise<T>): Promise<T> {
  return signalContextStorage.run(new SignalContext(), fn);
}

// ============================================================================
// Types
// ============================================================================

export const SIGNAL_SYMBOL = Symbol.for("agentick.signal");
export const COMPUTED_SYMBOL = Symbol.for("agentick.computed");
export const EFFECT_SYMBOL = Symbol.for("agentick.effect");

type EqualityFn<T> = (a: T, b: T) => boolean;
type CleanupFn = () => void;

export interface SignalOptions<T> {
  /** Custom equality function. Default: Object.is */
  equal?: EqualityFn<T>;
  /** Signal name for debugging */
  name?: string;
}

export interface Signal<T> {
  /** Read the current value */
  (): T;
  /** Set a new value */
  set: (value: T | ((prev: T) => T)) => void;
  /** Update value with a function */
  update: (updater: (value: T) => T) => void;
  /** Subscribe to value changes */
  subscribe?: (callback: (value: T) => void) => () => void;
  /** Current value (property access) */
  readonly value: T;
  /** Dispose this signal and clean up all listeners */
  dispose?: () => void;
  /** Check if signal is disposed */
  readonly disposed?: boolean;
}

export interface ComputedSignal<T> {
  /** Read the current value */
  (): T;
  /** Current value (property access) */
  readonly value: T;
  /** Dispose this computed and stop tracking */
  dispose: () => void;
  /** Check if computed is disposed */
  readonly disposed: boolean;
}

/**
 * A read-only signal that can be observed but not modified.
 * Used for watching state owned by another component.
 */
export interface ReadonlySignal<T> {
  /** Read the current value */
  (): T;
  /** Current value (property access) */
  readonly value: T;
  /** Dispose this signal and stop watching */
  dispose: () => void;
  /** Check if disposed */
  readonly disposed: boolean;
}

export interface EffectRef {
  /** Dispose this effect and stop running */
  dispose: () => void;
  /** Check if effect is disposed */
  readonly disposed: boolean;
}

// ============================================================================
// Batching
// ============================================================================

/**
 * Batch multiple signal updates together.
 * Effects only run once after all updates complete.
 *
 * @example
 * ```typescript
 * batch(() => {
 *   count.set(1);
 *   name.set('Alice');
 *   // Effects run once here, not twice
 * });
 * ```
 */
export function batch<T>(fn: () => T): T {
  const ctx = getSignalContext();
  ctx.batchDepth++;
  try {
    return fn();
  } finally {
    ctx.batchDepth--;
    if (ctx.batchDepth === 0) {
      flushPendingEffects(ctx);
    }
  }
}

function scheduleEffect(effectFn: () => void): void {
  const ctx = getSignalContext();

  if (ctx.batchDepth > 0) {
    ctx.pendingEffects.add(effectFn);
    return;
  }

  // Schedule microtask flush if not already scheduled
  ctx.pendingEffects.add(effectFn);
  if (!ctx.flushScheduled) {
    ctx.flushScheduled = true;
    // Capture context for the microtask
    queueMicrotask(() => flushPendingEffects(ctx));
  }
}

function flushPendingEffects(ctx: SignalContext): void {
  ctx.flushScheduled = false;
  const effects = [...ctx.pendingEffects];
  ctx.pendingEffects.clear();

  for (const effectFn of effects) {
    try {
      effectFn();
    } catch (error) {
      console.error("Error in signal effect:", error);
    }
  }
}

// ============================================================================
// Dependency Tracking
// ============================================================================

/**
 * Subscription represents a connection between a signal and a subscriber.
 * Calling dispose() removes the subscriber from the signal.
 */
interface Subscription {
  notify: () => void;
  dispose: () => void;
}

/**
 * A reactive node that can be subscribed to.
 * Both signals and computeds implement this.
 */
interface ReactiveSource {
  _subscribe: (notify: () => void) => Subscription;
}

function getCurrentTrackingContext(): TrackingContext | undefined {
  const ctx = getSignalContext();
  return ctx.trackingStack[ctx.trackingStack.length - 1];
}

function pushTrackingContext(trackingCtx: TrackingContext): void {
  const ctx = getSignalContext();
  ctx.trackingStack.push(trackingCtx);
}

function popTrackingContext(): void {
  const ctx = getSignalContext();
  ctx.trackingStack.pop();
}

// ============================================================================
// Signal (standalone)
// ============================================================================

/**
 * Creates a writable signal with an initial value.
 *
 * @example
 * ```typescript
 * const count = signal(0);
 * count();           // 0
 * count.set(10);     // set to 10
 * count.update(n => n + 1);  // increment
 * count.dispose();   // cleanup
 * ```
 */
export function signal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T> {
  let value = initialValue;
  let isDisposed = false;
  const subscriptions = new Set<Subscription>();
  const equal = options?.equal ?? Object.is;

  const notify = () => {
    for (const sub of subscriptions) {
      scheduleEffect(sub.notify);
    }
  };

  // Internal: subscribe to this signal
  const _subscribe = (notifyFn: () => void): Subscription => {
    const subscription: Subscription = {
      notify: notifyFn,
      dispose: () => {
        subscriptions.delete(subscription);
      },
    };
    subscriptions.add(subscription);
    return subscription;
  };

  const getter = (): T => {
    if (isDisposed) {
      return value;
    }

    // Track this signal as a dependency of current computed/effect
    const context = getCurrentTrackingContext();
    if (context) {
      context.onDependency({ _subscribe } as ReactiveSource);
    }

    return value;
  };

  const setter = (newValue: T | ((prev: T) => T)): void => {
    if (isDisposed) {
      console.warn("Attempted to set disposed signal");
      return;
    }

    const nextValue =
      typeof newValue === "function" ? (newValue as (prev: T) => T)(value) : newValue;

    if (!equal(nextValue, value)) {
      value = nextValue;
      notify();
    }
  };

  const updater = (updaterFn: (value: T) => T): void => {
    setter(updaterFn(value));
  };

  const dispose = (): void => {
    isDisposed = true;
    subscriptions.clear();
  };

  const signalFn = getter as Signal<T> & ReactiveSource;
  signalFn.set = setter;
  signalFn.update = updater;
  signalFn.dispose = dispose;
  (signalFn as any)._subscribe = _subscribe;
  (signalFn as any)[SIGNAL_SYMBOL] = true;

  // Add subscribe for compatibility with useSignal
  signalFn.subscribe = (callback: (value: T) => void) => {
    const sub = _subscribe(() => callback(value));
    return () => sub.dispose();
  };

  Object.defineProperty(signalFn, "value", {
    get: getter,
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(signalFn, "disposed", {
    get: () => isDisposed,
    enumerable: true,
    configurable: true,
  });

  return signalFn;
}

// ============================================================================
// createSignal (alias for signal, used by useSignal)
// ============================================================================

/**
 * Create a standalone signal (not tied to a component).
 * Alias for signal() for API compatibility.
 */
export function createSignal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T> {
  return signal(initialValue, options);
}

// ============================================================================
// Computed
// ============================================================================

/**
 * Creates a computed signal that derives its value from other signals.
 * Computed values are memoized and only recompute when dependencies change.
 *
 * @example
 * ```typescript
 * const count = signal(0);
 * const doubled = computed(() => count() * 2);
 *
 * doubled();  // 0
 * count.set(5);
 * doubled();  // 10 (recomputed)
 * doubled();  // 10 (cached, no recompute)
 * ```
 */
export function computed<T>(computation: () => T, options?: SignalOptions<T>): ComputedSignal<T> {
  let cachedValue: T;
  let isDirty = true;
  let isDisposed = false;
  let isComputing = false;
  const _equal = options?.equal ?? Object.is;

  // Subscriptions to our dependencies (signals we read)
  const dependencySubscriptions = new Set<Subscription>();
  // Subscriptions from our dependents (things that read us)
  const dependentSubscriptions = new Set<Subscription>();

  const markDirty = () => {
    if (!isDirty && !isDisposed) {
      isDirty = true;
      // Notify our dependents that we might have changed
      for (const sub of dependentSubscriptions) {
        scheduleEffect(sub.notify);
      }
    }
  };

  // Internal: subscribe to this computed
  const _subscribe = (notifyFn: () => void): Subscription => {
    const subscription: Subscription = {
      notify: notifyFn,
      dispose: () => {
        dependentSubscriptions.delete(subscription);
      },
    };
    dependentSubscriptions.add(subscription);
    return subscription;
  };

  const clearDependencies = () => {
    // Unsubscribe from all current dependencies
    for (const sub of dependencySubscriptions) {
      sub.dispose();
    }
    dependencySubscriptions.clear();
  };

  const recompute = (): T => {
    if (isComputing) {
      throw new Error("Circular dependency detected in computed signal");
    }

    isComputing = true;

    // Clear old dependencies
    clearDependencies();

    // Set up tracking context to capture new dependencies
    const trackingContext: TrackingContext = {
      onDependency: (source: ReactiveSource) => {
        // Subscribe to this dependency
        const subscription = source._subscribe(markDirty);
        dependencySubscriptions.add(subscription);
      },
    };
    pushTrackingContext(trackingContext);

    try {
      const newValue = computation();
      cachedValue = newValue;
      isDirty = false;
      return cachedValue;
    } finally {
      popTrackingContext();
      isComputing = false;
    }
  };

  const getter = (): T => {
    if (isDisposed) {
      return cachedValue;
    }

    // Track this computed as dependency of parent computed/effect
    const context = getCurrentTrackingContext();
    if (context) {
      context.onDependency({ _subscribe } as ReactiveSource);
    }

    // Recompute if dirty (lazy evaluation)
    if (isDirty) {
      recompute();
    }

    return cachedValue;
  };

  const dispose = (): void => {
    if (isDisposed) return;

    isDisposed = true;
    isDirty = false;

    // Unsubscribe from all dependencies - THIS FIXES THE MEMORY LEAK
    clearDependencies();

    // Clear our dependents (they'll get undefined on next read)
    dependentSubscriptions.clear();
  };

  const computedFn = getter as ComputedSignal<T> & ReactiveSource;
  computedFn.dispose = dispose;
  (computedFn as any)._subscribe = _subscribe;
  (computedFn as any)[COMPUTED_SYMBOL] = true;

  Object.defineProperty(computedFn, "value", {
    get: getter,
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(computedFn, "disposed", {
    get: () => isDisposed,
    enumerable: true,
    configurable: true,
  });

  return computedFn;
}

// ============================================================================
// Effect
// ============================================================================

/**
 * Runs an effect that automatically re-runs when dependencies change.
 * Use sparingly - prefer computed() for derived values.
 *
 * Best for: syncing to external APIs (localStorage, canvas, DOM, etc.)
 *
 * @example
 * ```typescript
 * const count = signal(0);
 *
 * const ref = effect(() => {
 *   console.log('Count:', count());
 * });
 *
 * count.set(5);  // logs "Count: 5"
 *
 * ref.dispose();  // stop the effect
 * ```
 */
export function effect(
  fn: (onCleanup: (cleanup: CleanupFn) => void) => void | CleanupFn,
): EffectRef {
  let isDisposed = false;
  let cleanupFn: CleanupFn | undefined;
  const dependencySubscriptions = new Set<Subscription>();

  const clearDependencies = () => {
    for (const sub of dependencySubscriptions) {
      sub.dispose();
    }
    dependencySubscriptions.clear();
  };

  const runEffect = () => {
    if (isDisposed) return;

    // Run cleanup from previous execution
    if (cleanupFn) {
      try {
        cleanupFn();
      } catch (error) {
        console.error("Error in effect cleanup:", error);
      }
      cleanupFn = undefined;
    }

    // Clear old dependencies
    clearDependencies();

    // Set up tracking context
    const trackingContext: TrackingContext = {
      onDependency: (source: ReactiveSource) => {
        const subscription = source._subscribe(runEffect);
        dependencySubscriptions.add(subscription);
      },
    };
    pushTrackingContext(trackingContext);

    try {
      // Allow effect to register cleanup via callback or return value
      const onCleanup = (cleanup: CleanupFn) => {
        cleanupFn = cleanup;
      };

      const result = fn(onCleanup);

      // Also accept cleanup as return value (like React useEffect)
      if (typeof result === "function") {
        cleanupFn = result;
      }
    } finally {
      popTrackingContext();
    }
  };

  const dispose = (): void => {
    if (isDisposed) return;

    isDisposed = true;

    // Unsubscribe from all dependencies
    clearDependencies();

    // Run final cleanup
    if (cleanupFn) {
      try {
        cleanupFn();
      } catch (error) {
        console.error("Error in effect cleanup:", error);
      }
      cleanupFn = undefined;
    }
  };

  // Run immediately
  runEffect();

  const effectRef: EffectRef = {
    dispose,
    get disposed() {
      return isDisposed;
    },
  };

  // Mark as effect for cleanup detection
  (effectRef as any)[EFFECT_SYMBOL] = true;

  return effectRef;
}

// ============================================================================
// React Hooks for Signals
// ============================================================================

/**
 * Create a signal - reactive state that can trigger reconciliation.
 *
 * Unlike useState, signals:
 * - Can be read outside of render
 * - Can be subscribed to
 * - Don't cause immediate re-render (schedule reconcile instead)
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const count = useSignal(0);
 *
 *   const handleClick = () => {
 *     count.set(c => c + 1);
 *   };
 *
 *   return <Section>Count: {count()}</Section>;
 * };
 * ```
 */
export function useSignal<T>(initialValue: T): Signal<T> {
  // Use a version counter to trigger re-renders when signal changes
  // The signal's internal value is the source of truth
  const [version, setVersion] = useState(0);

  // Get COM for requestRecompile - this triggers the scheduler when idle
  // Returns null if not in Agentick context
  const ctx = useContext(COMContext);

  // Store setVersion in a ref so it's always current
  // This fixes the issue where setVersion captured in the signal closure
  // might be stale when called between ticks
  const setVersionRef = useRef(setVersion);
  setVersionRef.current = setVersion;

  // Create signal wrapper once - stored in ref for stability
  const signalRef = useRef<Signal<T> | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // Update ctx ref on each render

  if (signalRef.current === null) {
    const baseSignal = createSignal(initialValue);

    // Wrap the set function to trigger React re-render AND scheduler
    const originalSet = baseSignal.set;
    baseSignal.set = (newValue: T | ((prev: T) => T)) => {
      // Update the underlying signal (source of truth)
      originalSet(newValue);
      // Increment version to trigger re-render
      // Use ref to always get current setter
      setVersionRef.current((v) => v + 1);
      // Request recompile through COM → scheduler → reconcile
      // This triggers the reactive model when session is idle
      if (ctxRef.current?.requestRecompile) {
        ctxRef.current.requestRecompile("useSignal state change");
      }
    };

    signalRef.current = baseSignal;
  }

  // Force unused variable to avoid lint warning
  void version;

  // Debug value for React DevTools
  useDebugValue(signalRef.current.value, (v) =>
    typeof v === "object" ? `Object(${Object.keys(v as object).length} keys)` : String(v),
  );

  return signalRef.current;
}

/**
 * Create a computed signal that derives from other signals.
 *
 * @example
 * ```tsx
 * const count = useSignal(5);
 * const doubled = useComputed(() => count() * 2, [count]);
 * // doubled() === 10
 * ```
 */
export function useComputed<T>(compute: () => T, deps: readonly Signal<any>[]): Signal<T> {
  // Use version counter to trigger re-renders
  const [, setVersion] = useState(0);

  // Create signal wrapper once
  const computedRef = useRef<Signal<T> | null>(null);

  if (computedRef.current === null) {
    const baseSignal = createSignal(compute());

    // Wrap set to trigger React re-render
    const originalSet = baseSignal.set;
    baseSignal.set = (newValue: T | ((prev: T) => T)) => {
      originalSet(newValue);
      setVersion((v) => v + 1);
    };

    computedRef.current = baseSignal;
  }

  // Recompute when deps change
  useEffect(() => {
    const unsubscribes = deps.map((dep) =>
      dep.subscribe!(() => {
        const newValue = compute();
        computedRef.current!.set(newValue);
      }),
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, deps);

  // Debug value for React DevTools
  useDebugValue(computedRef.current.value, (v) =>
    typeof v === "object"
      ? `Computed(${Object.keys(v as object).length} keys)`
      : `Computed(${String(v)})`,
  );

  return computedRef.current;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Read a signal without tracking it as a dependency.
 * Useful when you want to read a value in a computed/effect without
 * triggering re-runs when that value changes.
 *
 * @example
 * ```typescript
 * effect(() => {
 *   const user = currentUser();
 *   const count = untracked(() => counter());  // won't trigger re-run
 *   console.log(`User ${user} has count ${count}`);
 * });
 * ```
 */
export function untracked<T>(fn: () => T): T {
  const ctx = getSignalContext();
  // Temporarily remove tracking context
  const savedStack = [...ctx.trackingStack];
  ctx.trackingStack.length = 0;

  try {
    return fn();
  } finally {
    ctx.trackingStack.push(...savedStack);
  }
}

/**
 * Check if a value is a signal.
 */
export function isSignal(value: unknown): value is Signal<unknown> {
  return typeof value === "function" && (value as any)[SIGNAL_SYMBOL] === true;
}

/**
 * Check if a value is a computed signal.
 */
export function isComputed(value: unknown): value is ComputedSignal<unknown> {
  return typeof value === "function" && (value as any)[COMPUTED_SYMBOL] === true;
}

/**
 * Check if a value is an effect ref.
 */
export function isEffect(value: unknown): value is EffectRef {
  return value !== null && typeof value === "object" && (value as any)[EFFECT_SYMBOL] === true;
}

// ============================================================================
// COM State Signal
// ============================================================================

export const COM_SIGNAL_SYMBOL = Symbol.for("agentick.comSignal");

/**
 * Creates a signal bound to COM state.
 * Changes sync bidirectionally between signal and COM.
 *
 * @internal Used by comState() after COM is available
 */
export function createCOMStateSignal<T>(
  ctx: {
    getState: (key: string) => T | undefined;
    setState: (key: string, value: unknown) => void;
    on: (event: any, handler: (...args: any[]) => void) => any;
    off?: (event: any, handler: (...args: any[]) => void) => any;
  },
  key: string,
  initialValue?: T,
): Signal<T | undefined> {
  const sig = signal<T | undefined>(ctx.getState(key) ?? initialValue);

  // Flag to prevent circular updates
  let isUpdatingFromCOM = false;

  // Listen for COM state changes from other sources
  const handler = (changedKey: string, value: unknown) => {
    if (changedKey === key && !isUpdatingFromCOM) {
      isUpdatingFromCOM = true;
      try {
        // Update signal without triggering our own setter logic
        const internalSet = sig.set;
        internalSet(value as T);

        // AUTOMATIC RECOMPILATION: If COM state changes during render phase,
        // request recompile to ensure consistency across sibling components
        // BUT: Skip in phases where recompile is unnecessary
        if (isCompilerRendering() && !shouldSkipRecompile()) {
          const compiler = getActiveCompiler();
          if (compiler) {
            const ctxObj = ctx as any;
            if (ctxObj.requestRecompile) {
              ctxObj.requestRecompile(`comState '${key}' changed during render`);
            }
          }
        }
      } finally {
        isUpdatingFromCOM = false;
      }
    }
  };

  ctx.on("state:changed", handler);

  // Override set to also update COM
  const originalSet = sig.set;
  sig.set = (value) => {
    if (isUpdatingFromCOM) {
      originalSet.call(sig, value);
      return;
    }

    const currentValue = sig();
    const nextValue =
      typeof value === "function"
        ? (value as (prev: T | undefined) => T | undefined)(currentValue)
        : value;

    // Bailout if value hasn't changed
    if (Object.is(currentValue, nextValue)) {
      return;
    }

    // DEV WARNING: Setting comState during render
    if (process.env["NODE_ENV"] === "development" && isCompilerRendering()) {
      console.warn(
        `[Agentick] comState '${key}' is being set during render phase.\n` +
          `This may cause sibling components to see stale data in the current iteration.\n` +
          `Consider updating state in lifecycle methods (onTickStart, onMount) instead.\n` +
          `An automatic recompile will be triggered to ensure consistency.`,
      );
    }

    // Update COM first (will trigger handler, but flag prevents circular)
    isUpdatingFromCOM = true;
    try {
      ctx.setState(key, nextValue);
    } finally {
      isUpdatingFromCOM = false;
    }

    // Then update signal
    originalSet.call(sig, nextValue);

    // AUTOMATIC RECOMPILATION: Request recompile after state change
    // This ensures useComState behaves like useState for triggering re-renders
    // BUT: Skip recompile in certain phases where it's unnecessary:
    // - tickStart: Render is about to happen anyway
    // - tickEnd: Current tick is done, next tick will see the update
    // - complete: Execution is complete, no more renders
    // - unmount: Component is being removed
    // - render (class onMount): Class component onMount runs during render, before render() is called
    //
    // ALLOW recompile in:
    // - mount (useOnMount): Function component useOnMount runs after first render, can trigger recompile
    if (!shouldSkipRecompile()) {
      const ctxObj = ctx as any;
      if (ctxObj.requestRecompile) {
        ctxObj.requestRecompile(`comState '${key}' updated`);
      }
    }
  };

  // Override dispose to cleanup COM listener
  const originalDispose = sig.dispose!;
  sig.dispose = () => {
    if (ctx.off) {
      ctx.off("state:changed", handler);
    }
    originalDispose.call(sig);
  };

  // Mark as COM signal
  (sig as any)[COM_SIGNAL_SYMBOL] = key;

  return sig;
}

export const WATCH_SIGNAL_SYMBOL = Symbol.for("agentick.watchSignal");
export const PROPS_SIGNAL_SYMBOL = Symbol.for("agentick.propsSignal");
export const REQUIRED_INPUT_SYMBOL = Symbol.for("agentick.requiredInput");

/**
 * Creates a read-only signal that watches COM state.
 * The signal updates when COM state changes, but cannot modify it.
 *
 * @internal Used by watchComState() and watch()
 */
export function createReadonlyCOMStateSignal<T>(
  ctx: {
    getState: (key: string) => T | undefined;
    on: (event: any, handler: (...args: any[]) => void) => any;
    off?: (event: any, handler: (...args: any[]) => void) => any;
  },
  key: string,
  defaultValue?: T,
): ReadonlySignal<T | undefined> {
  let value: T | undefined = ctx.getState(key) ?? defaultValue;
  let isDisposed = false;

  // Listen for COM state changes
  const handler = (changedKey: string, newValue: unknown) => {
    if (changedKey === key && !isDisposed) {
      value = newValue as T;
      // Notify any computed/effects that depend on this
      scheduleEffect(() => {}); // Force reactivity check

      // AUTOMATIC RECOMPILATION: If watched COM state changes during render,
      // request recompile to ensure consistency across sibling components
      // BUT: Skip in phases where recompile is unnecessary
      if (isCompilerRendering() && !shouldSkipRecompile()) {
        const compiler = getActiveCompiler();
        if (compiler) {
          const ctxObj = ctx as any;
          if (ctxObj.requestRecompile) {
            ctxObj.requestRecompile(`watched comState '${key}' changed during render`);
          }
        }
      }
    }
  };

  ctx.on("state:changed", handler);

  const getter = (): T | undefined => {
    if (isDisposed) return value;

    // Track as dependency if inside computed/effect
    const context = getCurrentTrackingContext();
    if (context) {
      // Create a virtual subscription for tracking
      context.onDependency({
        _subscribe: (notify: () => void) => ({
          notify,
          dispose: () => {},
        }),
      } as any);
    }

    return value;
  };

  const dispose = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    if (ctx.off) {
      ctx.off("state:changed", handler);
    }
  };

  const readonlySignal: ReadonlySignal<T | undefined> = Object.assign(getter, {
    dispose,
    get value() {
      return getter();
    },
    get disposed() {
      return isDisposed;
    },
  });

  // Mark for cleanup detection
  (readonlySignal as any)[WATCH_SIGNAL_SYMBOL] = key;

  return readonlySignal;
}
