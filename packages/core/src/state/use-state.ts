/**
 * State management for EngineComponent.
 *
 * Two layers of state:
 * 1. `signal()` - Component-local state (not shared)
 * 2. `comState()` - COM state (shared across components, persisted)
 *
 * **Important:** Signals only work in class components (`EngineComponent`).
 * They do NOT work in pure function components because function components
 * are re-executed on every render, which would create new signals each time.
 *
 * @example
 * ```typescript
 * // ✅ Correct - use EngineComponent for stateful components
 * class MyComponent extends Component {
 *   // Component-local state
 *   private count = signal(0);
 *
 *   // COM state (shared, auto-bound to COM in onMount)
 *   private timeline = comState<COMTimelineEntry[]>('timeline', []);
 *
 *   onTickStart(com, state) {
 *     this.timeline.update(t => [...t, ...state.current.timeline]);
 *   }
 *
 *   render() {
 *     return <Timeline>{this.timeline().map(...)}</Timeline>;
 *   }
 * }
 *
 * // ❌ Wrong - signals don't work in function components
 * function BadComponent(props) {
 *   const count = signal(0);  // Creates new signal every render!
 *   return <div>{count()}</div>;
 * }
 * ```
 *
 * @see docs/state-management.md for full documentation
 */

import {
  signal,
  createCOMStateSignal,
  createReadonlyCOMStateSignal,
  COM_SIGNAL_SYMBOL,
  WATCH_SIGNAL_SYMBOL,
  PROPS_SIGNAL_SYMBOL,
  SIGNAL_SYMBOL,
  COMPUTED_SYMBOL,
  EFFECT_SYMBOL,
  type Signal,
  type ReadonlySignal,
} from "./signal";
import type { COM } from "../com/object-model";

/**
 * Creates a COM-bound signal (shared state).
 *
 * COM state is:
 * - Shared across all components
 * - Persisted across ticks
 * - Synced bidirectionally with COM
 *
 * The signal is automatically bound to COM in `onMount`.
 * Before binding, it works as a local signal with the initial value.
 *
 * @param key The COM state key
 * @param initialValue Initial value if COM state doesn't exist
 *
 * @example
 * ```typescript
 * class TimelineComponent extends Component {
 *   // Declared as property - auto-bound in onMount
 *   private timeline = comState<COMTimelineEntry[]>('timeline', []);
 *
 *   onTickStart(com, state) {
 *     // Update signal - automatically syncs with COM
 *     this.timeline.update(t => [...t, ...state.current.timeline]);
 *   }
 *
 *   render() {
 *     // Read from signal
 *     return <Timeline>{this.timeline().map(...)}</Timeline>;
 *   }
 * }
 * ```
 */
export function comState<T>(key: string, initialValue: T): Signal<T> {
  // Create a placeholder signal that will be bound in onMount
  const sig = signal<T>(initialValue);

  // Mark as COM signal for auto-binding
  (sig as any)[COM_SIGNAL_SYMBOL] = key;

  return sig;
}

/**
 * Creates a read-only signal that watches COM state.
 *
 * Use this when you want to observe state that another component owns,
 * without being able to modify it. The signal updates automatically
 * when the COM state changes.
 *
 * @param key The COM state key to watch
 * @param defaultValue Default value if state doesn't exist
 *
 * @example
 * ```typescript
 * class ObserverComponent extends Component {
 *   // Watch timeline state owned by another component
 *   private timeline = watchComState<COMTimelineEntry[]>('timeline');
 *
 *   // Can create derived values
 *   private messageCount = computed(() => this.timeline()?.length ?? 0);
 *
 *   render() {
 *     // Can read
 *     return <div>Messages: {this.messageCount()}</div>;
 *
 *     // Cannot write - no .set() or .update()
 *     // this.timeline.set([...])  // ❌ Not available
 *   }
 * }
 * ```
 */
