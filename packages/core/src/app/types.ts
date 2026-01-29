/**
 * Mark II App Types
 *
 * Essential type definitions for the createApp API.
 *
 * Design principles:
 * - All sessions are persistent sessions
 * - Ephemeral execution = create session → send → close immediately
 * - Session is an EventEmitter that emits streaming events
 * - Props are inputs, SendResult is output
 *
 * @module tentickle/app
 */

import type { EventEmitter } from "node:events";
import type {
  Message,
  StreamEvent as SharedStreamEvent,
  ToolCall,
  ToolResult,
  UsageStats,
  ContentBlock,
  TimelineEntry,
} from "@tentickle/shared";
import type { COMInput } from "../com/types";
import type { ExecutableTool } from "../tool/tool";
import type { MCPConfig } from "../mcp";
import type { ModelInstance } from "../model/model";
import type { ExecutionHandle, Channel, Procedure } from "../core/index.js";
import type { JSX } from "../jsx/jsx-runtime";
import type { Signal } from "../state/signal";
import type { SchedulerState } from "../compiler/scheduler";

// ============================================================================
// Lifecycle Callbacks
// ============================================================================

/**
 * Lifecycle callbacks for session execution.
 *
 * These provide a cleaner alternative to event listeners for common
 * lifecycle events. Callbacks defined on AppOptions are inherited by
 * all sessions; callbacks on SessionOptions override or supplement them.
 *
 * @example
 * ```typescript
 * const app = createApp(MyAgent, {
 *   model,
 *   onTickStart: (tick) => console.log(`Tick ${tick} starting`),
 *   onComplete: (result) => console.log(`Done: ${result.response}`),
 * });
 *
 * // Session can add its own callbacks
 * const session = app.createSession({
 *   onEvent: (event) => { ... }, // Receives all events
 * });
 * ```
 */
export interface LifecycleCallbacks {
  /**
   * Called for every stream event.
   * Use this for fine-grained event handling.
   */
  onEvent?: (event: StreamEvent) => void;

  /**
   * Called when a tick starts.
   * @param tick - The tick number (1-indexed)
   * @param executionId - The execution ID
   */
  onTickStart?: (tick: number, executionId: string) => void;

  /**
   * Called when a tick ends.
   * @param tick - The tick number
   * @param usage - Token usage for this tick
   */
  onTickEnd?: (tick: number, usage?: UsageStats) => void;

  /**
   * Called when execution completes successfully.
   * @param result - The final result
   */
  onComplete?: (result: SendResult) => void;

  /**
   * Called when an error occurs during execution.
   * @param error - The error that occurred
   */
  onError?: (error: Error) => void;
}

// ============================================================================
// App Options (passed to createApp)
// ============================================================================

/**
 * Configuration options for creating an App instance.
 *
 * AppOptions configure the execution environment - things that apply
 * across all sessions created from this app.
 */
export interface AppOptions extends LifecycleCallbacks {
  /**
   * Override model from JSX (for testing/mocking).
   * If not provided, uses the model from <Model> component in JSX tree.
   */
  model?: ModelInstance;

  /**
   * Additional tools to make available.
   * These are merged with tools from <Tool> components in JSX.
   */
  tools?: ExecutableTool[];

  /**
   * MCP server configurations.
   */
  mcpServers?: Record<string, MCPConfig>;

  /**
   * Maximum number of ticks before stopping execution.
   * @default 10
   */
  maxTicks?: number;

  /**
   * App-level abort signal.
   * All sessions will respect this signal.
   */
  signal?: AbortSignal;

  /**
   * Callback for tool confirmation.
   * Called when a tool with requiresConfirmation is invoked.
   * Return true to allow, false to deny.
   */
  onToolConfirmation?: (call: ToolCall, message: string) => Promise<boolean>;

  /**
   * Whether to inherit middleware and telemetry from the global Tentickle instance.
   *
   * When true (default), the app inherits:
   * - Middleware registered via `Tentickle.use('*', mw)`, `Tentickle.use('tool:*', mw)`, etc.
   * - Telemetry provider from `Tentickle.telemetryProvider`
   *
   * Set to false for isolated apps (useful in testing).
   *
   * @default true
   *
   * @example
   * ```typescript
   * // App inherits Tentickle defaults (default behavior)
   * const app = createApp(MyAgent, { model });
   *
   * // Isolated app - no Tentickle middleware
   * const testApp = createApp(TestAgent, { model, inheritDefaults: false });
   * ```
   */
  inheritDefaults?: boolean;
}

