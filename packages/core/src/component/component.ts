import type { COMInput, COMOutput } from "../com/types";
import type { COM } from "../com/object-model";
import type { JSX } from "../jsx/jsx-runtime";
import type { StopReason, UsageStats } from "@tentickle/shared";
import type { ExecutableTool } from "../tool/tool";
import {
  type ComponentHookMiddleware,
  type ComponentHookName,
  ComponentHookRegistry,
} from "./component-hooks";
import type { ChannelService } from "../channels";
import { type CompiledStructure } from "../compiler/types";
import type { ExecutionMessage } from "../engine/execution-types";

/**
 * Stop reason information for components to react to.
 */
export interface StopReasonInfo {
  /**
   * The stop reason code (from StopReason enum or custom string).
   */
  reason: string | StopReason;

  /**
   * Human-readable description of why execution stopped.
   */
  description?: string;

  /**
   * Whether this stop reason allows for recovery/retry.
   */
  recoverable?: boolean;

  /**
   * Additional metadata about the stop reason.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Error information for components to react to.
 */
export interface EngineError {
  /**
   * The error that occurred.
   */
  error: Error;

  /**
   * Phase where the error occurred.
   */
  phase:
    | "render"
    | "model_execution"
    | "tool_execution"
    | "tick_start"
    | "tick_end"
    | "complete"
    | "unknown";

  /**
   * Additional context about the error.
   */
  context?: Record<string, unknown>;

  /**
   * Whether this error is recoverable.
   */
  recoverable?: boolean;
}

/**
 * Recovery action that components can return from onError.
 */
export interface RecoveryAction {
  /**
   * Whether to continue execution after recovery.
   */
  continue: boolean;

  /**
   * Optional message to add to the timeline explaining the recovery.
   */
  recoveryMessage?: string;

  /**
   * Optional modifications to make to the COM before continuing.
   */
  modifications?: (ctx: COM) => void | Promise<void>;
}

export interface TickState {
  /**
   * Current tick number (1-indexed).
   */
  tick: number;

  /**
   * The COMInput from the previous tick (what was sent to model.fromEngineState).
   * This is the compiled state that was passed to the model.
   */
  previous?: COMInput;

  /**
   * The COMOutput from the last tick (what was produced by model execution and tool execution).
   * Contains new timeline entries, tool calls, and tool results.
   *
   * On tick 1, before model execution, this contains userInput (timeline, sections)
   * to allow components to render purely from previous + current.
   */
  current?: COMOutput;

  /**
   * Stop reason information from the last model execution.
   * Components can use this to handle graceful recovery, retries, etc.
   */
  stopReason?: StopReasonInfo;

  /**
   * Token usage from the last model execution.
   * Contains inputTokens, outputTokens, totalTokens, and optional reasoning/cache tokens.
   */
  usage?: UsageStats;

  /**
   * Error information if an error occurred during execution.
   * Components can use this to handle errors and potentially recover.
   */
  error?: EngineError;

  /**
   * Signal the engine to stop execution after this tick.
   * @param reason The reason for stopping.
   */
  stop: (reason: string) => void;

  /**
   * Messages queued since the last tick.
   *
   * Messages are delivered immediately to onMessage hooks when they arrive,
   * then queued here for availability during render. This allows components
   * to access all messages received since the last tick in their render logic.
   *
   * The queue is cleared after each tick completes.
   */
  queuedMessages: ExecutionMessage[];

  /**
   * Channel service for bidirectional communication (optional).
   * Components can publish/subscribe to channels for UI integration.
   */
  channels?: ChannelService;
}

/**
 * Context provided to onAfterCompile hook.
 * Contains metadata about the current compilation iteration.
 */
export interface AfterCompileContext {
  /**
   * Current compilation iteration (0-indexed).
   */
  iteration: number;

  /**
   * Maximum allowed iterations before forced stabilization.
   */
  maxIterations: number;
}

export interface EngineComponent {
  name?: string;

  /**
   * The channels declaration for the component.
   * Components can declare channels to publish and subscribe to.
   */
  // channels?: ChannelsDeclaration;

  tool?: ExecutableTool;

  /**
   * Called when the component is mounted to the engine.
   * Use this to register static resources like tools.
   * @param ctx The persistent Context Object Model for this execution.
   */
  onMount?: (ctx: COM) => Promise<void> | void;

  /**
   * Called when the component is unmounted from the engine.
   * @param ctx The persistent Context Object Model for this execution.
   */
  onUnmount?: (ctx: COM) => Promise<void> | void;

