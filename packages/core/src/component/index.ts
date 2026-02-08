/**
 * # Agentick Components
 *
 * Base component system for Agentick agents. Provides class-based components
 * with lifecycle hooks, signals, and render methods.
 *
 * ## Features
 *
 * - **Lifecycle Hooks** - onMount, onUnmount, onTickStart, onTickEnd
 * - **Signals** - Reactive state within components
 * - **Render Method** - JSX output for each tick
 *
 * ## Quick Start
 *
 * ```tsx
 * import { Component } from 'agentick';
 *
 * class MyAgent extends Component {
 *   count = signal(0);
 *
 *   onMount() {
 *     console.log('Agent mounted');
 *   }
 *
 *   onTickStart(ctx, state) {
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
 * @module agentick/component
 */

export * from "./component";
export * from "./component-hooks";