// ============================================================================
// Recording Mode (needed by SessionOptions)
// ============================================================================

/**
 * Recording mode for debugging and replay.
 *
 * - 'full': Capture everything (fiber tree, COM, model I/O). Best for development.
 * - 'lightweight': Only COM output and model I/O. Good for production debugging.
 * - 'none': No recording (default). Minimal overhead.
 */
export type RecordingMode = "full" | "lightweight" | "none";

// ============================================================================
// Session Options (passed to createSession or run/stream)
// ============================================================================

/**
 * Options for creating or configuring a session.
 *
 * SessionOptions are specific to a particular session instance -
 * things like state to hydrate, per-session limits, etc.
 *
 * Lifecycle callbacks from AppOptions are inherited; SessionOptions
 * callbacks will override them.
 */
export interface SessionOptions extends LifecycleCallbacks {
  /**
   * Maximum number of ticks for this session.
   * Overrides AppOptions.maxTicks.
   */
  maxTicks?: number;

  /**
   * Per-session abort signal.
   */
  signal?: AbortSignal;

  /**
   * Initial timeline entries to hydrate the conversation history.
   *
   * Use this to load an existing conversation when creating a session.
   * These entries will be available via `useConversationHistory()` and
   * rendered by `<Timeline />` on tick 1 and beyond.
   *
   * @example
   * ```typescript
   * const session = app.createSession({
   *   initialTimeline: loadedConversation.entries,
   * });
   * ```
   */
  initialTimeline?: TimelineEntry[];

  /**
   * Initial state to hydrate (for resuming sessions).
   * @future Phase 3 serialization
   */
  snapshot?: SessionSnapshot;

  /**
   * Recording mode for time-travel debugging.
   *
   * - 'full': Capture everything (fiber tree, COM, model I/O). Best for development.
   * - 'lightweight': Only COM output and model I/O. Good for production debugging.
   * - 'none': No recording (default). Minimal overhead.
   *
   * @example
   * ```typescript
   * // Enable full recording for debugging
   * const session = app.createSession({ recording: 'full' });
   *
   * // After execution, get the recording
   * const recording = session.getRecording();
   * ```
   */
  recording?: RecordingMode;

  /**
   * Enable DevTools event emission.
   *
   * When true, lifecycle events (execution_start, tick_start, tick_end,
   * execution_end, fiber_snapshot) are emitted to the DevTools emitter.
   *
   * @default false
   *
   * @example
   * ```typescript
   * // Enable DevTools for debugging
   * const session = app.createSession({ devTools: true });
   * ```
   */
  devTools?: boolean;
}

/**
 * Per-execution overrides for a single tick/send.
 */
export interface ExecutionOptions {
  /** Override maxTicks for this execution */
  maxTicks?: number;
  /** Per-execution abort signal */
  signal?: AbortSignal;
}

/**
 * Serialized session state for persistence/resumption.
 */
export interface SessionSnapshot {
  /** Session version for compatibility */
  version: string;
  /** Tick number at snapshot time */
  tick: number;
  /** Serialized conversation/timeline */
  timeline: unknown;
  /** Serialized component state (hooks) */
  componentState: unknown;
  /** Accumulated usage stats across all sends */
  usage?: UsageStats;
  /** Timestamp of snapshot */
  timestamp: number;
}

// ============================================================================
// Run Options - Per-execution overrides
// ============================================================================

/**
 * Options for a single run/stream execution.
 *
 * @deprecated Use SessionOptions instead. RunOptions exists for
 * backward compatibility with the legacy run()/stream() API.
 */
export interface RunOptions {
  /** Override maxTicks for this execution */
  maxTicks?: number;

  /** Per-execution abort signal */
  signal?: AbortSignal;
}

/**
 * User input for legacy run/stream API.
 *
 * @deprecated The props-based send() API is preferred.
 */
export type UserInput = Message | ContentBlock[] | string;

// ============================================================================
// App Input - Structured input for app.run() and app.stream()
// ============================================================================