export function watchComState<T>(key: string, defaultValue?: T): ReadonlySignal<T | undefined> {
  // Create a placeholder that will be bound in onMount
  const placeholder = signal<T | undefined>(defaultValue);

  // Mark as watch signal for auto-binding
  (placeholder as any)[WATCH_SIGNAL_SYMBOL] = key;

  // Return as ReadonlySignal (hide .set and .update from type)
  return placeholder as unknown as ReadonlySignal<T | undefined>;
}

/**
 * Shorthand for watchComState - creates a read-only signal watching COM state.
 *
 * @param key The COM state key to watch
 * @param defaultValue Default value if state doesn't exist
 *
 * @example
 * ```typescript
 * class StatusComponent extends Component {
 *   // Watch state set by another component
 *   private status = watch<'idle' | 'loading' | 'done'>('status', 'idle');
 *
 *   render() {
 *     return <div>Status: {this.status()}</div>;
 *   }
 * }
 * ```
 */
export function watch<T>(key: string, defaultValue?: T): ReadonlySignal<T | undefined> {
  return watchComState(key, defaultValue);
}

/**
 * Creates a signal bound to a component prop.
 *
 * The prop key is inferred from the property name, but can be overridden via config.
 * The compiler automatically detects these signals and updates them when props change.
 *
 * Props signals are readonly from the component's perspective - only the compiler can update them.
 *
 * **Important:** Use explicit props interfaces with `Component<P>` for type checking.
 * Required vs optional props are determined by your props interface.
 *
 * @param initialValue Optional default value if prop is not provided
 * @param config Optional configuration
 * @param config.key Override the inferred prop key (use when JSX prop name differs from property name)
 *
 * @example
 * ```typescript
 * interface MyComponentProps {
 *   title?: string;      // Optional prop
 *   count?: number;      // Optional prop
 *   name: string;        // Required prop
 * }
 *
 * class MyComponent extends Component<MyComponentProps> {
 *   // All use input() - required/optional comes from props interface
 *   title = input<string>();
 *   count = input<number>(0);
 *   name = input<string>('');  // Required because props interface says so
 *
 *   render() {
 *     return <div>{this.title()}: {this.count()}</div>;
 *   }
 * }
 * ```
 *
 * @example JSX usage
 * ```tsx
 * <MyComponent name="World" />  // ✅ name is required
 * <MyComponent />  // ❌ Error: name is required (from props interface)
 * ```
 */
export function input<T>(
  initialValue?: T,
  config?: { key?: string },
): ReadonlySignal<T | undefined> {
  // Create placeholder signal (will be bound by compiler)
  const sig = signal<T | undefined>(initialValue);

  // Mark as props signal for compiler detection
  // The actual prop key will be determined by compiler based on property name
  // or the config.key override
  (sig as any)[PROPS_SIGNAL_SYMBOL] = config?.key ?? true; // true = infer from property name

  // Return as ReadonlySignal (components can't write, compiler can)
  return sig as ReadonlySignal<T | undefined>;
}

/**
 * Binds all COM signals on a component instance.
 * Called automatically in EngineComponent.onMount().
 *
 * Finds all properties marked with COM_SIGNAL_SYMBOL or WATCH_SIGNAL_SYMBOL
 * and replaces them with signals bound to the actual COM state.
 */
