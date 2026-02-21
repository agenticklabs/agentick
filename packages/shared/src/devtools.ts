/**
 * DevTools Event Types and Emitter
 *
 * This module provides the event types and singleton emitter for DevTools integration.
 * The engine emits events to this emitter, and DevTools subscribes to receive them.
 *
 * @module @agentick/shared/devtools
 */

import type { UsageStats, Message, ToolDefinition } from "./index.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * DevTools channel name - used for engine to emit events
 */
export const DEVTOOLS_CHANNEL = "__devtools__";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Base fields present on all DevTools events
 */
export interface DevToolsEventBase {
  /** Discriminator for event type */
  type: string;
  /** UUID of the execution context */
  executionId: string;
  /** Monotonically increasing sequence number from the source session */
  sequence: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  // ─────────────────────────────────────────────────────────────────────────────
  // Optional telemetry fields (auto-populated from context when available)
  // ─────────────────────────────────────────────────────────────────────────────
  /** Trace ID for distributed tracing correlation */
  traceId?: string;
  /** Request ID for this execution context */
  requestId?: string;
  /** Parent execution ID for nested executions (fork, spawn, component_tool) */
  parentExecutionId?: string;
  /** Current procedure ID */
  procedureId?: string;
  /** User ID from context (for attribution and multi-tenant filtering) */
  userId?: string;
  /** Tenant ID from context (for multi-tenant dashboards) */
  tenantId?: string;
}

/**
 * Execution context fields for events in an execution tree
 */
export interface ExecutionContextFields {
  /** Parent execution ID (for fork/spawn) */
  parentExecutionId?: string;
  /** Root of the execution tree */
  rootExecutionId?: string;
  /** Engine instance ID (constant across executions) */
  engineId?: string;
  /** OpenTelemetry trace ID if available */
  traceId?: string;
}

// ============================================================================
// Lifecycle Events
// ============================================================================

export interface DTExecutionStartEvent extends DevToolsEventBase, ExecutionContextFields {
  type: "execution_start";
  /** Component/agent name */
  rootComponent: string;
  /** User session ID if available */
  sessionId?: string;
  /** Type of execution */
  executionType?: "root" | "fork" | "spawn";
}