/**
 * Input for app.run() and app.stream().
 *
 * Separates concerns cleanly:
 * - `props`: Component props (passed to the component function)
 * - `messages`: Current turn messages (queued before first tick)
 * - `history`: Previous conversation history (hydrates timeline)
 * - `options`: Session options (maxTicks, signal, etc.)
 *
 * @example
 * ```typescript
 * // Simple case
 * const result = await app.run({
 *   props: { system: "You are helpful" },
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 * });
 *
 * // With history and options
 * const result = await app.run({
 *   props: { system: "You are helpful" },
 *   messages: [{ role: "user", content: [{ type: "text", text: "Follow up" }] }],
 *   history: previousConversation.entries,
 *   options: { maxTicks: 5 },
 * });
 * ```
 */
export interface AppInput<P = Record<string, unknown>> {
  /**
   * Props passed to the component function.
   */
  props?: P;

  /**
   * Messages to include in the first tick.
   *
   * These are queued before the first compile, making them available
   * via `useQueuedMessages()` and automatically added to the timeline.
   */
  messages?: Message[];

  /**
   * Previous conversation history to hydrate.
   *
   * These become the initial timeline entries, available via
   * `useConversationHistory()` and rendered by `<Timeline />`.
   */
  history?: TimelineEntry[];

  /**
   * Session options (maxTicks, signal, etc.)
   */
  options?: Omit<SessionOptions, "initialTimeline">;
}

// ============================================================================
// Send Result - Output from session.tick()
// ============================================================================

/**
 * Result from session.tick() with structured outputs.
 *
 * This is the primary output interface. Props go in, SendResult comes out.
 *
 * @example
 * ```typescript
 * const session = app.createSession();
 * const result = await session.tick({ messages: [...], context: 'Be concise' });
 *
 * console.log(result.response);        // Model's text response
 * console.log(result.outputs.decide);  // Structured data from OUTPUT tool
 * ```
 */
export interface SendResult {
  /**
   * The model's text response (concatenated from all assistant messages).
   */
  response: string;

  /**
   * Structured outputs from OUTPUT-type tools, keyed by tool name.
   * When a tool has executionType="OUTPUT", its data appears here
   * instead of being sent back to the model as a tool_result.
   */
  outputs: Record<string, unknown>;

  /**
   * Token usage and execution statistics.
   */
  usage: UsageStats;

  /**
   * Reason execution stopped.
   */
  stopReason?: string;

  /**
   * Raw compiled output (for advanced use cases).
   */
  raw: COMInput;
}

/**
 * Result of a legacy run() execution.
 *
 * @deprecated Use SendResult from session.tick() instead.
 */
export interface RunResult {
  /**
   * Final compiled output.
   */
  output: COMInput;

  /**
   * Token usage and execution statistics.
   */
  usage: UsageStats;

  /**
   * Reason execution stopped.
   */
  stopReason?: string;
}

// ============================================================================
// Stream Events
// ============================================================================

/**
 * Events emitted during streaming execution.
 */
export type StreamEvent = SharedStreamEvent;


// ============================================================================
// Session Execution Handle - For mid-execution interaction
// ============================================================================

/**
 * Handle for interacting with a running session execution.
 *
 * SessionExecutionHandle wraps the kernel's ExecutionHandle with session-specific
 * methods using explicit delegation. This is the return type of session.send()
 * and session.tick().
 *
 * The handle is both PromiseLike and AsyncIterable:
 * - `await handle` → resolves to SendResult
 * - `for await (const event of handle)` → streams StreamEvent
 *
 * @example
 * ```typescript
 * // Call send() - returns handle immediately
 * const handle = session.send({ messages: [...] });
 *
 * // Stream events
 * for await (const event of handle) {
 *   if (event.type === 'content_delta') {
 *     process.stdout.write(event.delta);
 *   }
 * }
 *
 * // Or just await for result
 * const result = await handle;
 * console.log(result.response);
 *
 * // Mid-execution interaction
 * handle.queueMessage({ role: "user", content: [...] });
 * handle.abort("User cancelled");
 * ```
 */
export interface SessionExecutionHandle extends ExecutionHandle<SendResult, StreamEvent> {
  /** The session ID */
  readonly sessionId: string;

  /** Current tick number */
  readonly currentTick: number;

  /**
   * Queue a message during execution.
   * Delivered to onMessage hooks if running, queued for next tick otherwise.
   */
  queueMessage(message: Message): void;

