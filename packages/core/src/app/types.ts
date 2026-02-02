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
  UsageStats,
  TimelineEntry,
  SendInput as SharedSendInput,
  ContentBlock,
} from "@tentickle/shared";
import type { COMInput } from "../com/types";
import type { ExecutableTool } from "../tool/tool";
import type { MCPConfig } from "../mcp";
import type { ModelInstance } from "../model/model";
import type { ExecutionHandle, Channel, Procedure } from "@tentickle/kernel";
import type { JSX } from "../jsx/jsx-runtime";
// Signal type removed - schedulerState now returns SchedulerState directly
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
// Session Store (for hibernation persistence)
// ============================================================================

/**
 * Storage adapter for persisting hibernated sessions.
 *
 * Implement this interface to enable session hibernation with your storage backend
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
   * Called when a session hibernates.
   */
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;

  /**
   * Load a session snapshot from storage.
   * Called when hydrating a hibernated session.
   * Returns null if session not found.
   */
  load(sessionId: string): Promise<SessionSnapshot | null>;

  /**
   * Delete a session snapshot from storage.
   * Called when a session is permanently closed.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * List all hibernated session IDs.
   * Optional - used for session discovery/management.
   */
  list?(): Promise<string[]>;

  /**
   * Check if a hibernated session exists.
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
   * @default 'tentickle_sessions'
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
 * hibernation, limits, and auto-cleanup.
 */
export interface SessionManagementOptions {
  /**
   * Storage adapter for hibernated sessions.
   *
   * Can be:
   * - A file path string for SQLite storage (e.g., './sessions.db')
   * - `':memory:'` for in-memory SQLite
   * - A `{ type: 'sqlite', ... }` config object
   * - A custom `SessionStore` implementation
   *
   * If not provided, sessions cannot hibernate (they will be closed instead).
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
   * When exceeded, the least-recently used session is hibernated.
   * @default unlimited
   */
  maxActive?: number;

  /**
   * Milliseconds of inactivity before auto-hibernating a session.
   * Activity is tracked via send(), tick(), queue(), and channel publish.
   * Set to 0 or undefined to disable auto-hibernation.
   */
  idleTimeout?: number;

  /**
   * Whether to automatically hibernate idle sessions.
   * @default true if store is provided, false otherwise
   */
  autoHibernate?: boolean;
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
   * Controls hibernation, limits, and auto-cleanup of sessions.
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
   * @deprecated Use `sessions.idleTimeout` instead.
   * Idle timeout before cleaning up a session (ms).
   */
  sessionTTL?: number;

  /**
   * @deprecated Use `sessions.maxActive` instead.
   * Maximum number of active sessions before eviction.
   */
  maxSessions?: number;

  /**
   * Called when a session is created.
   */
  onSessionCreate?: (session: Session) => void;

  /**
   * Called when a session is closed and removed from the registry.
   */
  onSessionClose?: (sessionId: string) => void;

