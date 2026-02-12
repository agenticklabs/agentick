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
 * @module agentick/app
 */

import type { EventEmitter } from "node:events";
import type {
  Message,
  StreamEvent as SharedStreamEvent,
  ToolCall,
  ToolResult,
  UsageStats,
  TimelineEntry,
  SendInput as SharedSendInput,
  ContentBlock,
} from "@agentick/shared";
import type { COMInput, COMTimelineEntry } from "../com/types";
import type { ExecutableTool } from "../tool/tool";
import type { MCPConfig } from "../mcp";
import type { EngineModel } from "../model/model";
import type { ExecutionHandle, Channel, Procedure } from "@agentick/kernel";
import type { JSX } from "../jsx/jsx-runtime";
// Signal type removed - schedulerState now returns SchedulerState directly
import type { SchedulerState } from "../compiler/scheduler";
import type { SerializableCacheEntry } from "../hooks/runtime-context";

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
 * const session = app.session({
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
// Execution Runner
// ============================================================================

/**
 * Execution Runner
 *
 * Controls how a session's compiled context is consumed and how tool calls execute.
 * The default runner is the standard model→tool_use protocol.
 * Alternative runners (REPL, human-in-the-loop) transform the execution pattern.
 *
 * All methods are optional — omitted methods use default behavior.
 *
 * @example Custom REPL runner
 * ```typescript
 * const repl: ExecutionRunner = {
 *   name: "repl",
 *   transformCompiled(compiled, tools) {
 *     // Replace tool schemas with command descriptions
 *     return { ...compiled, tools: [] };
 *   },
 *   async executeToolCall(call, tool, next) {
 *     // Route to sandbox instead of direct execution
 *     return sandboxExecute(call);
 *   },
 * };
 *
 * const app = createApp(MyAgent, { model, runner: repl });
 * ```
 */
/**
 * Narrow session reference for runner hooks.
 *
 * Runner hooks receive this instead of the full Session interface.
 * This avoids generic type friction (SessionImpl<P> vs Session) and
 * exposes only what runners actually need: identity + state.
 */
export interface SessionRef {
  /** Unique session ID */
  readonly id: string;
  /** Current session status */
  readonly status: SessionStatus;
  /** Current tick number */
  readonly currentTick: number;
  /** Export session state */
  snapshot(): SessionSnapshot;
}

export interface ExecutionRunner {
  /** Runner identifier (e.g., "default", "repl") */
  name: string;

  /**
   * Transform the compiled structure before it reaches the model.
   *
   * Called per tick, after compilation but before the adapter's fromEngineState
   * flattens COMInput into model-specific format. This lets runners operate on
   * the rich semantic structure (system, timeline, sections, tools, ephemeral).
   *
   * Use cases:
   * - REPL: Replace tool schemas with command descriptions in a section,
   *   expose a single `execute` tool
   * - Filtering: Remove tools the model shouldn't see in this runner
   *
   * @param compiled - The COMInput from compilation (timeline, system, sections, tools, etc.)
   * @param tools - The resolved executable tools
   * @returns Transformed COMInput (or original if no transformation needed)
   */
  transformCompiled?(compiled: COMInput, tools: ExecutableTool[]): COMInput | Promise<COMInput>;

  /**
   * Wrap individual tool call execution.
   *
   * Called for each tool call. The `next` function executes the tool normally
   * (via ToolExecutor). Runners can intercept, transform, or replace execution.
   *
   * Use cases:
   * - REPL: Route `execute` tool to sandbox, run code with tools as callable functions
   * - Logging: Add runner-specific telemetry around tool execution
   * - Sandboxing: Run tools in isolated contexts
   *
   * @param call - The tool call from the model
   * @param tool - The resolved executable tool (undefined if not found)
   * @param next - Execute the tool normally (delegates to ToolExecutor)
   * @returns Tool result
   */
  executeToolCall?(
    call: ToolCall,
    tool: ExecutableTool | undefined,
    next: () => Promise<ToolResult>,
  ): Promise<ToolResult>;

  /**
   * Called once when the runner is first used by a session.
   * Set up per-session runner state (sandbox, working directory, etc.).
   */
  onSessionInit?(session: SessionRef): void | Promise<void>;

  /**
   * Called when a session snapshot is being created.
   * Runner can add its own state to the snapshot.
   */
  onPersist?(
    session: SessionRef,
    snapshot: SessionSnapshot,
  ): SessionSnapshot | Promise<SessionSnapshot>;

  /**
   * Called when a session is being restored from a snapshot.
   * Runner can restore its own state from the snapshot.
   */
  onRestore?(session: SessionRef, snapshot: SessionSnapshot): void | Promise<void>;

  /**
   * Called when a session is closed/destroyed.
   * Clean up runner resources (sandbox, temp files, etc.).
   */
  onDestroy?(session: SessionRef): void | Promise<void>;
}

// ============================================================================
// Session Store (for session persistence)
// ============================================================================

/**
 * Storage adapter for persisting session snapshots.
 *
 * Implement this interface to enable session persistence with your storage backend
 * (Redis, database, filesystem, etc.).
 *
 * @example In-memory implementation
 * ```typescript
 * class MemorySessionStore implements SessionStore {
 *   private store = new Map<string, SessionSnapshot>();
 *
 *   async save(sessionId: string, snapshot: SessionSnapshot) {
 *     this.store.set(sessionId, snapshot);
 *   }
 *
 *   async load(sessionId: string) {
 *     return this.store.get(sessionId) ?? null;
 *   }
 *
 *   async delete(sessionId: string) {
 *     this.store.delete(sessionId);
 *   }
 * }
 * ```
 *
 * @example Redis implementation
 * ```typescript
 * class RedisSessionStore implements SessionStore {
 *   constructor(private redis: Redis, private prefix = 'session:') {}
 *
 *   async save(sessionId: string, snapshot: SessionSnapshot) {
 *     await this.redis.set(
 *       this.prefix + sessionId,
 *       JSON.stringify(snapshot),
 *       'EX', 86400 // 24 hour TTL
 *     );
 *   }
 *
 *   async load(sessionId: string) {
 *     const data = await this.redis.get(this.prefix + sessionId);
 *     return data ? JSON.parse(data) : null;
 *   }
 *
 *   async delete(sessionId: string) {
 *     await this.redis.del(this.prefix + sessionId);
 *   }
 * }
 * ```
 */
export interface SessionStore {
  /**
   * Save a session snapshot to storage.
   * Called after each execution (auto-persist).
   */
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;

  /**
   * Load a session snapshot from storage.
   * Called when restoring a session via app.session(id).
   * Returns null if session not found.
   */
  load(sessionId: string): Promise<SessionSnapshot | null>;

  /**
   * Delete a session snapshot from storage.
   * Called when a session is permanently closed.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * List all persisted session IDs.
   * Optional - used for session discovery/management.
   */
  list?(): Promise<string[]>;

  /**
   * Check if a persisted session exists.
   * Optional - optimization to avoid full load when checking existence.
   */
  has?(sessionId: string): Promise<boolean>;
}

/**
 * Configuration for the built-in SQLite session store.
 */
export interface SqliteStoreConfig {
  type: "sqlite";
  /**
   * Path to SQLite database file.
   * Use ':memory:' for in-memory database (default).
   */
  path?: string;
  /**
   * Table name for storing sessions.
   * @default 'agentick_sessions'
   */
  table?: string;
}

/**
 * Store configuration options.
 *
 * Can be:
 * - A string file path for SQLite storage (e.g., './sessions.db')
 * - A SQLite config object with additional options
 * - A custom SessionStore implementation
 *
 * @example SQLite file path
 * ```typescript
 * store: './data/sessions.db'
 * ```
 *
 * @example In-memory SQLite (default)
 * ```typescript
 * store: ':memory:'
 * ```
 *
 * @example SQLite with options
 * ```typescript
 * store: { type: 'sqlite', path: './sessions.db', table: 'my_sessions' }
 * ```
 *
 * @example Custom store (Redis, Postgres, etc.)
 * ```typescript
 * store: new RedisSessionStore(redis)
 * ```
 */
export type StoreConfig = string | SqliteStoreConfig | SessionStore;

/**
 * Session management configuration.
 *
 * Controls how the App manages session lifecycles including
 * persistence, limits, and auto-cleanup.
 */
export interface SessionManagementOptions {
  /**
   * Storage adapter for session snapshots.
   *
   * Can be:
   * - A file path string for SQLite storage (e.g., './sessions.db')
   * - `':memory:'` for in-memory SQLite
   * - A `{ type: 'sqlite', ... }` config object
   * - A custom `SessionStore` implementation
   *
   * When configured, snapshots auto-save after each execution and
   * auto-restore on `app.session(id)`.
   *
   * @example File-based SQLite
   * ```typescript
   * sessions: { store: './data/sessions.db' }
   * ```
   *
   * @example Custom Redis store
   * ```typescript
   * sessions: { store: new RedisSessionStore(redis) }
   * ```
   */
  store?: StoreConfig;

  /**
   * Maximum number of active (in-memory) sessions.
   * When exceeded, the least-recently used session is evicted from memory.
   * Evicted sessions can be restored from store via `app.session(id)`.
   * @default unlimited
   */
  maxActive?: number;

  /**
   * Milliseconds of inactivity before evicting a session from memory.
   * Activity is tracked via send(), render(), queue(), and channel publish.
   * Set to 0 or undefined to disable idle eviction.
   */
  idleTimeout?: number;
}

// ============================================================================
// App Options (passed to createApp)
// ============================================================================

/**
 * Configuration options for creating an App instance.
 *
 * AppOptions configure the execution runner - things that apply
 * across all sessions created from this app.
 */
export interface AppOptions extends LifecycleCallbacks {
  /**
   * Override model from JSX (for testing/mocking).
   * If not provided, uses the model from <Model> component in JSX tree.
   */
  model?: EngineModel;

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
   * Execution runner for all sessions created by this app.
   *
   * Controls how compiled context reaches the model and how tool calls execute.
   * Default: standard model→tool_use protocol (no transformation).
   *
   * @example REPL runner
   * ```typescript
   * const app = createApp(MyAgent, {
   *   model,
   *   runner: replRunner({ sandbox: true }),
   * });
   * ```
   */
  runner?: ExecutionRunner;

  /**
   * Enable DevTools event emission for all sessions created by this app.
   *
   * When true, lifecycle events (execution_start, tick_start, tick_end,
   * execution_end, fiber_snapshot) are emitted to the DevTools emitter.
   *
   * @default false
   */
  devTools?: boolean;

  /**
   * App-level abort signal.
   * All sessions will respect this signal.
   */
  signal?: AbortSignal;

  /**
   * Session management configuration.
   *
   * Controls persistence, limits, and auto-cleanup of sessions.
   *
   * @example
   * ```typescript
   * const app = createApp(MyAgent, {
   *   sessions: {
   *     store: new RedisSessionStore(redis),
   *     maxActive: 100,
   *     idleTimeout: 5 * 60 * 1000, // 5 minutes
   *   },
   * });
   * ```
   */
  sessions?: SessionManagementOptions;

  /**
   * Called when a session is created.
   */
  onSessionCreate?: (session: Session) => void;

  /**
   * Called when a session is closed and removed from the registry.
   */
  onSessionClose?: (sessionId: string) => void;

  /**
   * Called before a session snapshot is persisted to store.
   *
   * Use this to:
   * - Cancel persistence (return false)
   * - Modify the snapshot before saving (return modified snapshot)
   *
   * @param session - The session being persisted
   * @param snapshot - The snapshot that will be saved
   * @returns false to cancel, modified snapshot, or void to proceed
   */
  onBeforePersist?: (
    session: Session,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;

  /**
   * Called after a session snapshot has been persisted.
   *
   * @param sessionId - The ID of the persisted session
   * @param snapshot - The snapshot that was saved
   */
  onAfterPersist?: (sessionId: string, snapshot: SessionSnapshot) => void | Promise<void>;

  /**
   * Called before a session is restored from storage.
   *
   * Use this to:
   * - Cancel restoration (return false)
   * - Migrate/transform old snapshot formats (return modified snapshot)
   *
   * @param sessionId - The ID of the session being restored
   * @param snapshot - The snapshot loaded from storage
   * @returns false to cancel, modified snapshot, or void to proceed
   */
  onBeforeRestore?: (
    sessionId: string,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;

  /**
   * Called after a session has been restored.
   *
   * @param session - The restored session
   * @param snapshot - The snapshot that was used
   */
  onAfterRestore?: (session: Session, snapshot: SessionSnapshot) => void | Promise<void>;

  /**
   * Called before send is executed.
   * Return a modified input to override what is sent.
   */
  onBeforeSend?: <P extends Record<string, unknown>>(
    session: Session<P>,
    input: SendInput<P>,
  ) => void | SendInput<P>;

  /**
   * Called after send completes successfully.
   */
  onAfterSend?: (session: Session, result: SendResult) => void;

  /**
   * Callback for tool confirmation.
   * Called when a tool with requiresConfirmation is invoked.
   * Return true to allow, false to deny.
   */
  onToolConfirmation?: (call: ToolCall, message: string) => Promise<boolean>;

  /**
   * Maximum timeline entries to keep in memory per session.
   * When exceeded, oldest entries are trimmed after each tick.
   * Default: unbounded.
   */
  maxTimelineEntries?: number;

  /**
   * Resolve configuration for loading data before session render.
   *
   * When a session is restored from a store, resolve functions receive
   * the snapshot as context. Results are available via `useResolved(key)`.
   *
   * When resolve is set, snapshots are NOT auto-applied on restore —
   * the resolve function controls reconstruction (Layer 2).
   */
  resolve?: ResolveConfig;

  /**
   * Whether to inherit middleware and telemetry from the global Agentick instance.
   *
   * When true (default), the app inherits:
   * - Middleware registered via `Agentick.use('*', mw)`, `Agentick.use('tool:*', mw)`, etc.
   * - Telemetry provider from `Agentick.telemetryProvider`
   *
   * Set to false for isolated apps (useful in testing).
   *
   * @default true
   *
   * @example
   * ```typescript
   * // App inherits Agentick defaults (default behavior)
   * const app = createApp(MyAgent, { model });
   *
   * // Isolated app - no Agentick middleware
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
/**
 * Options for overriding inherited behavior in spawned child sessions.
 *
 * By default, children inherit structural options (model, tools, runner,
 * maxTicks) from the parent. SpawnOptions lets you override any of these.
 *
 * @example
 * ```typescript
 * // Spawn with a different runner
 * await session.spawn(CodeAgent, { messages }, {
 *   runner: replRunner,
 * });
 *
 * // Spawn with a different model
 * await session.spawn(SummaryAgent, { messages }, {
 *   model: cheapModel,
 *   maxTicks: 3,
 * });
 * ```
 */
export interface SpawnOptions {
  /** Override the parent's model */
  model?: EngineModel;
  /** Override the parent's execution runner */
  runner?: ExecutionRunner;
  /** Override the parent's max ticks */
  maxTicks?: number;
}

export interface SessionOptions extends LifecycleCallbacks {
  /**
   * Explicit session ID (used by App-managed sessions).
   */
  sessionId?: string;

  /**
   * Additional tools for this session.
   * Merged with app-level tools (session tools take priority on name conflict).
   */
  tools?: ExecutableTool[];

  /**
   * Maximum number of ticks for this session.
   * Overrides AppOptions.maxTicks.
   */
  maxTicks?: number;

  /**
   * Per-session abort signal.
   */
  signal?: AbortSignal;

  // initialTimeline and snapshot removed — use resolve + useTimeline().set() instead

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
   * const session = app.session({ recording: 'full' });
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
   * const session = app.session({ devTools: true });
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
  /** Per-execution tools (scoped to this execution only, cleared when it ends) */
  executionTools?: ExecutableTool[];
}

// ============================================================================
// Resolve Types
// ============================================================================

/**
 * Context passed to resolve functions.
 */
export interface ResolveContext {
  sessionId: string;
  snapshot: SessionSnapshot | null;
}

/**
 * Resolve configuration for loading data before session render.
 *
 * Can be:
 * - Object form: `{ key: value | (ctx) => value }`
 * - Function form: `(ctx) => { key: value }`
 *
 * Results available via `useResolved(key)`.
 */
export type ResolveConfig =
  | Record<string, unknown | ((ctx: ResolveContext) => unknown | Promise<unknown>)>
  | ((ctx: ResolveContext) => Record<string, unknown> | Promise<Record<string, unknown>>);

/**
 * Serialized session state for persistence/resumption.
 */
export interface SessionSnapshot {
  /** Session version for compatibility */
  version: string;
  /** Session ID */
  sessionId: string;
  /** Tick number at snapshot time */
  tick: number;
  /** Serialized conversation/timeline */
  timeline: COMTimelineEntry[] | null;
  /** COM key-value state (useComState) */
  comState: Record<string, unknown>;
  /** useData cache (entries with persist !== false) */
  dataCache: Record<string, SerializableCacheEntry>;
  /** Accumulated usage stats across all sends */
  usage?: UsageStats;
  /** Timestamp of snapshot */
  timestamp: number;
}

// ============================================================================
// Send Input
// ============================================================================

/**
 * Input for sending messages to a session.
 *
 * Extends the wire-safe SharedSendInput with local execution fields.
 * Always uses `messages` array (no singular `message` form).
 *
 * @example
 * ```typescript
 * session.send({
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 *   maxTicks: 5,
 * });
 * ```
 */
export interface SendInput<P = Record<string, unknown>> extends SharedSendInput<P> {
  /** Override maxTicks for this execution */
  maxTicks?: number;
  /** Per-execution abort signal (not serializable — local only) */
  signal?: AbortSignal;
  /**
   * Additional tools for this execution.
   * Merged with session and app tools (execution tools take priority on name conflict).
   */
  tools?: ExecutableTool[];
}

// ============================================================================
// Run Input - Full configuration for one-shot execution
// ============================================================================

/**
 * Input for run() and app.run().
 *
 * Extends SendInput with configuration for the implicit layers
 * (app creation, session creation) that run() and app.run() handle.
 *
 * Progressive disclosure: run() needs model, app.run() doesn't (already configured).
 *
 * @example run() — needs everything
 * ```typescript
 * const result = await run(<MyAgent />, {
 *   model,
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 *   history: previousConversation.entries,
 *   maxTicks: 5,
 * });
 * ```
 *
 * @example app.run() — model already configured
 * ```typescript
 * const result = await app.run({
 *   props: { system: "You are helpful" },
 *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
 *   history: previousConversation.entries,
 * });
 * ```
 */
export interface RunInput<P = Record<string, unknown>> extends SendInput<P> {
  /** Model instance (required for run(), optional for app.run()) */
  model?: EngineModel;

  /**
   * Previous conversation history to hydrate.
   *
   * These become the initial timeline entries, available via
   * `useConversationHistory()` and rendered by `<Timeline />`.
   */
  history?: TimelineEntry[];

  /** Enable DevTools event emission */
  devTools?: boolean;

  /** Recording mode for time-travel debugging */
  recording?: RecordingMode;
}

// ============================================================================
// Send Result - Output from session.render()
// ============================================================================

/**
 * Result from session.render() with structured outputs.
 *
 * This is the primary output interface. Props go in, SendResult comes out.
 *
 * @example
 * ```typescript
 * const session = app.session();
 * const result = await session.render({ messages: [...], context: 'Be concise' });
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
 * and session.render().
 *
 * The handle is AsyncIterable (not PromiseLike):
 * - `await handle.result` → resolves to SendResult
 * - `for await (const event of handle)` → streams StreamEvent
 *
 * @example
 * ```typescript
 * // send/render are Procedures — await to get the handle
 * const handle = await session.send({ messages: [...] });
 *
 * // Stream events
 * for await (const event of handle) {
 *   if (event.type === 'content_delta') {
 *     process.stdout.write(event.delta);
 *   }
 * }
 *
 * // Or get result directly via ProcedurePromise chaining
 * const result = await session.send({ messages: [...] }).result;
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
  submitToolResult(
    toolUseId: string,
    response: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
  ): void;
}

// ============================================================================
// Session - Persistent execution context
// ============================================================================

/**
 * Session status.
 *
 * - `idle` — Ready, not executing
 * - `running` — Tick in progress (model call / tool execution)
 * - `closed` — Permanently shut down, cannot return
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
 * const session = app.session();
 * await session.render({ query: "Hello!" });
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
 * Serialized hook state for devtools.
 */
export interface SerializedHook {
  index: number;
  type: string;
  value: unknown;
  deps?: unknown[];
  status?: string;
}

/**
 * Serialized fiber node for snapshots and devtools.
 *
 * Captures the component tree structure with props.
 * Matches the FiberNode interface expected by devtools UI.
 */
export interface SerializedFiberNode {
  /** Unique identifier for the node */
  id: string;
  /** Component name or element type */
  type: string;
  /** React key */
  key: string | number | null;
  /** JSON-safe props (functions/symbols removed) */
  props: Record<string, unknown>;
  /** Hook states (React manages hooks internally) */
  hooks: SerializedHook[];
  /** Child fibers */
  children: SerializedFiberNode[];
  /** Human-readable summary for display */
  _summary?: string;
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
 * const session = app.session({ recording: 'full' });
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
 * const session = app.session({ recording: 'full' });
 * await session.render({ query: "Hello!" });
 * await session.render({ query: "Tell me more" });
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
 * const session = app.session();
 *
 * // Listen to events via EventEmitter
 * session.on('event', (event) => console.log(event));
 *
 * // Or convert to AsyncIterable
 * for await (const event of session.events()) {
 *   console.log(event);
 * }
 *
 * // Run with props, get handle
 * const handle = await session.render({ query: "Hello!" });
 * const result = await handle.result;
 * console.log(result.response);
 *
 * // Or get result directly via ProcedurePromise chaining
 * const result2 = await session.render({ query: "Follow up" }).result;
 *
 * // Queue messages for next tick
 * await session.queue.exec({ role: "user", content: [...] });
 *
 * // Interrupt running execution
 * session.interrupt({ role: "user", content: [...] }, "user_interrupt");
 *
 * // Clean up when done
 * await session.close();
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

  /** Parent session, or null for root sessions. */
  readonly parent: Session | null;

  /** Active child sessions (currently running spawns). */
  readonly children: readonly Session[];

  /** Messages queued for the next tick (read-only view) */
  readonly queuedMessages: readonly Message[];

  /**
   * Current scheduler state for DevTools.
   *
   * Returns the scheduler's current state, including status,
   * pending reasons, and reconciliation metrics.
   *
   * Returns null if the session hasn't been initialized yet.
   */
  readonly schedulerState: SchedulerState | null;

  /**
   * Queue a message to be included in the next tick.
   *
   * Queues the message and notifies onMessage hooks if components are mounted.
   * Does NOT trigger execution - use send() if you want to trigger render().
   *
   * This is a procedure (without execution boundary) so you can use:
   * - `session.queue.withContext({ userId }).exec(message)`
   * - `session.queue.use(middleware).exec(message)`
   */
  queue: Procedure<(message: Message) => Promise<void>, true>;

  /**
   * Send messages and/or update props.
   *
   * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike):
   * - `await handle.result` → SendResult when execution completes
   * - `for await (const event of handle)` → stream events
   *
   * Concurrent calls return THE SAME handle - messages queue, handle resolves
   * when the tick loop settles.
   *
   * @example
   * ```typescript
   * // Await Procedure to get handle, then stream events
   * const handle = await session.send({ messages: [...] });
   * for await (const event of handle) {
   *   console.log(event);
   * }
   *
   * // Or get the result directly via ProcedurePromise chaining
   * const result = await session.send({ messages: [...] }).result;
   * ```
   */
  send: Procedure<(input: SendInput<P>) => SessionExecutionHandle, true>;

  /**
   * Run the component with props, execute tick loop.
   *
   * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike).
   * If already running, returns the existing handle (hot-update support).
   *
   * Note: If called with no props (or empty props) and no queued messages, returns an
   * empty handle and does not run a tick.
   *
   * @example
   * ```typescript
   * const handle = await session.render(props);
   * handle.queueMessage({ role: "user", content: [...] });
   * const result = await handle.result;
   * ```
   */
  render: Procedure<(props: P, options?: ExecutionOptions) => SessionExecutionHandle, true>;

  /**
   * Spawn a child session with a different agent/component.
   *
   * Creates an ephemeral child session, runs it to completion, and returns
   * the same SessionExecutionHandle as session.send().
   *
   * The child session is NOT registered in the App's session registry.
   * Parent abort propagates to child. Max spawn depth is 10.
   *
   * By default, child inherits parent's structural options (model, tools,
   * runner, maxTicks). Use `options` to override any of these.
   *
   * @param component - ComponentFunction or JSX element
   * @param input - Optional SendInput for the child session
   * @param options - Optional overrides for the child's structural options
   *
   * @example
   * ```typescript
   * // Basic spawn
   * const handle = await session.spawn(ResearchAgent, { messages });
   *
   * // Spawn with different runner
   * const handle = await session.spawn(CodeAgent, { messages }, {
   *   runner: replRunner,
   * });
   * ```
   */
  spawn: Procedure<
    (
      component: ComponentFunction | JSX.Element,
      input?: SendInput,
      options?: SpawnOptions,
    ) => SessionExecutionHandle,
    true
  >;

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
   * const session = app.session();
   * await session.render({ query: "Hello!" });
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
   * const session = app.session();
   * session.startRecording('full');
   * await session.render({ query: "Hello!" });
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
   * const session = app.session({ recording: 'full' });
   * await session.render({ query: "Hello!" });
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
   * Submit tool confirmation result out-of-band.
   * Used when client sends tool confirmation outside of execution handle.
   */
  submitToolResult(
    toolUseId: string,
    response: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
  ): void;

  /**
   * Close the session and release resources.
   * Awaits runner cleanup (onDestroy) and child session teardown.
   */
  close(): Promise<void>;
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
 * // Persistent session (new with generated ID)
 * const session = app.session();
 * await session.render({ query: "Hello!" });
 * await session.render({ query: "Follow up" });
 * await session.close();
 *
 * // Named session (get-or-create by ID)
 * const conv = app.session('conv-123');
 * await conv.render({ query: "Hello!" });
 *
 * // Session with options
 * const withOpts = app.session({ sessionId: 'conv-456', maxTicks: 5 });
 * ```
 */
export interface App<P = Record<string, unknown>> {
  /**
   * Run the app with input.
   *
   * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike):
   * - `await handle.result` → SendResult
   * - `for await (const event of handle)` → StreamEvent
   *
   * Creates an ephemeral session internally (create → run → close).
   *
   * @example Get result
   * ```typescript
   * const result = await app.run({
   *   props: { system: "You are helpful" },
   *   messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
   * }).result;
   * console.log(result.response);
   * ```
   *
   * @example With history and session config
   * ```typescript
   * const result = await app.run({
   *   props: { system: "You are helpful" },
   *   messages: [{ role: "user", content: [{ type: "text", text: "Follow up" }] }],
   *   history: previousConversation.entries,
   *   maxTicks: 5,
   *   devTools: true,
   * }).result;
   * ```
   *
   * @example Use handle for control
   * ```typescript
   * const handle = await app.run({ messages });
   * handle.queueMessage({ role: "user", content: [...] });
   * const result = await handle.result;
   * ```
   */
  run: Procedure<(input: RunInput<P>) => SessionExecutionHandle, true>;

  /**
   * Send to a session.
   *
   * Without sessionId: creates ephemeral session, executes, destroys.
   * With sessionId: creates or reuses managed session (may hydrate from store).
   */
  send(input: SendInput<P>, options?: { sessionId?: string }): Promise<SessionExecutionHandle>;

  /**
   * Get or create a session.
   *
   * This is the primary way to access sessions:
   * - `session()` - Creates new session with generated ID
   * - `session('id')` - Gets existing or creates new session with that ID
   * - `session({ sessionId, ...opts })` - Gets or creates with options
   *
   * Use `app.has(id)` to check if a session exists without creating it.
   *
   * @example
   * ```typescript
   * // New session with generated ID
   * const session = app.session();
   *
   * // Get or create by ID
   * const conv = app.session('conv-123');
   *
   * // With options
   * const withOpts = await app.session({ sessionId: 'conv-456', maxTicks: 5 });
   * const newWithOpts = await app.session({ maxTicks: 5 }); // Generated ID
   * ```
   */
  session(id?: string): Promise<Session<P>>;
  session(options: SessionOptions): Promise<Session<P>>;

  /**
   * Close and cleanup a session.
   */
  close(sessionId: string): Promise<void>;

  /**
   * List active session IDs.
   */
  readonly sessions: readonly string[];

  /**
   * Check if a session exists (in memory).
   */
  has(sessionId: string): boolean;

  /**
   * Register onSessionCreate handler.
   */
  onSessionCreate(handler: (session: Session<P>) => void): () => void;

  /**
   * Register onSessionClose handler.
   */
  onSessionClose(handler: (sessionId: string) => void): () => void;
}