export interface DTExecutionEndEvent extends DevToolsEventBase {
  type: "execution_end";
  /** Cumulative token usage across all ticks */
  totalUsage: UsageStats;
  /** Final execution state */
  finalState?: "completed" | "cancelled" | "error";
  /** Error details if finalState is 'error' */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

// ============================================================================
// Tick Events
// ============================================================================

export interface DTTickStartEvent extends DevToolsEventBase {
  type: "tick_start";
  /** 1-indexed tick number */
  tick: number;
}

export interface DTTickEndEvent extends DevToolsEventBase {
  type: "tick_end";
  tick: number;
  /** Token usage for this tick */
  usage?: UsageStats;
  /** Stop reason: "end_turn", "tool_use", "max_tokens", etc. */
  stopReason?: string;
  /** Model ID used this tick */
  model?: string;
}

// ============================================================================
// Compilation Events
// ============================================================================

export interface DTCompiledEvent extends DevToolsEventBase {
  type: "compiled";
  tick: number;
  /** Full conversation history (rendered timeline) */
  messages: Message[];
  /** Available tools */
  tools: ToolDefinition[];
  /** System prompt */
  system?: string;
  /** Raw compiled structure (before rendering) - JSX to semantic blocks */
  rawCompiled?: {
    sections: Record<string, unknown>;
    timelineEntries: unknown[];
    system: unknown[];
    tools: unknown[];
    ephemeral: unknown[];
  };
  /** Formatted COMInput (after rendering) - Markdown/XML applied */
  formattedInput?: {
    timeline: unknown[];
    system: unknown[];
    sections: Record<string, unknown>;
    tools: unknown[];
    ephemeral: unknown[];
    metadata?: Record<string, unknown>;
  };
}

// ============================================================================
// Model Events
// ============================================================================

export interface DTModelStartEvent extends DevToolsEventBase {
  type: "model_start";
  tick: number;
  /** Model identifier, e.g., "claude-3-5-sonnet-20241022" */
  modelId: string;
  /** Provider name, e.g., "anthropic", "openai" */
  provider?: string;
}

export interface DTModelRequestEvent extends DevToolsEventBase {
  type: "model_request";
  tick: number;
  /** Model ID */
  modelId?: string;
  /** The formatted input in Agentick format (before provider transformation) */
  input?: {
    /** Messages array in Agentick format */
    messages?: unknown[];
    /** System prompt */
    system?: string;
    /** Tools available */
    tools?: unknown[];
    /** Other model parameters */
    [key: string]: unknown;
  };
  /** Pipeline stage identifier */
  stage?: "model_input";
}

export interface DTProviderRequestEvent extends DevToolsEventBase {
  type: "provider_request";
  /** Tick number */
  tick: number;
  /** Model ID */
  modelId?: string;
  /** Provider name (e.g., "openai", "anthropic", "google") */
  provider?: string;
  /** The actual input sent to the provider (after transformation)
   * This is the exact shape the provider SDK receives (e.g., AI SDK format for Gemini)
   */
  providerInput?: unknown;
}

export interface DTProviderResponseEvent extends DevToolsEventBase {
  type: "provider_response";
  tick: number;
  /** Model ID */
  modelId?: string;
  /** Provider name (e.g., "openai", "anthropic", "google") */
  provider?: string;
  /** Raw provider response before Agentick transformation */
  providerOutput?: unknown;
}

export interface DTModelResponseEvent extends DevToolsEventBase {
  type: "model_response";
  tick: number;
  /** Provider output (raw SDK response, may be reconstructed for streaming) */
  providerOutput?: unknown;
  /** ModelOutput (normalized Agentick format) */
  modelOutput?: {
    model?: string;
    message?: Message;
    usage?: UsageStats;
    stopReason?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  };
  /** Engine state (how response is ingested into timeline) */
  engineState?: {
    newTimelineEntries?: unknown[];
    toolCalls?: unknown[];
    shouldStop?: boolean;
    stopReason?: unknown;
  };
}

// ============================================================================
// Streaming Events
// ============================================================================

export interface DTContentDeltaEvent extends DevToolsEventBase {
  type: "content_delta";
  tick: number;
  /** Incremental text content */
  delta: string;
  /** Which content block (for multi-block responses) */
  blockIndex?: number;
}

export interface DTReasoningDeltaEvent extends DevToolsEventBase {
  type: "reasoning_delta";
  tick: number;
  /** Incremental reasoning/thinking content */
  delta: string;
}

// ============================================================================
// Tool Events
// ============================================================================

export interface DTToolCallEvent extends DevToolsEventBase {
  type: "tool_call";
  tick: number;
  toolName: string;
  /** Unique ID for this tool invocation */
  toolUseId: string;
  /** Tool input (JSON-serializable) */
  input: unknown;
  /** Tool execution type */
  executionType?: "server" | "client" | "provider" | "mcp";
}

export interface DTToolResultEvent extends DevToolsEventBase {
  type: "tool_result";
  tick: number;
  /** Matches the tool_call */
  toolUseId: string;
  /** Tool output (JSON-serializable) */
  result: unknown;
  /** True if tool threw an error */
  isError?: boolean;
  /** Execution time in milliseconds */
  durationMs?: number;
}

export interface DTToolConfirmationEvent extends DevToolsEventBase {
  type: "tool_confirmation";
  tick: number;
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Message shown to user */
  confirmationMessage?: string;
  status: "pending" | "approved" | "denied";
}

// ============================================================================
// State Events
// ============================================================================

export interface DTStateChangeEvent extends DevToolsEventBase {
  type: "state_change";
  tick: number;
  /** Signal/state key */
  key: string;
  oldValue: unknown;
  newValue: unknown;
  /** Source of the change */
  source?: "signal" | "reducer" | "effect";
}

// ============================================================================
// Fiber Events
// ============================================================================

/**
 * Hook type identifier for DevTools display.
 */
export type DTHookType =
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
 * Serialized hook state for fiber snapshots.
 */
export interface DTSerializedHookState {
  /** Hook index in the component */
  index: number;
  /** Hook type */
  type: DTHookType;
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
 * Serialized fiber node for DevTools component tree.
 */
export interface DTSerializedFiberNode {
  /** Unique fiber ID */
  id: string;
  /** Component name or intrinsic type */
  type: string;
  /** React-style key */
  key: string | number | null;
  /** JSON-safe props (functions/symbols removed) */
  props: Record<string, unknown>;
  /** Hook states for this component */
  hooks: DTSerializedHookState[];
  /** Child fibers */
  children: DTSerializedFiberNode[];
}

/**
 * Summary statistics for a fiber tree.
 */
export interface DTFiberSummary {
  /** Number of components in the tree */
  componentCount: number;
  /** Total number of hooks */
  hookCount: number;
  /** Hook count by type */
  hooksByType: Partial<Record<DTHookType, number>>;
}

/**
 * Token summary for DevTools visualization.
 */
export interface DTTokenSummary {
  /** Tokens in system prompt(s) */
  system: number;
  /** Tokens in timeline messages */
  messages: number;
  /** Tokens in tool definitions */
  tools: number;
  /** Tokens in ephemeral content */
  ephemeral: number;
  /** Total tokens */
  total: number;
  /** Token count by component (keyed by component identifier) */
  byComponent?: Record<string, number>;
}

/**
 * Compiled preview for DevTools visualization.
 */
export interface DTCompiledPreview {
  /** First 200 chars of system prompt */
  systemPrompt?: string;
  /** Number of messages in timeline */
  messageCount: number;
  /** Number of tools available */
  toolCount: number;
  /** Number of ephemeral entries */
  ephemeralCount: number;
}

/**
 * Emitted after each tick with the current fiber tree state.
 * Enables DevTools to show component hierarchy and hook values.
 */
export interface DTFiberSnapshotEvent extends DevToolsEventBase {
  type: "fiber_snapshot";
  /** Session ID this fiber tree belongs to */
  sessionId: string;
  /** Tick number when snapshot was taken */
  tick: number;
  /** Full serialized fiber tree (may be null if serialization fails) */
  tree: DTSerializedFiberNode | null;
  /** Summary statistics (always present) */
  summary: DTFiberSummary;
  /** Token estimate summary (optional - only if compiled structure available) */
  tokenSummary?: DTTokenSummary;
  /** Preview of compiled structure (optional) */
  compiledPreview?: DTCompiledPreview;
}

/**
 * Emitted after each tick with context utilization info.
 * Enables DevTools and React UI to show real-time context tracking.
 */
export interface DTContextUpdateEvent extends DevToolsEventBase {
  type: "context_update";
  /** Session ID */
  sessionId: string;
  /** Model ID (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  modelId: string;
  /** Human-readable model name */
  modelName?: string;
  /** Provider name */
  provider?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Input tokens used this tick */
  inputTokens: number;
  /** Output tokens generated this tick */
  outputTokens: number;
  /** Total tokens this tick */
  totalTokens: number;
  /** Context utilization percentage (0-100) */
  utilization?: number;
  /** Max output tokens */
  maxOutputTokens?: number;
  /** Model capabilities */
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;
  /** Current tick number */
  tick: number;
  /** Cumulative usage across all ticks */
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}

// ============================================================================
// Procedure Events (from kernel-level observability)
// ============================================================================

/**
 * Emitted when any procedure starts execution.
 * This captures model calls, tool executions, engine operations, etc.
 */
export interface DTProcedureStartEvent extends DevToolsEventBase {
  type: "procedure_start";
  /** Unique procedure instance ID */
  procedureId: string;
  /** Procedure name (e.g., 'model:stream', 'tool:calculator') */
  procedureName: string;
  /** Procedure type from metadata */
  procedureType?: string;
  /** Parent procedure ID for call tree */
  parentProcedureId?: string;
  /** Additional metadata from the procedure */
  metadata?: Record<string, unknown>;
  /** Engine tick number when this procedure started (if within a tick) */
  tick?: number;
}

/**
 * Emitted when a procedure completes successfully.
 */
export interface DTProcedureEndEvent extends DevToolsEventBase {
  type: "procedure_end";
  procedureId: string;
  procedureName?: string;
  status: "completed";
  /** Metrics accumulated during execution */
  metrics?: Record<string, number>;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Engine tick number when this procedure ended (if within a tick) */
  tick?: number;
}

/**
 * Emitted when a procedure fails with an error.
 */
export interface DTProcedureErrorEvent extends DevToolsEventBase {
  type: "procedure_error";
  procedureId: string;
  procedureName?: string;
  status: "failed" | "cancelled";
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Metrics accumulated before failure */
  metrics?: Record<string, number>;
  /** Engine tick number when this procedure failed (if within a tick) */
  tick?: number;
}

// ============================================================================
// Network Events (Gateway/Client observability)
// ============================================================================

/**
 * Emitted when a client connects to the gateway.
 */
export interface DTClientConnectedEvent extends DevToolsEventBase {
  type: "client_connected";
  /** Unique client identifier */
  clientId: string;
  /** Transport type */
  transport: "websocket" | "sse" | "http" | "local";
  /** Client IP address (if available) */
  ip?: string;
  /** User agent string (if available) */
  userAgent?: string;
}

/**
 * Emitted when a client disconnects from the gateway.
 */
export interface DTClientDisconnectedEvent extends DevToolsEventBase {
  type: "client_disconnected";
  clientId: string;
  /** Disconnect reason */
  reason?: string;
  /** Connection duration in milliseconds */
  durationMs: number;
}

/**
 * Emitted for gateway session lifecycle events.
 */
export interface DTGatewaySessionEvent extends DevToolsEventBase {
  type: "gateway_session";
  /** Session lifecycle action */
  action: "created" | "closed" | "message" | "resumed";
  /** Session ID */
  sessionId: string;
  /** App/agent ID */
  appId: string;
  /** Number of messages in session (for stats) */
  messageCount?: number;
  /** Client ID that owns this session */
  clientId?: string;
}

/**
 * Emitted when a gateway request is received.
 */
export interface DTGatewayRequestEvent extends DevToolsEventBase {
  type: "gateway_request";
  /** Unique request identifier */
  requestId: string;
  /** Method name (e.g., "chat:send", "tasks:list") */
  method: string;
  /** Session key if session-scoped */
  sessionKey?: string;
  /** Request parameters (sanitized) */
  params?: Record<string, unknown>;
  /** Client ID that made the request */
  clientId?: string;
}

/**
 * Emitted when a gateway request completes.
 */
export interface DTGatewayResponseEvent extends DevToolsEventBase {
  type: "gateway_response";
  /** Matches the request */
  requestId: string;
  /** Whether the request succeeded */
  ok: boolean;
  /** Response latency in milliseconds */
  latencyMs: number;
  /** Error details if ok is false */
  error?: {
    code: string;
    message: string;
  };
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * All DevTools event types
 */
export type DevToolsEvent =
  | DTExecutionStartEvent
  | DTExecutionEndEvent
  | DTTickStartEvent
  | DTTickEndEvent
  | DTCompiledEvent
  | DTModelStartEvent
  | DTModelRequestEvent
  | DTProviderRequestEvent
  | DTProviderResponseEvent
  | DTModelResponseEvent
  | DTContentDeltaEvent
  | DTReasoningDeltaEvent
  | DTToolCallEvent
  | DTToolResultEvent
  | DTToolConfirmationEvent
  | DTStateChangeEvent
  | DTFiberSnapshotEvent
  | DTContextUpdateEvent
  | DTProcedureStartEvent
  | DTProcedureEndEvent
  | DTProcedureErrorEvent
  | DTClientConnectedEvent
  | DTClientDisconnectedEvent
  | DTGatewaySessionEvent
  | DTGatewayRequestEvent
  | DTGatewayResponseEvent;

// ============================================================================
// DevTools Configuration
// ============================================================================

/**
 * Configuration for DevTools integration in the engine
 */
export interface DevToolsConfig {
  /** Enable DevTools (default: true when config object is provided) */
  enabled?: boolean;
  /** Channel name (default: '__devtools__') */
  channel?: string;
  /** Enable remote mode (POST to remote server) */
  remote?: boolean;
  /** Remote server URL (required if remote: true) */
  remoteUrl?: string;
  /** Shared secret for remote authentication */
  secret?: string;
  /** Inherit devTools config on fork (default: true) */
  inheritOnFork?: boolean;
  /** Inherit devTools config on spawn (default: true) */
  inheritOnSpawn?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

// ============================================================================
// DevTools Emitter Singleton
// ============================================================================

/**
 * Subscriber callback type
 */
export type DevToolsSubscriber = (event: DevToolsEvent) => void;

/**
 * Batch subscriber callback type
 */
export type DevToolsBatchSubscriber = (events: DevToolsEvent[]) => void;

/**
 * DevTools event emitter singleton.
 *
 * Engines emit events to this emitter, and DevTools subscribes to receive them.
 * This enables engine-agnostic instrumentation without tight coupling.
 *
 * This implementation is platform-agnostic (no Node.js dependencies) so it can
 * be used in both server and browser environments.
 *
 * @example
 * ```typescript
 * // Engine emits events
 * devToolsEmitter.emitEvent({
 *   type: 'execution_start',
 *   executionId: 'abc-123',
 *   rootComponent: 'MyAgent',
 *   timestamp: Date.now(),
 * });
 *
 * // DevTools subscribes
 * const unsubscribe = devToolsEmitter.subscribe((event) => {
 *   console.log('Event:', event.type);
 * });
 * ```
 */
class DevToolsEmitterImpl {
  private static instance: DevToolsEmitterImpl;
  private debug = false;

