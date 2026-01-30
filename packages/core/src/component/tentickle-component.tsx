/**
 * TentickleComponent - React.Component base class for Tentickle
 *
 * Extends React.Component to work seamlessly with the reconciler while providing
 * access to Tentickle-specific features like COM, TickState, and lifecycle hooks.
 *
 * @example
 * ```tsx
 * class MyAgent extends TentickleComponent {
 *   onTickStart() {
 *     console.log(`Tick ${this.tickState.tick} starting`);
 *   }
 *
 *   render() {
 *     const history = this.tickState.previous?.timeline ?? [];
 *     return (
 *       <>
 *         <Section id="system" audience="model">
 *           You are a helpful assistant.
 *         </Section>
 *         {history.map((entry, i) => (
 *           <Message key={i} {...entry.message} />
 *         ))}
 *       </>
 *     );
 *   }
 * }
 * ```
 */

import React, { type ReactNode } from "react";
import type { COM } from "../com/object-model";
import type { TickState } from "../hooks/types";
import type { COMInput } from "../com/types";
import type { CompiledStructure } from "../compiler/types";
import type { ExecutionMessage } from "../engine/execution-types";
import type { RecoveryAction, AfterCompileContext } from "./component";
import { COMContext, TickStateContext } from "../hooks/context-internal";

// ============================================================================
// Context Consumer Wrapper
// ============================================================================

/**
 * Internal context values provided to TentickleComponent.
 */
interface TentickleContextValues {
  com: COM | null;
  tickState: TickState | null;
}

/**
 * Props for the internal wrapper component.
 */
interface WrapperProps<P extends object> {
  componentClass: new (props: P) => TentickleComponent<P>;
  props: P;
  children?: ReactNode;
}

/**
 * Internal wrapper that consumes contexts and passes them to the component.
 */
function TentickleComponentWrapper<P extends object>({
  componentClass: ComponentClass,
  props,
}: WrapperProps<P>): React.ReactElement | null {
  return (
    <COMContext.Consumer>
      {(com) => (
        <TickStateContext.Consumer>
          {(tickState) => {
            // Create instance with context values
            const instance = new ComponentClass(props);
            instance._setContextValues({ com, tickState });
            return instance._renderWithLifecycle();
          }}
        </TickStateContext.Consumer>
      )}
    </COMContext.Consumer>
  );
}

// ============================================================================
// TentickleComponent Base Class
// ============================================================================

/**
 * Props type that TentickleComponent accepts.
 */
export interface TentickleComponentProps {
  children?: ReactNode;
}

/**
 * Base class for class-based Tentickle components.
 *
 * Extends React.Component and provides:
 * - Access to COM via `this.com`
 * - Access to TickState via `this.tickState`
 * - Tentickle lifecycle methods (onMount, onTickStart, etc.)
 *
 * @example
 * ```tsx
 * class TaskAgent extends TentickleComponent<{ maxTasks?: number }> {
 *   onMount() {
 *     console.log('Agent mounted');
 *   }
 *
 *   onTickStart() {
 *     console.log(`Starting tick ${this.tickState.tick}`);
 *   }
 *
 *   render() {
 *     return (
 *       <Section id="system" audience="model">
 *         You can manage up to {this.props.maxTasks ?? 10} tasks.
 *       </Section>
 *     );
 *   }
 * }
 *
 * // Usage
 * <TaskAgent maxTasks={5} />
 * ```
 */
export abstract class TentickleComponent<P extends object = {}, S = {}> extends React.Component<
  P & TentickleComponentProps,
  S
