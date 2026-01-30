/**
 * # Tentickle Components
 *
 * Base component system for Tentickle agents. Provides class-based components
 * with lifecycle hooks, signals, and render methods.
 *
 * ## Features
 *
 * - **Class Components** - Stateful components with lifecycle methods
 * - **Lifecycle Hooks** - onMount, onUnmount, onTickStart, onTickEnd
 * - **Signals** - Reactive state within components
 * - **Render Method** - JSX output for each tick
 *
 * ## Quick Start
 *
 * ```tsx
 * import { Component } from 'tentickle';
 *
 * class MyAgent extends Component {
 *   count = signal(0);
 *
 *   onMount() {
 *     console.log('Agent mounted');
 *   }
 *
 *   onTickStart(com, state) {
 *     this.count.value++;
 *   }
 *
 *   render() {
 *     return (
 *       <>
 *         <System>You are helpful.</System>
 *         <User>Count: {this.count.value}</User>
 *       </>
 *     );
 *   }
 * }
 * ```
 *
 * @see {@link Component} - Base component class
 * @see {@link ComponentLifecycleHooks} - Lifecycle hook interfaces
 *
 * @module tentickle/component
 */

export * from "./component";
export * from "./component-hooks";
export { TentickleComponent, createClassComponent } from "./tentickle-component";
export type { TentickleComponentProps, TentickleContextValues } from "./tentickle-component";
