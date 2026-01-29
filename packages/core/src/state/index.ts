/**
 * # Tentickle State
 *
 * Reactive state management for Tentickle components. Provides a signals-based
 * system similar to SolidJS/Angular signals with fine-grained reactivity.
 *
 * ## Features
 *
 * - **Signals** - Reactive primitives for fine-grained state updates
 * - **Computed** - Derived values that auto-recompute when dependencies change
 * - **Effects** - Side-effects that re-run on dependency changes
 * - **COM State** - Shared state bound to Context Object Model
 * - **Batching** - Multiple updates trigger effects only once
 *
 * ## Quick Start
 *
 * ```typescript
 * import { signal, computed, effect, batch } from 'tentickle';
 *
 * // Create a signal
 * const count = signal(0);
 *
 * // Read and write
 * console.log(count.value); // 0
 * count.value = 1;
 *
 * // Computed values
 * const doubled = computed(() => count.value * 2);
 * console.log(doubled.value); // 2
 *
 * // Effects run on changes
 * effect(() => {
 *   console.log(`Count is: ${count.value}`);
 * });
 *
 * // Batch multiple updates
 * batch(() => {
 *   count.value = 2;
 *   count.value = 3;
 * }); // Effect runs once with value 3
 * ```
 *
 * ## In Components
 *
 * ```tsx
 * class Counter extends Component {
 *   count = signal(0);
 *
 *   onMount() {
 *     effect(() => {
 *       console.log(`Count: ${this.count.value}`);
 *     });
 *   }
 *
 *   render() {
 *     return <User>Current count: {this.count.value}</User>;
 *   }
 * }
 * ```
 *
 * @see {@link signal} - Create reactive state
 * @see {@link computed} - Create derived values
 * @see {@link effect} - Create side-effects
 *
 * @module tentickle/state
 */

// Core signal primitives
export * from "./use-state";
export * from "./signal";
export * from "./hooks";
export * from "./context";
export * from "./boundary";