  /**
   * Submit a tool confirmation result.
   * Used when a tool requires user confirmation.
   */
  submitToolResult(toolUseId: string, result: ToolResult): void;
}

/**
 * @deprecated Use SessionExecutionHandle instead.
 */
export type SessionHandle = SessionExecutionHandle;

/**
 * @deprecated Use SessionExecutionHandle instead.
 */
export type AppExecutionHandle = SessionExecutionHandle;

// ============================================================================
// Session - Persistent execution context
// ============================================================================

/**
 * Session status.
 */
export type SessionStatus = "idle" | "running" | "closed";

/**
 * Execution phase during a tick.
 */
export type ExecutionPhase = "compile" | "model" | "tools" | "ingest";

/**
 * Hook type identifier for inspection.
 */
export type HookType =
  | "useState"
  | "useReducer"
  | "useEffect"
  | "useLayoutEffect"
  | "useMemo"
  | "useCallback"
  | "useRef"
  | "useSignal"
  | "useComputed"
  | "useContext"
  | "useOnMessage"
  | "useQueuedMessages";

/**
 * Result of session.inspect() - live session state for debugging.
 *
 * Combines live data (status, queued messages) with snapshot data
 * (last output, model output) and aggregates (total usage).
 *
 * @example
 * ```typescript
 * const session = app.createSession();
 * await session.tick({ query: "Hello!" });
 *
 * const info = session.inspect();
 * console.log('Status:', info.status);
 * console.log('Tick:', info.currentTick);
 * console.log('Tokens used:', info.totalUsage.totalTokens);
 * console.log('Components:', info.components.names);
 * ```
 */
export interface SessionInspection {
  // ═══════════════════════════════════════════════════════════════
  // IDENTITY (static)
  // ═══════════════════════════════════════════════════════════════
  /** Session ID */
  id: string;

  // ═══════════════════════════════════════════════════════════════
  // LIVE STATUS (changes in real-time)
  // ═══════════════════════════════════════════════════════════════
  /** Current session status */
  status: SessionStatus;

  /** Current tick number */
  currentTick: number;

  /** Messages queued for the next tick */
  queuedMessages: Message[];

  /** If running, what phase of the tick loop? */
  currentPhase?: ExecutionPhase;

  /** Whether the session has been aborted */
  isAborted: boolean;

  // ═══════════════════════════════════════════════════════════════
  // FROM LATEST TICK (updated after each tick completes)
  // ═══════════════════════════════════════════════════════════════
  /** Last compiled COM output */
  lastOutput: COMInput | null;

  /** Last model response */
  lastModelOutput: {
    content: ContentBlock[];
    stopReason: string;
  } | null;

  /** Tool calls from last tick */
  lastToolCalls: ToolCall[];

  /** Tool results from last tick */
  lastToolResults: {
    toolUseId: string;
    name: string;
    success: boolean;
  }[];

  // ═══════════════════════════════════════════════════════════════
  // AGGREGATES (accumulated over session lifetime)
  // ═══════════════════════════════════════════════════════════════
  /** Total token usage across all ticks */
  totalUsage: UsageStats;

  /** Number of completed ticks */
  tickCount: number;

  // ═══════════════════════════════════════════════════════════════
  // COMPONENT SUMMARY (from fiber tree)
  // ═══════════════════════════════════════════════════════════════
  /** Component tree summary */
  components: {
    /** Number of mounted components */
    count: number;
    /** Unique component names in the tree */
    names: string[];
  };

  /** Hook usage summary */
  hooks: {
    /** Total number of hooks */
    count: number;
    /** Hook count by type */
    byType: Partial<Record<HookType, number>>;
  };
}

// ============================================================================
// Tick Snapshots - Time-travel debugging and recording
// ============================================================================

/**
 * Serialized error for JSON transport/storage.
 */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/**
 * Serialized hook state for snapshots.
 */
export interface SerializedHookState {
  /** Hook index in the component */
  index: number;
  /** Hook type */
  type: HookType;
  /** JSON-serializable hook value */
  value: unknown;
  /** Dependencies (for effects/memos) */
  deps?: unknown[];
  /** Effect status */
  status?: "pending" | "mounted" | "cleanup";
  /** Number of signal subscribers (for useSignal) */
  subscribers?: number;
}

/**
 * Serialized fiber node for snapshots.
 *
 * Captures the component tree structure including props and hook states.
 */