  // Subscribers
  private eventSubscribers: Set<DevToolsSubscriber> = new Set();
  private batchSubscribers: Set<DevToolsBatchSubscriber> = new Set();

  // Batching for high-frequency events
  private batchBuffer: DevToolsEvent[] = [];
  private batchTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_WINDOW_MS = 10;

  // History for late-joining subscribers
  private eventHistory: DevToolsEvent[] = [];
  private readonly MAX_HISTORY_SIZE = 1000;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): DevToolsEmitterImpl {
    if (!DevToolsEmitterImpl.instance) {
      DevToolsEmitterImpl.instance = new DevToolsEmitterImpl();
    }
    return DevToolsEmitterImpl.instance;
  }

  /**
   * Enable or disable debug mode
   */
  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /**
   * Emit a DevTools event.
   *
   * High-frequency events (content_delta, reasoning_delta) are batched
   * to reduce overhead. Other events are emitted immediately.
   */
  emitEvent(event: DevToolsEvent): void {
    try {
      // Add to history
      this.eventHistory.push(event);
      if (this.eventHistory.length > this.MAX_HISTORY_SIZE) {
        this.eventHistory.shift();
      }

      // High-frequency events get batched
      if (event.type === "content_delta" || event.type === "reasoning_delta") {
        this.batchBuffer.push(event);
        this.scheduleBatchFlush();
      } else {
        // Low-frequency events emit immediately (flush any pending batch first)
        this.flushBatch();
        this.notifySubscribers(event);
      }

      if (this.debug) {
        console.log("[DevTools] Emitted:", event.type, event.executionId);
      }
    } catch (error) {
      // Never throw - devtools is optional infrastructure
      if (this.debug) {
        console.warn("[DevTools] Emission error:", error);
      }
    }
  }