  /**
   * Called once before the first tick, after the COM is created.
   * Use this for initialization that needs to happen before execution starts.
   * @param ctx The persistent Context Object Model for this execution.
   */
  onStart?: (ctx: COM) => Promise<void> | void;

  onTickStart?: (ctx: COM, state: TickState) => Promise<void> | void;

  /**
   * Declaratively render context for the current tick.
   * Components should interact with the COM to compose the context.
   * OR return a Virtual DOM tree (JSX.Element) to be rendered by the Engine.
   * @param ctx The persistent Context Object Model for this execution.
   * @param state Current tick state including input and previous render.
   */
  render?: (
    ctx: COM,
    state: TickState,
  ) => Promise<void | JSX.Element | null> | void | JSX.Element | null;

  /**
   * Called after each compilation pass, before the final render is applied.
   * Use this to inspect the compiled structure and potentially request re-compilation
   * if state changes are needed (e.g., context summarization, tool adjustments).
   *
   * The compilation loop continues until no component calls `ctx.requestRecompile()`
   * or the maximum iteration limit is reached.
   *
   * @param ctx The persistent Context Object Model for this execution.
   * @param compiled The compiled structure from this compilation pass.
   * @param state Current tick state.
   * @param afterCompileCtx Context containing iteration metadata.
   */
  onAfterCompile?: (
    ctx: COM,
    compiled: CompiledStructure,
    state: TickState,
    afterCompileCtx: AfterCompileContext,
  ) => Promise<void> | void;

  /**
   * Called after model execution completes for this tick.
   * At this point, current is available (contains model outputs from this tick).
   * Use this for per-tick processing, validation, or side effects.
   * Note: Model outputs are automatically included in the next tick's previous.
   * @param ctx The persistent Context Object Model for this execution.
   * @param state Current tick state including previous and current.
   */
  onTickEnd?: (ctx: COM, state: TickState) => Promise<void> | void;

  /**
   * Called after the entire execution completes (all ticks finished).
   * At this point, the final COMInput is available.
   * Use this for final state processing, persistence, reporting, side effects, etc.
   * Called before onUnmount.
   *
   * Note: This is for side effects only, not rendering. Rendering should happen in render().
   * Model outputs are automatically included in the final COM state.
   * @param ctx The persistent Context Object Model for this execution.
   * @param finalState The final COMInput state after all ticks.
   */
  onComplete?: (ctx: COM, finalState: COMInput) => Promise<void> | void;

  /**
   * Called immediately when a message is sent to the running execution.
   *
   * Messages can arrive via:
   * - RuntimeSession.sendMessage() - Direct programmatic injection
   * - ExecutionHandle.send() - Via handle reference
   * - Channel events with type='message' - From client
   *
   * This hook is called immediately when the message arrives, not at tick boundaries.
   * Use ctx.abort() to interrupt execution if needed, or update state for the next tick.
   * Messages are also available in TickState.queuedMessages during render.
   *
   * @param ctx The persistent Context Object Model for this execution.
   * @param message The message sent to the execution.
   * @param state Current tick state.
   *
   * @example
   * ```typescript
   * class InteractiveAgent extends Component {
   *   onMessage(ctx, message, state) {
   *     if (message.type === 'stop') {
   *       ctx.abort('User requested stop');
   *     } else if (message.type === 'feedback') {
   *       ctx.setState('userFeedback', message.content);
   *     }
   *   }
   * }
   * ```
   */
  onMessage?: (ctx: COM, message: ExecutionMessage, state: TickState) => Promise<void> | void;

  /**
   * Called when an error occurs during engine execution.
   * Components can use this to handle errors and potentially recover.
   *
   * @param ctx The persistent Context Object Model for this execution.
   * @param state Current tick state including error information.
   * @returns RecoveryAction to indicate whether to continue execution, or void/undefined to let error propagate
   */
  onError?: (ctx: COM, state: TickState) => Promise<RecoveryAction | void> | RecoveryAction | void;
}

export type ComponentClass = new (props?: any) => EngineComponent;
export type ComponentFactory = (props?: any) => EngineComponent | Promise<EngineComponent>;
// Pure function component: React-style (props only) or Engine-style (props, ctx, state)
export type PureFunctionComponent<P = any> =
  | ((props: P) => JSX.Element | null)
  | ((props: P, ctx: COM, state: TickState) => JSX.Element | null);
// A ComponentDefinition can be an instance, a class, a factory, a pure function, or a Virtual Element
export type ComponentDefinition =
  | EngineComponent
  | ComponentClass
  | ComponentFactory
  | PureFunctionComponent
  | JSX.Element;

/**
 * Base class for Stateful Components
 */
export abstract class Component<P = {}, S = {}> implements EngineComponent {
  static hooks: Record<string, ComponentHookMiddleware<any>[]> = {};
  static tags: string[] = [];