export interface SerializedFiberNode {
  /** Unique fiber ID */
  id: string;
  /** Component name or 'host' for primitive elements */
  type: string;
  /** React key */
  key: string | null;
  /** JSON-safe props (functions/symbols removed) */
  props: Record<string, unknown>;
  /** Hook states for this component */
  hooks: SerializedHookState[];
  /** Child fibers */
  children: SerializedFiberNode[];
  /** Human-readable summary for display (varies by component type) */
  _summary?: string;
  /** Debug information */
  _debug?: {
    /** Source file location if available */
    source?: string;
    /** Number of times this component has rendered */
    renderCount?: number;
  };
}

/**
 * Tool definition as captured in snapshot (minimal, JSON-safe).
 */
export interface SnapshotToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * TickSnapshot captures everything about a single tick.
 *
 * This is the atomic unit for time-travel debugging, replay, and DevTools.
 *
 * @example
 * ```typescript
 * // Enable recording when creating session
 * const session = app.createSession({ recording: 'full' });
 *
 * // After some ticks...
 * const recording = session.getRecording();
 * const snapshot = recording?.snapshots[2]; // Tick 3's snapshot
 *
 * console.log(snapshot.model.output.content); // What the model said
 * console.log(snapshot.tools.calls);          // What tools were called
 * console.log(snapshot.fiber.summary);        // Component tree stats
 * ```
 */
export interface TickSnapshot {
  // ═══════════════════════════════════════════════════════════════
  // IDENTITY
  // ═══════════════════════════════════════════════════════════════
  /** Session ID this snapshot belongs to */
  sessionId: string;
  /** Tick number (1-indexed) */
  tick: number;
  /** ISO 8601 timestamp when tick completed */
  timestamp: string;
  /** Duration of the tick in milliseconds */
  duration: number;

  // ═══════════════════════════════════════════════════════════════
  // FIBER TREE STATE (only in 'full' mode)
  // ═══════════════════════════════════════════════════════════════
  /** Fiber tree state (component tree structure and hooks) */
  fiber: {
    /** Serialized fiber tree (null in 'lightweight' mode) */
    tree: SerializedFiberNode | null;
    /** Summary statistics (always present) */
    summary: {
      componentCount: number;
      hookCount: number;
      hooksByType: Partial<Record<HookType, number>>;
    };
  };

  // ═══════════════════════════════════════════════════════════════
  // COM STATE
  // ═══════════════════════════════════════════════════════════════
  /** Compiled output (what the model "sees") */
  com: {
    /** System sections */
    sections: Record<string, { content: string; priority?: number }>;
    /** Conversation timeline */
    timeline: TimelineEntry[];
    /** Available tools */
    tools: SnapshotToolDefinition[];
    /** Model ID being used */
    modelId: string | null;
    /** Metadata */
    metadata: Record<string, unknown>;
  };

  // ═══════════════════════════════════════════════════════════════
  // MODEL INTERACTION
  // ═══════════════════════════════════════════════════════════════
  /** Model input and output for this tick */
  model: {
    /** What was sent to the model */
    input: {
      /** Formatted prompt (may be truncated for large prompts) */
      formatted: string;
      /** Token count if available */
      tokenCount?: number;
    };
    /** What the model returned */
    output: {
      /** Response content blocks */
      content: ContentBlock[];
      /** Why the model stopped */
      stopReason: string;
      /** Output token count */
      tokenCount?: number;
    };
    /** Time spent waiting for model response (ms) */
    latency: number;
  };

  // ═══════════════════════════════════════════════════════════════
  // TOOL EXECUTION
  // ═══════════════════════════════════════════════════════════════
  /** Tool calls and results from this tick */
  tools: {
    /** Tool calls made by the model */
    calls: ToolCall[];
    /** Results from tool execution */
    results: Array<{
      toolUseId: string;
      name: string;
      success: boolean;
      /** Result content (may be truncated) */
      content: unknown;
      /** Execution time (ms) */
      duration?: number;
    }>;
    /** Total time spent executing tools (ms) */
    totalDuration: number;
  };