  private notifySubscribers(event: DevToolsEvent): void {
    for (const handler of this.eventSubscribers) {
      try {
        handler(event);
      } catch (error) {
        if (this.debug) {
          console.warn("[DevTools] Subscriber error:", error);
        }
      }
    }
  }

  private notifyBatchSubscribers(events: DevToolsEvent[]): void {
    for (const handler of this.batchSubscribers) {
      try {
        handler(events);
      } catch (error) {
        if (this.debug) {
          console.warn("[DevTools] Batch subscriber error:", error);
        }
      }
    }
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimeout) return;
    this.batchTimeout = setTimeout(() => {
      this.flushBatch();
    }, this.BATCH_WINDOW_MS);
  }

  private flushBatch(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    if (this.batchBuffer.length === 0) return;

    // Emit each event individually for simple subscribers
    for (const event of this.batchBuffer) {
      this.notifySubscribers(event);
    }

    // Also emit as batch for batch-aware subscribers
    this.notifyBatchSubscribers(this.batchBuffer);
    this.batchBuffer = [];
  }

  /**
   * Subscribe to DevTools events
   *
   * @returns Unsubscribe function
   */
  subscribe(handler: DevToolsSubscriber): () => void {
    this.eventSubscribers.add(handler);
    return () => {
      this.eventSubscribers.delete(handler);
    };
  }