> {
  // Context values (set by wrapper)
  private _com: COM | null = null;
  private _tickState: TickState | null = null;
  private _mounted = false;
  private _lastTick = -1;

  /**
   * Access the Context Object Model.
   * Provides access to timeline, sections, tools, state, and more.
   */
  protected get com(): COM {
    if (!this._com) {
      throw new Error(
        "COM not available. TentickleComponent must be used within a Tentickle execution context.",
      );
    }
    return this._com;
  }

  /**
   * Access the current tick state.
   * Provides tick number, previous output, current output, and stop control.
   */
  protected get tickState(): TickState {
    if (!this._tickState) {
      throw new Error(
        "TickState not available. TentickleComponent must be used within a Tentickle execution context.",
      );
    }
    return this._tickState;
  }

  /**
   * Shortcut to get the previous timeline (conversation history).
   */
  protected get history() {
    return this.tickState.previous?.timeline ?? [];
  }

  /**
   * Shortcut to get the current tick number.
   */
  protected get tick(): number {
    return this.tickState.tick;
  }

  /**
   * Internal: Set context values from wrapper.
   */
  _setContextValues(values: TentickleContextValues): void {
    this._com = values.com;
    this._tickState = values.tickState;
  }

  /**
   * Internal: Render with lifecycle management.
   */
  _renderWithLifecycle(): React.ReactElement | null {
    // Handle mount
    if (!this._mounted) {
      this._mounted = true;
      this.onMount?.();
    }

    // Handle tick start (only once per tick)
    const currentTick = this._tickState?.tick ?? 0;
    if (currentTick !== this._lastTick) {
      this._lastTick = currentTick;
      this.onTickStart?.();
    }

    // Call render
    const result = this.render();
    return result as React.ReactElement | null;
  }

  // ============================================================================
  // Lifecycle Methods (Override these)
  // ============================================================================

  /**
   * Called when the component is first mounted.
   * Use for initialization, registering tools, etc.
   */
  onMount?(): void | Promise<void>;

  /**
   * Called when the component is unmounted.
   * Use for cleanup.
   */
  onUnmount?(): void | Promise<void>;

  /**
   * Called at the start of each tick.
   * Use for per-tick initialization or state updates.
   */
  onTickStart?(): void | Promise<void>;

  /**
   * Called at the end of each tick.
   * Use for per-tick cleanup or side effects.
   */
  onTickEnd?(): void | Promise<void>;

  /**
   * Called after compilation, before model execution.
   * Use to inspect or modify the compiled structure.
   */
  onAfterCompile?(compiled: CompiledStructure, ctx: AfterCompileContext): void | Promise<void>;

  /**
   * Called when execution completes.
   * Use for final cleanup or persistence.
   */
  onComplete?(finalState: COMInput): void | Promise<void>;

  /**
   * Called when a message is received during execution.
   */
  onMessage?(message: ExecutionMessage): void | Promise<void>;

  /**
   * Called when an error occurs.
   * Return a RecoveryAction to handle the error.
   */
  onError?(): RecoveryAction | void;

  /**
   * Render the component's JSX output.
   * Override this to define your component's UI.
   */
  abstract render(): ReactNode;

  // ============================================================================
  // React Lifecycle Integration
  // ============================================================================

  componentWillUnmount(): void {
    this.onUnmount?.();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a functional component from a TentickleComponent class.
 *
 * This is needed because React's reconciler needs a function component
 * to consume contexts and create the class instance.
 *
 * @example
 * ```tsx
 * class MyAgent extends TentickleComponent {
 *   render() { return <Section id="system">Hello</Section>; }
 * }
 *
 * // Create the usable component
 * const MyAgentComponent = createClassComponent(MyAgent);
 *
 * // Use in JSX
 * <MyAgentComponent />
 * ```
 */
export function createClassComponent<P extends object>(
  ComponentClass: new (props: P) => TentickleComponent<P>,
): React.FC<P> {
  const WrappedComponent: React.FC<P> = (props: P) => {
    return <TentickleComponentWrapper componentClass={ComponentClass} props={props} />;
  };

  // Preserve the original class name for debugging
  WrappedComponent.displayName = ComponentClass.name || "TentickleComponent";

  return WrappedComponent;
}

// ============================================================================
// Exports
// ============================================================================

export type { TentickleContextValues, AfterCompileContext, RecoveryAction };