export function bindCOMSignals(instance: any, com: COM): void {
  const signalsToCleanup: any[] = [];

  const bindProperty = (propKey: string | symbol, value: any) => {
    // Handle writable COM signals
    if (value && typeof value === "function" && (value as any)[COM_SIGNAL_SYMBOL]) {
      const comKey = (value as any)[COM_SIGNAL_SYMBOL];
      const currentValue = value();

      // Dispose the placeholder signal
      if (value.dispose) {
        value.dispose();
      }

      // Replace with COM-bound signal
      const boundSignal = createCOMStateSignal(com as any, comKey, currentValue);
      instance[propKey] = boundSignal;
      signalsToCleanup.push(boundSignal);
      return;
    }

    // Handle read-only watch signals
    if (value && typeof value === "function" && (value as any)[WATCH_SIGNAL_SYMBOL]) {
      const comKey = (value as any)[WATCH_SIGNAL_SYMBOL];
      const currentValue = value();

      // Dispose the placeholder signal
      if (value.dispose) {
        value.dispose();
      }

      // Replace with read-only COM-bound signal
      const boundSignal = createReadonlyCOMStateSignal(com as any, comKey, currentValue);
      instance[propKey] = boundSignal;
      signalsToCleanup.push(boundSignal);
    }
  };

  // Find all properties marked as COM signals (string keys)
  for (const key of Object.getOwnPropertyNames(instance)) {
    bindProperty(key, instance[key]);
  }

  // Also check symbol properties (for private fields with symbols)
  const symbols = Object.getOwnPropertySymbols(instance);
  for (const sym of symbols) {
    bindProperty(sym, instance[sym]);
  }

  // Store signals for cleanup
  if (!instance._comSignals) {
    instance._comSignals = [];
  }
  instance._comSignals.push(...signalsToCleanup);
}

/**
 * Check if a value is a reactive primitive (signal, computed, effect, comState, or watch).
 */
function isReactivePrimitive(value: any): boolean {
  if (!value) return false;

  return (
    (value as any)[SIGNAL_SYMBOL] === true ||
    (value as any)[COMPUTED_SYMBOL] === true ||
    (value as any)[EFFECT_SYMBOL] === true ||
    (value as any)[COM_SIGNAL_SYMBOL] !== undefined ||
    (value as any)[WATCH_SIGNAL_SYMBOL] !== undefined ||
    (value as any)[PROPS_SIGNAL_SYMBOL] !== undefined
  );
}

/**
 * Cleans up all signals on a component instance.
 * Called automatically in EngineComponent.onUnmount().
 *
 * Disposes all reactive primitives to prevent memory leaks:
 * - signal() - clears subscribers
 * - comState() - removes COM event listener, clears subscribers
 * - watchComState() / watch() - removes COM event listener
 * - computed() - unsubscribes from dependencies, clears subscribers
 * - effect() - unsubscribes from dependencies, runs cleanup function
 */
export function cleanupSignals(instance: any): void {
  // Track what we've disposed to avoid double-dispose
  const disposed = new Set<any>();

  const tryDispose = (value: any) => {
    if (value && typeof value.dispose === "function" && !disposed.has(value)) {
      if (isReactivePrimitive(value)) {
        disposed.add(value);
        value.dispose();
      }
    }
  };

  // Cleanup COM signals first (tracked separately)
  if (instance._comSignals) {
    for (const sig of instance._comSignals) {
      tryDispose(sig);
    }
    instance._comSignals = [];
  }

  // Cleanup any reactive primitives on the instance (string keys)
  for (const key of Object.getOwnPropertyNames(instance)) {
    const value = instance[key];
    // Signals/computeds are functions, effects are objects
    if (value && (typeof value === "function" || typeof value === "object")) {
      tryDispose(value);
    }
  }

  // Also check symbol properties (for private fields)
  const symbols = Object.getOwnPropertySymbols(instance);
  for (const sym of symbols) {
    const value = instance[sym];
    if (value && (typeof value === "function" || typeof value === "object")) {
      tryDispose(value);
    }
  }
}

/**
 * Manually dispose a single signal.
 * Use when you need to clean up a signal before component unmount.
 *
 * @example
 * ```typescript
 * class MyComponent extends Component {
 *   private tempData = signal<Data | null>(null);
 *
 *   async loadData() {
 *     this.tempData.set(await fetchData());
 *   }
 *
 *   clearData() {
 *     // Dispose signal before component unmounts
 *     disposeSignal(this.tempData);
 *     this.tempData = signal(null); // Create fresh signal if needed
 *   }
 * }
 * ```
 */
export function disposeSignal(sig: Signal<any>): void {
  if (sig && typeof sig.dispose === "function") {
    sig.dispose();
  }
}