  private hooksRegistry: ComponentHookRegistry;

  get hooks(): ComponentHookRegistry {
    return this.hooksRegistry;
  }

  props: P;
  state: S;

  constructor(props: P = {} as P) {
    this.hooksRegistry = new ComponentHookRegistry();
    this.registerStaticHooks();
    this.props = props;
    this.state = {} as S;
  }

  private registerStaticHooks(): void {
    const componentClass = this.constructor as typeof Component;
    const staticHooks = componentClass.hooks;

    if (!staticHooks) {
      return;
    }

    for (const [hookName, middleware] of Object.entries(staticHooks)) {
      if (middleware && Array.isArray(middleware)) {
        for (const mw of middleware) {
          this.hooksRegistry.register(
            hookName as ComponentHookName,
            mw as ComponentHookMiddleware<ComponentHookName>,
          );
        }
      }
    }
  }

  // Default implementations - all optional
  // Note: Signal binding and ref handling are now done automatically by the compiler.
  // Components can override onMount/onUnmount for custom logic, but don't need to
  // call super.onMount()/super.onUnmount() for basic signal/ref handling.
  onMount(_ctx: COM) {
    // Override for custom mount logic
    // Signal binding and ref handling are handled automatically by the compiler
  }

  onUnmount(_ctx: COM) {
    // Override for custom unmount logic
    // Signal cleanup and ref removal are handled automatically by the compiler
  }
  onStart(_ctx: COM) {}
  onTickStart(_ctx: COM, _state: TickState) {}
  onAfterCompile(
    _ctx: COM,
    _compiled: CompiledStructure,
    _state: TickState,
    _afterCompileCtx: AfterCompileContext,
  ) {}
  onTickEnd(_ctx: COM, _state: TickState) {}
  onComplete(_ctx: COM, _finalState: COMInput): void {}
  onError(_ctx: COM, _state: TickState): RecoveryAction | void {
    // Default: let error propagate (no recovery)
    return undefined;
  }

  onMessage(_ctx: COM, _message: ExecutionMessage, _state: TickState): void | Promise<void> {
    // Override to handle messages sent to the execution
  }

  // Render is optional - components can just manage state or provide side effects
  render(
    _ctx: COM,
    _state: TickState,
  ): Promise<void | JSX.Element | null> | void | JSX.Element | null {
    return null;
  }
}

export interface OnMount {
  onMount: (ctx: COM) => Promise<void> | void;
}

export interface OnUnmount {
  onUnmount: (ctx: COM) => Promise<void> | void;
}

export interface OnStart {
  onStart: (ctx: COM) => Promise<void> | void;
}

export interface OnTickStart {
  onTickStart: (ctx: COM, state: TickState) => Promise<void> | void;
}

export interface OnAfterCompile {
  onAfterCompile: (
    ctx: COM,
    compiled: CompiledStructure,
    state: TickState,
    afterCompileCtx: AfterCompileContext,
  ) => Promise<void> | void;
}

export interface OnTickEnd {
  onTickEnd: (ctx: COM, state: TickState) => Promise<void> | void;
}

export interface OnComplete {
  onComplete: (ctx: COM, finalState: COMInput) => Promise<void> | void;
}

export interface OnError {
  onError: (ctx: COM, state: TickState) => Promise<RecoveryAction | void> | RecoveryAction | void;
}

export interface OnMessage {
  onMessage: (ctx: COM, message: ExecutionMessage, state: TickState) => Promise<void> | void;
}

export interface Render {
  render: (
    ctx: COM,
    state: TickState,
  ) => Promise<void | JSX.Element | null> | void | JSX.Element | null;
}

export interface ComponentLifecycleHooks {
  onMount?: OnMount;
  onUnmount?: OnUnmount;
  onStart?: OnStart;
  onTickStart?: OnTickStart;
  onAfterCompile?: OnAfterCompile;
  onTickEnd?: OnTickEnd;
  onMessage?: OnMessage;
  onComplete?: OnComplete;
  onError?: OnError;
  render?: Render;
}