  // ═══════════════════════════════════════════════════════════════
  // EXECUTION STATE
  // ═══════════════════════════════════════════════════════════════
  /** Execution state at end of tick */
  execution: {
    /** Phase when snapshot was taken */
    phase: "complete";
    /** Should the tick loop continue? */
    shouldContinue: boolean;
    /** Reason for stopping (if applicable) */
    stopReason?: string;
    /** Messages queued during this tick */
    queuedMessages: Message[];
    /** Error if tick failed */
    error?: SerializedError;
    /** Execution ID from ALS context (for DevTools linking) */
    executionId?: string;
  };
}

/**
 * Input recorded for session replay.
 */
export interface RecordedInput {
  /** Which tick received this input */
  tick: number;
  /** When the input was received */
  timestamp: string;
  /** The message */
  message: Message;
  /** How the message was added */
  source: "initial" | "queued" | "send";
}

/**
 * SessionRecording is the complete history of a session.
 *
 * Contains all tick snapshots and metadata for replay/forking.
 *
 * @example
 * ```typescript
 * const session = app.createSession({ recording: 'full' });
 * await session.tick({ query: "Hello!" });
 * await session.tick({ query: "Tell me more" });
 *
 * const recording = session.getRecording();
 * console.log(recording.summary.tickCount);        // 2
 * console.log(recording.summary.totalUsage);       // Token usage
 * console.log(recording.snapshots[0].model.output); // First response
 * ```
 */
export interface SessionRecording {
  // ═══════════════════════════════════════════════════════════════
  // IDENTITY
  // ═══════════════════════════════════════════════════════════════
  /** Session ID */
  sessionId: string;
  /** When recording started */
  startedAt: string;
  /** When recording ended (if session closed) */
  endedAt?: string;

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  /** How the session was created */
  config: {
    /** Component name */
    componentName: string;
    /** Initial props (first tick) */
    initialProps: Record<string, unknown>;
    /** Max ticks setting */
    maxTicks: number;
    /** Recording mode */
    mode: RecordingMode;
  };

  // ═══════════════════════════════════════════════════════════════
  // INPUTS
  // ═══════════════════════════════════════════════════════════════
  /** All inputs during the session */
  inputs: RecordedInput[];

  // ═══════════════════════════════════════════════════════════════
  // SNAPSHOTS
  // ═══════════════════════════════════════════════════════════════
  /** Tick-by-tick history */
  snapshots: TickSnapshot[];

  // ═══════════════════════════════════════════════════════════════
  // AGGREGATES
  // ═══════════════════════════════════════════════════════════════
  /** Summary statistics */
  summary: {
    /** Number of ticks completed */
    tickCount: number;
    /** Total session duration (ms) */
    totalDuration: number;
    /** Total token usage */
    totalUsage: UsageStats;
    /** How the session ended */
    finalStatus: "completed" | "aborted" | "error" | "max_ticks" | "running";
    /** Final stop reason */
    finalStopReason?: string;
  };
}

/**
 * A persistent session for multi-turn conversations.
 *
 * Session is an EventEmitter that emits StreamEvent during execution.
 * Use session.events() to convert to an AsyncIterable.
 *
 * @example
 * ```typescript
 * const session = app.createSession();
 *
 * // Listen to events via EventEmitter
 * session.on('event', (event) => console.log(event));
 *
 * // Or convert to AsyncIterable
 * for await (const event of session.events()) {
 *   console.log(event);
 * }
 *
 * // Run with props, get result
 * const result = await session.tick({ query: "Hello!" });
 * console.log(result.response);
 *
 * // Session maintains state between ticks
 * const result2 = await session.tick({ query: "Follow up" });
 *
 * // Queue messages for next tick
 * session.queueMessage({ role: "user", content: [...] });
 *
 * // Interrupt running execution
 * session.interrupt({ role: "user", content: [...] }, "user_interrupt");
 *
 * // Clean up when done
 * session.close();
 * ```
 */
export interface Session<P = Record<string, unknown>> extends EventEmitter {
  /** Unique session ID */
  readonly id: string;

  /** Current session status */
  readonly status: SessionStatus;

  /** Current tick number */
  readonly currentTick: number;

  /** Whether the session has been aborted */
  readonly isAborted: boolean;

  /** Messages queued for the next tick (read-only view) */
  readonly queuedMessages: readonly Message[];

  /**
   * Observable scheduler state for DevTools.
   *
   * Returns a Signal containing the scheduler's current state,
   * including status, pending reasons, and reconciliation metrics.
   *
   * Returns null if the session hasn't been initialized yet.
   */
  readonly schedulerState: Signal<SchedulerState> | null;