  /**
   * Called before a session hibernates.
   *
   * Use this to:
   * - Cancel hibernation (return false)
   * - Modify the snapshot before saving (return modified snapshot)
   * - Perform cleanup before hibernation
   *
   * @param session - The session about to hibernate
   * @param snapshot - The snapshot that will be saved
   * @returns false to cancel, modified snapshot, or void to proceed
   *
   * @example
   * ```typescript
   * onBeforeHibernate: (session, snapshot) => {
   *   // Don't hibernate sessions with pending tool calls
   *   if (session.inspect().lastToolCalls.length > 0) {
   *     return false;
   *   }
   *   // Add custom metadata to snapshot
   *   return { ...snapshot, metadata: { hibernatedAt: Date.now() } };
   * }
   * ```
   */
  onBeforeHibernate?: (
    session: Session,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;

  /**
   * Called after a session has been hibernated.
   *
   * The session is no longer in memory at this point.
   * Use this for logging, metrics, or cleanup.
   *
   * @param sessionId - The ID of the hibernated session
   * @param snapshot - The snapshot that was saved
   */
  onAfterHibernate?: (sessionId: string, snapshot: SessionSnapshot) => void | Promise<void>;

  /**
   * Called before a session is hydrated from storage.
   *
   * Use this to:
   * - Cancel hydration (return false)
   * - Migrate/transform old snapshot formats (return modified snapshot)
   * - Validate snapshot before restoration
   *
   * @param sessionId - The ID of the session being hydrated
   * @param snapshot - The snapshot loaded from storage
   * @returns false to cancel, modified snapshot, or void to proceed
   *
   * @example
   * ```typescript
   * onBeforeHydrate: (sessionId, snapshot) => {
   *   // Migrate old snapshot format
   *   if (snapshot.version === '0.9') {
   *     return migrateSnapshot(snapshot);
   *   }
   *   return snapshot;
   * }
   * ```
   */
  onBeforeHydrate?: (
    sessionId: string,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;

  /**
   * Called after a session has been hydrated.
   *
   * The session is now live and in memory.
   * Use this for post-restoration setup, logging, or metrics.
   *
   * @param session - The hydrated session
   * @param snapshot - The snapshot that was used
   */
  onAfterHydrate?: (session: Session, snapshot: SessionSnapshot) => void | Promise<void>;

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
   * Explicit session ID (used by App-managed sessions).
   */
  sessionId?: string;
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
   * const session = app.session({
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
// Send Input
// ============================================================================

/**
 * Discriminated input for sending to a session.
 * Requires either `message` or `messages` (but not both).
 */
export type SendInput<P = Record<string, unknown>> = SharedSendInput<P>;

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
 * const session = app.session();
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
  /** Hook states (empty in v2 since React manages hooks internally) */
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
 * // Run with props, get result
 * const result = await session.tick({ query: "Hello!" });
 * console.log(result.response);
 *
 * // Session maintains state between ticks
 * const result2 = await session.tick({ query: "Follow up" });
 *
 * // Queue messages for next tick
 * await session.queue.exec({ role: "user", content: [...] });
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
  send(input: SendInput<P>, options?: ExecutionOptions): SessionExecutionHandle;

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
   * Hibernate the session (serialize and remove from memory).
   *
   * This is called automatically by the App when:
   * - Session exceeds idle timeout
   * - Max active sessions limit is reached
   *
   * Can also be called manually to explicitly hibernate a session.
   *
   * After hibernation:
   * - The session is removed from memory
   * - The snapshot is saved to the configured SessionStore
   * - Calling `app.session(id)` will rehydrate from storage
   *
   * @returns The snapshot that was saved, or null if hibernation was cancelled
   *
   * @example
   * ```typescript
   * const session = app.session('conv-123');
   * await session.tick({ query: "Hello!" });
   *
   * // Manually hibernate
   * const snapshot = await session.hibernate();
   *
   * // Later, rehydrate by accessing the session
   * const restored = app.session('conv-123'); // Loads from store
   * ```
   */
  hibernate(): Promise<SessionSnapshot | null>;

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
   * const session = app.session();
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
   * const session = app.session({ recording: 'full' });
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
   * Submit tool confirmation result out-of-band.
   * Used when client sends tool confirmation outside of execution handle.
   */
  submitToolResult(
    toolUseId: string,
    response: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
  ): void;

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
 * // Persistent session (new with generated ID)
 * const session = app.session();
 * await session.tick({ query: "Hello!" });
 * await session.tick({ query: "Follow up" });
 * session.close();
 *
 * // Named session (get-or-create by ID)
 * const conv = app.session('conv-123');
 * await conv.tick({ query: "Hello!" });
 *
 * // Session with options
 * const withOpts = app.session({ sessionId: 'conv-456', maxTicks: 5 });
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
   * Send to a session.
   *
   * Without sessionId: creates ephemeral session, executes, destroys.
   * With sessionId: creates or reuses managed session.
   */
  send(
    input: SendInput<P>,
    options?: { sessionId?: string } & ExecutionOptions,
  ): SessionExecutionHandle;

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
   * const withOpts = app.session({ sessionId: 'conv-456', maxTicks: 5 });
   * const newWithOpts = app.session({ maxTicks: 5 }); // Generated ID
   * ```
   */
  session(id?: string): Session<P>;
  session(options: SessionOptions): Session<P>;

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
   * Check if a session is hibernated (in storage but not in memory).
   *
   * Returns false if no SessionStore is configured.
   */
  isHibernated(sessionId: string): Promise<boolean>;

  /**
   * Hibernate a session by ID.
   *
   * Convenience method equivalent to `app.session(id).hibernate()`.
   * Returns the snapshot that was saved, or null if:
   * - Session doesn't exist
   * - Hibernation was cancelled by onBeforeHibernate
   * - No SessionStore is configured
   */
  hibernate(sessionId: string): Promise<SessionSnapshot | null>;

  /**
   * List all hibernated session IDs.
   *
   * Returns empty array if no SessionStore is configured or
   * if the store doesn't implement `list()`.
   */
  hibernatedSessions(): Promise<string[]>;

  /**
   * Register onSessionCreate handler.
   */
  onSessionCreate(handler: (session: Session<P>) => void): () => void;

  /**
   * Register onSessionClose handler.
   */
  onSessionClose(handler: (sessionId: string) => void): () => void;
}