  /**
   * Subscribe to batched events (for high-frequency event handling)
   *
   * @returns Unsubscribe function
   */
  subscribeBatch(handler: DevToolsBatchSubscriber): () => void {
    this.batchSubscribers.add(handler);
    return () => {
      this.batchSubscribers.delete(handler);
    };
  }

  /**
   * Get event history (for late-joining subscribers)
   *
   * @param executionId - Optional filter by execution ID
   */
  getHistory(executionId?: string): DevToolsEvent[] {
    if (!executionId) return [...this.eventHistory];
    return this.eventHistory.filter((e) => e.executionId === executionId);
  }

  /**
   * Clear all state (useful for testing)
   */
  clear(): void {
    this.eventHistory = [];
    this.batchBuffer = [];
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    this.eventSubscribers.clear();
    this.batchSubscribers.clear();
  }

  /**
   * Check if there are any subscribers
   */
  hasSubscribers(): boolean {
    return this.eventSubscribers.size > 0;
  }
}

/**
 * Singleton DevTools emitter instance.
 *
 * Use this to emit events from engines or subscribe to events in DevTools.
 */
export const devToolsEmitter = DevToolsEmitterImpl.getInstance();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize DevTools config from various input formats.
 *
 * @param config - true, false, undefined, or DevToolsConfig object
 * @returns Normalized DevToolsConfig or false if disabled
 */
export function normalizeDevToolsConfig(
  config: boolean | DevToolsConfig | undefined,
): DevToolsConfig | false {
  if (config === false) return false;
  if (config === undefined) return false;

  if (config === true) {
    return {
      enabled: true,
      inheritOnFork: true,
      inheritOnSpawn: true,
    };
  }

  return {
    enabled: config.enabled !== false,
    channel: config.channel || DEVTOOLS_CHANNEL,
    remote: config.remote || false,
    remoteUrl: config.remoteUrl,
    secret: config.secret,
    inheritOnFork: config.inheritOnFork !== false,
    inheritOnSpawn: config.inheritOnSpawn !== false,
    debug: config.debug || false,
  };
}

// ============================================================================
// App Event Forwarding to DevTools
// ============================================================================

/**
 * Context for forwarding app events to DevTools.
 */
export interface ForwardContext {
  sessionId: string;
  rootComponent: string;
  devToolsEnabled: boolean;
}

/**
 * Internal context passed to forwarder functions.
 */
interface ForwarderContext {
  sessionId: string;
  rootComponent: string;
  timestamp: number;
}

/**
 * Forwarder function type.
 */
type Forwarder = (event: Record<string, unknown>, ctx: ForwarderContext) => void;

/**
 * Registry of forwarders that map app events to DevTools events.
 * Each forwarder transforms an app-level event to DevTools format.
 *
 * This is platform-agnostic - no Node.js dependencies.
 */
const devToolsForwarders: Record<string, Forwarder> = {
  execution_start: (e, ctx) => {
    devToolsEmitter.emitEvent({
      type: "execution_start",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      rootComponent: ctx.rootComponent,
      sessionId: ctx.sessionId,
      timestamp: ctx.timestamp,
    } as DTExecutionStartEvent);
  },

  tick_start: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "tick_start",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      timestamp: ctx.timestamp,
    } as DTTickStartEvent);
  },

  tick_end: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "tick_end",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      usage: e.usage as UsageStats | undefined,
      stopReason: e.stopReason as string | undefined,
      model: e.model as string | undefined,
      timestamp: ctx.timestamp,
    } as DTTickEndEvent);
  },

  execution_end: (e, ctx) => {
    devToolsEmitter.emitEvent({
      type: "execution_end",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      totalUsage: (e.usage as UsageStats) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finalState: e.aborted ? "cancelled" : "completed",
      timestamp: ctx.timestamp,
    } as DTExecutionEndEvent);
  },

  tool_call: (e, ctx) => {
    const toolCall =
      (e.toolCall as { id: string; name: string; input: unknown } | undefined) ??
      (e.callId || e.toolUseId || e.name || e.toolName
        ? {
            id: (e.callId ?? e.toolUseId) as string,
            name: (e.name ?? e.toolName) as string,
            input: e.input,
          }
        : undefined);
    if (!toolCall?.id || !toolCall?.name) {
      console.warn("[DevTools] tool_call event missing toolCall data:", e);
      return;
    }
    devToolsEmitter.emitEvent({
      type: "tool_call",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      toolUseId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
      timestamp: ctx.timestamp,
    } as DTToolCallEvent);
  },

  tool_result: (e, ctx) => {
    devToolsEmitter.emitEvent({
      type: "tool_result",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      toolUseId: e.toolUseId as string,
      result: e.content,
      isError: !(e.success as boolean),
      timestamp: ctx.timestamp,
    } as DTToolResultEvent);
  },

  content_delta: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "content_delta",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: (e.tick as number) ?? 1,
      delta: e.delta as string,
      timestamp: ctx.timestamp,
    } as DTContentDeltaEvent);
  },

  compiled: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "compiled",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      system: e.system as string | undefined,
      messages: (e.messages ?? []) as Message[],
      tools: (e.tools ?? []) as ToolDefinition[],
      // Pipeline visibility: raw compiled structure (before rendering)
      rawCompiled: e.rawCompiled as DTCompiledEvent["rawCompiled"],
      // Pipeline visibility: formatted COMInput (after rendering)
      formattedInput: e.formattedInput as DTCompiledEvent["formattedInput"],
      timestamp: ctx.timestamp,
    } as DTCompiledEvent);
  },

  model_request: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "model_request",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      modelId: e.modelId as string | undefined,
      input: e.input as DTModelRequestEvent["input"],
      stage: e.stage as DTModelRequestEvent["stage"],
      timestamp: ctx.timestamp,
    } as DTModelRequestEvent);
  },

  provider_request: (e, ctx) => {
    if (!e.executionId) return;
    devToolsEmitter.emitEvent({
      type: "provider_request",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      modelId: e.modelId as string | undefined,
      provider: e.provider as string | undefined,
      providerInput: e.providerInput,
      timestamp: ctx.timestamp,
    } as DTProviderRequestEvent);
  },

  model_response: (e, ctx) => {
    if (!e.executionId) return;
    // Emit model_response with full pipeline visibility
    devToolsEmitter.emitEvent({
      type: "model_response",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      // Pipeline visibility: provider output (raw SDK response)
      providerOutput: e.providerOutput,
      // Pipeline visibility: ModelOutput (normalized Agentick format)
      modelOutput: e.modelOutput as DTModelResponseEvent["modelOutput"],
      // Pipeline visibility: Engine state (timeline integration)
      engineState: e.engineState as DTModelResponseEvent["engineState"],
      timestamp: ctx.timestamp,
    } as DTModelResponseEvent);
    // Also emit provider_response with raw details
    devToolsEmitter.emitEvent({
      type: "provider_response",
      executionId: e.executionId as string,
      sequence: (e.sequence as number) ?? 0,
      tick: e.tick as number,
      providerOutput: e.providerOutput,
      timestamp: ctx.timestamp,
    } as DTProviderResponseEvent);
  },
};

/**
 * Forward an app stream event to DevTools.
 *
 * Maps from app-level events (execution_start, tick_start, content_delta, etc.)
 * to DevTools event format. Only forwards if DevTools is enabled and has subscribers.
 *
 * This function is platform-agnostic - no Node.js dependencies.
 *
 * @param event - The app stream event to forward
 * @param context - Forwarding context with session info and devTools flag
 *
 * @example
 * ```typescript
 * forwardToDevTools(
 *   { type: 'tick_start', tick: 1, executionId: 'abc' },
 *   { sessionId: 'xyz', rootComponent: 'MyAgent', devToolsEnabled: true }
 * );
 * ```
 */
export function forwardToDevTools(
  event: { type: string; [key: string]: unknown },
  context: ForwardContext,
): void {
  if (!context.devToolsEnabled || !devToolsEmitter.hasSubscribers()) return;

  const forwarder = devToolsForwarders[event.type];
  if (!forwarder) return;

  forwarder(event, {
    sessionId: context.sessionId,
    rootComponent: context.rootComponent,
    timestamp: Date.now(),
  });
}