  /**
   * Queue a message to be included in the next tick.
   *
   * Queues the message and notifies onMessage hooks if components are mounted.
   * Does NOT trigger execution - use send() if you want to trigger tick().
   *
   * This is a procedure (without execution boundary) so you can use:
   * - `session.queue.withContext({ userId }).exec(message)`
   * - `session.queue.use(middleware).exec(message)`
   */
  queue: Procedure<(message: Message) => Promise<void>, true>;

  /**
   * Send messages and/or update props.
   *
   * Returns SessionExecutionHandle which is PromiseLike + AsyncIterable:
   * - `await handle` → SendResult when execution completes
   * - `for await (const event of handle)` → stream events
   *
   * Concurrent calls return THE SAME handle - messages queue, handle resolves
   * when the tick loop settles.
   *
   * @example
   * ```typescript
   * // Get handle immediately, stream events
   * const handle = session.send({ messages: [...] });
   * for await (const event of handle) {
   *   console.log(event);
   * }
   *
   * // Or just await
   * const result = await session.send({ messages: [...] });
   * ```
   */
  send(input: {
    messages?: Message[];
    message?: Message;
    props?: P;
    metadata?: Record<string, unknown>;
    /** Per-execution abort signal for this send/tick */
    signal?: AbortSignal;
  }): SessionExecutionHandle;

  /**
   * Run the component with props, execute tick loop.
   *
   * Returns SessionExecutionHandle which is PromiseLike + AsyncIterable.
   * If already running, returns the existing handle (hot-update support).
   *
   * Note: If called with no props (or empty props) and no queued messages, returns an
   * empty handle and does not run a tick.
   *
   * @example
   * ```typescript
   * const handle = session.tick(props);
   * handle.queueMessage({ role: "user", content: [...] });
   * const result = await handle;
   * ```
   */
  tick(props: P, options?: ExecutionOptions): SessionExecutionHandle;

  /**
   * Queue a message to be included in the next tick.
   *
   * @deprecated Use queue instead
   */
  queueMessage(message: Message): Promise<void>;

  /**
   * Send a message to the session.
   *
   * @deprecated Use send instead
   */
  sendMessage(message: Message | Message[], props?: P): Promise<void>;

  /**
   * Interrupt the current execution, optionally with a message.
   *
   * If the session is running:
   * 1. Aborts the current execution
   * 2. Queues the message (if provided)
   *
   * If the session is idle:
   * 1. Queues the message (if provided)
   *
   * @param message - Optional message to queue
   * @param reason - Optional abort reason
   */
  interrupt(message?: Message, reason?: string): void;

  /**
   * Clear the aborted state flag, allowing the session to continue.
   */
  clearAbort(): void;

  /**
   * Convert EventEmitter to AsyncIterable for the current/next execution.
   *
   * Call this before send() to capture events as an AsyncIterable.
   * The iterable completes when the execution finishes.
   */
  events(): AsyncIterable<StreamEvent>;

  /**
   * Export session state for persistence.
   * @future Phase 3 serialization
   */
  snapshot(): SessionSnapshot;

  /**
   * Inspect the current session state for debugging.
   *
   * Returns a snapshot of live status, last outputs, aggregated usage,
   * and component/hook summaries. Useful for DevTools integration and
   * debugging mid-execution.
   *
   * @example
   * ```typescript
   * const session = app.createSession();
   * await session.tick({ query: "Hello!" });
   *
   * const info = session.inspect();
   * console.log('Tick:', info.currentTick);
   * console.log('Components:', info.components.names);
   * console.log('Total tokens:', info.totalUsage.totalTokens);
   * ```
   */
  inspect(): SessionInspection;

  // ═══════════════════════════════════════════════════════════════
  // RECORDING (time-travel debugging)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start recording tick snapshots.
   *
   * If already recording, changes the mode.
   *
   * @param mode - Recording mode ('full' or 'lightweight')
   *
   * @example
   * ```typescript
   * const session = app.createSession();
   * session.startRecording('full');
   * await session.tick({ query: "Hello!" });
   * const recording = session.getRecording();
   * ```
   */
  startRecording(mode: RecordingMode): void;

  /**
   * Stop recording tick snapshots.
   *
   * The recording is preserved and can still be retrieved with getRecording().
   */
  stopRecording(): void;

  /**
   * Get the session recording.
   *
   * Returns null if recording was never started.
   *
   * @example
   * ```typescript
   * const session = app.createSession({ recording: 'full' });
   * await session.tick({ query: "Hello!" });
   *
   * const recording = session.getRecording();
   * console.log(recording?.snapshots.length); // 1
   * console.log(recording?.summary.totalUsage);
   * ```
   */
  getRecording(): SessionRecording | null;

  /**
   * Get a specific tick's snapshot.
   *
   * @param tick - Tick number (1-indexed)
   * @returns The snapshot, or null if not found or recording not enabled
   *
   * @example
   * ```typescript
   * const snapshot = session.getSnapshotAt(2);
   * if (snapshot) {
   *   console.log(snapshot.model.output.content);
   *   console.log(snapshot.tools.calls);
   * }
   * ```
   */
  getSnapshotAt(tick: number): TickSnapshot | null;

  // ═══════════════════════════════════════════════════════════════
  // CHANNELS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get a named channel for pub/sub communication.
   *
   * Channels allow external code to communicate with running components
   * and vice versa. Components can subscribe to channels using useChannel().
   *
   * Built-in channels:
   * - 'messages': Message queue updates
   * - 'tool_confirmation': Tool confirmation requests/responses
   *
   * @param name - Channel name
   * @returns The channel instance
   *
   * @example
   * ```typescript
   * // External code publishes to session
   * session.channel('custom').publish({ action: 'refresh' });
   *
   * // Component subscribes
   * const channel = useChannel('custom');
   * useEffect(() => channel.subscribe(handleEvent), []);
   * ```
   */
  channel(name: string): Channel;

  /**
   * Close the session and release resources.
   */
  close(): void;
}

// ============================================================================
// App - The reusable app instance
// ============================================================================

/**
 * Component function type for createApp.
 */
export type ComponentFunction<P = Record<string, unknown>> = (props: P) => JSX.Element;

/**
 * A reusable app instance created by createApp().
 *
 * All sessions are persistent sessions internally. Ephemeral execution
 * (run/stream) creates a session, sends once, then closes immediately.
 *
 * @example
 * ```typescript
 * const MyAgent = ({ query, context }) => (
 *   <>
 *     <System>You are helpful. {context}</System>
 *     <Timeline />
 *     <User>{query}</User>
 *   </>
 * );
 *
 * const app = createApp(MyAgent, { model });
 *
 * // Ephemeral: create → send → close
 * const result = await app.run({ query: "Hello!", context: "Be concise" });
 *
 * // Streaming ephemeral
 * for await (const event of app.stream({ query: "Hello!" })) {
 *   console.log(event);
 * }
 *
 * // Persistent session
 * const session = app.createSession();
 * await session.tick({ query: "Hello!" });
 * await session.tick({ query: "Follow up" });
 * session.close();
 * ```
 */
export interface App<P = Record<string, unknown>> {
  /**
   * Run the app with input.
   *
   * Returns SessionExecutionHandle which is both:
   * - PromiseLike: `await app.run(input)` → SendResult
   * - AsyncIterable: `for await (const event of app.run(input))` → StreamEvent
   *
   * Creates an ephemeral session internally (create → run → close).
   *
   * @example Await result
   * ```typescript
   * const result = await app.run({
   *   props: { system: "You are helpful" },
   *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
   * });
   * console.log(result.response);
   * ```
   *
   * @example Stream events
   * ```typescript
   * for await (const event of app.run({
   *   props: { system: "You are helpful" },
   *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
   * })) {
   *   if (event.type === 'content_delta') {
   *     process.stdout.write(event.delta);
   *   }
   * }
   * ```
   *
   * @example Use handle for control
   * ```typescript
   * const handle = app.run({ messages });
   * handle.queueMessage({ role: "user", content: [...] });
   * const result = await handle;
   * ```
   */
  run: Procedure<(input: AppInput<P>) => SessionExecutionHandle, true>;

  /**
   * Create a persistent session for multi-turn conversations.
   *
   * @example
   * ```typescript
   * const session = app.createSession();
   * await session.tick({ query: "Hello!" });
   * await session.tick({ query: "Follow up" });
   * session.close();
   * ```
   */
  createSession(options?: SessionOptions): Session<P>;
}
