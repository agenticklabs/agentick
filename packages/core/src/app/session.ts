/**
 * Session - The Execution Unit
 *
 * A session holds component state (fiber tree) across ticks.
 * Each tick: compile JSX -> call model -> execute tools -> decide continue?
 *
 * Design principles:
 * - Single class, no intermediate layers
 * - Minimal state - just what's needed for execution
 * - tick() is a Procedure returning ExecutionHandle (PromiseLike + AsyncIterable)
 * - Clean, elegant code over feature completeness
 *
 * @module tentickle/app/session
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  Context,
  createProcedure,
  Channel,
  EventBuffer,
  type KernelContext,
  type Procedure,
} from "../core/index.js";
import { FiberCompiler, StructureRenderer, ReconciliationScheduler, type SchedulerState } from "../compiler/index.js";
import { COM } from "../com/object-model.js";
import { MarkdownRenderer } from "../renderers/index.js";
import { ToolExecutor } from "../engine/tool-executor.js";
import { AbortError } from "../utils/abort-utils.js";
import { jsx } from "../jsx/jsx-runtime.js";
import type { JSX } from "../jsx/jsx-runtime.js";
import type { COMInput, COMOutput, COMTimelineEntry, TimelineTag } from "../com/types.js";
import type { ModelInstance } from "../model/model.js";
import type { ToolResult, ToolCall, Message, UsageStats, ContentBlock } from "@tentickle/shared";
import {
  devToolsEmitter,
  forwardToDevTools,
  type DTFiberSnapshotEvent,
  type DTFiberSummary,
} from "@tentickle/shared";
import type { ExecutableTool, ToolClass } from "../tool/tool.js";
import type { TickState } from "../component/component.js";
import type { ExecutionMessage } from "../engine/execution-types.js";
import type {
  Session,
  SessionStatus,
  SessionOptions,
  ExecutionOptions,
  SessionSnapshot,
  SessionInspection,
  SendResult,
  StreamEvent,
  AppOptions,
  ComponentFunction,
  RecordingMode,
  TickSnapshot,
  SessionRecording,
  SessionExecutionHandle,
} from "./types.js";

// ════════════════════════════════════════════════════════════════════════════
// Session Context Extension
// ════════════════════════════════════════════════════════════════════════════

/**
 * Session-specific context fields.
 * These are added to KernelContext when running session code.
 */
interface SessionContext {
  sessionId?: string;
  rootComponent?: string;
  devToolsEnabled?: boolean;
}

type StreamEventInput =
  | StreamEvent
  | (Omit<StreamEvent, "id" | "tick" | "timestamp" | "sequence"> &
      Partial<Pick<StreamEvent, "id" | "tick" | "timestamp" | "sequence">> &
      Record<string, unknown>);

/**
 * Get session context from the current ALS context.
 */
function getSessionContext(): SessionContext {
  const ctx = Context.tryGet();
  return {
    sessionId: (ctx as any)?.sessionId,
    rootComponent: (ctx as any)?.rootComponent,
    devToolsEnabled: (ctx as any)?.devToolsEnabled,
  };
}


/**
 * Session implementation.
 *
 * A session manages the execution lifecycle: compile JSX, call model, execute tools.
 * Component state (hooks, signals) persists across ticks within a session.
 */
export class SessionImpl<P = Record<string, unknown>> extends EventEmitter implements Session<P> {
  readonly id: string;

  // Core execution state
  private _status: SessionStatus = "idle";
  private _tick = 1;
  private _isAborted = false;
  private _currentExecutionId: string | null = null;

  // Hydration state (pending fiber tree data to restore)
  private _pendingHydrationData: import("../compiler/index.js").SerializedFiberNode | null = null;

  // Compilation infrastructure (no intermediate layer)
  private compiler: FiberCompiler | null = null;
  private com: COM | null = null;
  private structureRenderer: StructureRenderer | null = null;
  private scheduler: ReconciliationScheduler | null = null;

  // State that persists across ticks
  private _previousOutput: COMInput | null = null;
  private _currentOutput: COMOutput | null = null;

  // Message queue
  private _queuedMessages: Message[] = [];

  // Abort handling
  private sessionAbortController: AbortController;
  private executionAbortController: AbortController | null = null;
  private executionAbortCleanup: Array<() => void> = [];

  // Event streaming
  private _eventQueue: StreamEvent[] = [];
  private _eventResolvers: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private _executionComplete = false;
  private _sequence = 0; // Monotonically increasing sequence number for durable streams

  // Usage tracking
  private _totalUsage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ticks: 0,
  };

  // Last model output tracking
  private _lastModelOutput: { content: ContentBlock[]; stopReason: string } | null = null;

  // Recording support
  private _recording: SessionRecording | null = null;
  private _recordingMode: RecordingMode | null = null;
  private _recordingStartedAt: string | null = null;
  private _snapshots: TickSnapshot[] = [];

  // Configuration
  private readonly Component: ComponentFunction<P>;
  private readonly appOptions: AppOptions;
  private readonly sessionOptions: SessionOptions;

  // Last props for hot-update support
  private _lastProps: P | null = null;

  // Captured context from session creation
  private readonly _capturedContext: KernelContext | undefined;

  // Channels for pub/sub communication
  private readonly _channels = new Map<string, Channel>();

  // Current execution handle (for concurrent send idempotency)
  private _currentHandle: SessionExecutionHandle | null = null;
  private _currentResultResolve: ((result: SendResult) => void) | null = null;
  private _currentResultReject: ((error: Error) => void) | null = null;

  constructor(
    Component: ComponentFunction<P>,
    appOptions: AppOptions,
    sessionOptions: SessionOptions = {},
  ) {
    super();
    this.id = randomUUID();
    this.Component = Component;
    this.appOptions = appOptions;
    this.sessionOptions = sessionOptions;

    // Capture ALS context at session creation time
    // Include Tentickle middleware registry if available (for procedure middleware support)
    const currentContext = Context.tryGet();
    const tentickleInstance = (appOptions as { _tentickleInstance?: KernelContext["middleware"] })._tentickleInstance;
    if (tentickleInstance && currentContext) {
      this._capturedContext = { ...currentContext, middleware: tentickleInstance };
    } else if (tentickleInstance && !currentContext) {
      this._capturedContext = Context.create({ middleware: tentickleInstance });
    } else {
      this._capturedContext = currentContext;
    }

    // Create session abort controller linked to external signals
    this.sessionAbortController = new AbortController();
    const externalSignal = sessionOptions.signal ?? appOptions.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.sessionAbortController.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", () => {
          this.sessionAbortController.abort(externalSignal.reason);
        });
      }
    }

    // Hydrate from snapshot if provided
    if (sessionOptions.snapshot) {
      this.hydrate(sessionOptions.snapshot);
    }

    // Seed initial timeline if provided
    if (sessionOptions.initialTimeline?.length) {
      this._previousOutput = {
        timeline: sessionOptions.initialTimeline as any,
        system: [],
        ephemeral: [],
        sections: {},
        tools: [],
        metadata: {},
      };
    }

    // Start recording if enabled via options
    if (sessionOptions.recording) {
      this.startRecording(sessionOptions.recording);
    }

    // Initialize procedures
    this.initProcedures();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Public Properties
  // ════════════════════════════════════════════════════════════════════════

  get status(): SessionStatus {
    return this._status;
  }

  get currentTick(): number {
    return this._tick;
  }

  get isAborted(): boolean {
    return this._isAborted;
  }

  get queuedMessages(): readonly Message[] {
    return this._queuedMessages;
  }

  /**
   * Observable scheduler state for DevTools.
   *
   * Returns a Signal containing the scheduler's current state,
   * including status, pending reasons, and reconciliation metrics.
   *
   * Returns null if the session hasn't been initialized yet.
   *
   * @example
   * ```typescript
   * // In DevTools
   * effect(() => {
   *   const state = session.schedulerState?.();
   *   if (state) {
   *     console.log(`Status: ${state.status}, reconciles: ${state.reconcileCount}`);
   *   }
   * });
   * ```
   */
  get schedulerState() {
    return this.scheduler?.state ?? null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Queue Procedure
  // ════════════════════════════════════════════════════════════════════════

  queue!: Procedure<(message: Message) => Promise<void>, true>;

  private initProcedures(): void {
    // Queue procedure - queues messages and notifies components
    this.queue = createProcedure(
      {
        name: "session:queue",
        metadata: { operation: "queue" },
        handleFactory: false,
        executionBoundary: false,
      },
      async (message: Message): Promise<void> => {
        if (this._status === "closed") {
          throw new Error("Session is closed");
        }
        this._queuedMessages.push(message);

        // Publish to messages channel for reactive updates
        this.channel("messages").publish({
          type: "message_queued",
          channel: "messages",
          payload: message,
        });

        // Notify components via useOnMessage hooks if compiler exists
        if (this.compiler) {
          const executionMessage: ExecutionMessage = {
            id: randomUUID(),
            type: "user",
            content: message,
            timestamp: Date.now(),
          };
          const tickState: TickState = {
            tick: this._tick,
            stop: () => {},
            queuedMessages: [],
          };
          await this.compiler.notifyOnMessage(executionMessage, tickState);
        }
      },
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // send() - Returns SessionExecutionHandle
  // Concurrent calls return THE SAME handle
  // ════════════════════════════════════════════════════════════════════════

  send(input: {
    messages?: Message[];
    message?: Message;
    props?: P;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }): SessionExecutionHandle {
    if (this._status === "closed") {
      throw new Error("Session is closed");
    }

    const { messages, message, props, metadata, signal } = input;

    // Normalize messages
    const allMessages = ([] as Message[])
      .concat(messages || [])
      .concat(message ? [message] : [])
      .map((m) => (metadata ? { ...m, metadata } : m));

    // Update props if provided
    if (props) {
      this._lastProps = props;
    }

    // Queue messages synchronously and notify components
    for (const msg of allMessages) {
      this._queuedMessages.push(msg);
      this.channel("messages").publish({
        type: "message_queued",
        channel: "messages",
        payload: msg,
      });

      // Notify components via useOnMessage hooks if compiler exists
      if (this.compiler) {
        const executionMessage: ExecutionMessage = {
          id: randomUUID(),
          type: "user",
          content: msg,
          timestamp: Date.now(),
        };
        const tickState: TickState = {
          tick: this._tick,
          stop: () => {},
          queuedMessages: [],
        };
        // Fire and forget - don't await to keep send() synchronous
        this.compiler.notifyOnMessage(executionMessage, tickState).catch(() => {});
      }
    }

    // If already running, return the existing handle (concurrent send idempotency)
    if (this._status === "running" && this._currentHandle) {
      this.addExecutionSignal(signal);
      return this._currentHandle;
    }

    // If idle and we have something to do, start tick
    if ((allMessages.length > 0 || props) && this._status === "idle") {
      const tickProps = this._lastProps;
      if (tickProps !== null) {
        return this.tick(tickProps, { signal });
      }
    }

    // Nothing to do - create a handle that resolves immediately with empty result
    return this.createEmptyHandle();
  }

  // ════════════════════════════════════════════════════════════════════════
  // tick() - Returns SessionExecutionHandle
  // If already running, returns the existing handle (hot-update)
  // ════════════════════════════════════════════════════════════════════════

  tick(props: P, options?: ExecutionOptions): SessionExecutionHandle {
    if (this._status === "closed") {
      throw new Error("Session is closed");
    }

    const hasProps =
      props != null &&
      (typeof props !== "object" || Object.keys(props as Record<string, unknown>).length > 0);
    if (!hasProps && this._queuedMessages.length === 0) {
      return this.createEmptyHandle();
    }

    // Hot-update: if already running, update props and return existing handle
    if (this._status === "running" && this._currentHandle) {
      this._lastProps = props;
      this.addExecutionSignal(options?.signal);
      return this._currentHandle;
    }

    // Create new execution
    this._lastProps = props;
    const handle = this.createSessionHandle(props, options);
    this._currentHandle = handle;
    return handle;
  }

  // ════════════════════════════════════════════════════════════════════════
  // SessionExecutionHandle Creation
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Create a SessionExecutionHandle with explicit delegation.
   * The handle is PromiseLike + AsyncIterable.
   */
  private createSessionHandle(props: P, options?: ExecutionOptions): SessionExecutionHandle {
    const session = this;
    const events = new EventEmitter();
    const traceId = randomUUID();

    // Create the result promise
    let resolveResult: (result: SendResult) => void;
    let rejectResult: (error: Error) => void;
    const resultPromise = new Promise<SendResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Prevent unhandled rejections when abort happens before awaiting.
    resultPromise.catch(() => {});

    // Store resolvers for external completion
    this._currentResultResolve = resolveResult!;
    this._currentResultReject = rejectResult!;

    // Track status
    let status: "running" | "completed" | "error" | "aborted" = "running";

    // Event queue for async iteration
    const eventQueue: StreamEvent[] = [];
    const eventResolvers: ((value: IteratorResult<StreamEvent>) => void)[] = [];
    let iterationComplete = false;

    this.startExecutionAbort(options?.signal);

    // Create event buffer for dual consumption BEFORE starting execution
    const eventBuffer = new EventBuffer<StreamEvent>();
    // Forward events to event buffer
    events.on("*", (event: StreamEvent) => {
      eventBuffer.push(event);
    });

    const pushEvent = (event: StreamEvent) => {
      if (eventResolvers.length > 0) {
        const resolver = eventResolvers.shift()!;
        resolver({ value: event, done: false });
      } else {
        eventQueue.push(event);
      }
      events.emit("event", event);
      events.emit("*", event);
    };

    const completeIteration = () => {
      iterationComplete = true;
      eventBuffer.close();
      for (const resolver of eventResolvers) {
        resolver({ value: undefined as any, done: true });
      }
      eventResolvers.length = 0;
    };

    // Start execution asynchronously
    (async () => {
      try {
        const result = await this.runWithContext(() => this.executeTick(props, options));
        status = "completed";
        // Call onComplete callback
        try {
          this.callbacks.onComplete?.(result);
        } catch {
          // Callbacks should not throw
        }
        resolveResult!(result);
        completeIteration();
      } catch (error) {
        status = "error";
        const err = error instanceof Error ? error : new Error(String(error));
        // Call onError callback
        try {
          this.callbacks.onError?.(err);
        } catch {
          // Callbacks should not throw
        }
        eventBuffer.error(err);
        rejectResult!(err);
        completeIteration();
      } finally {
        this._currentHandle = null;
        this._currentResultResolve = null;
        this._currentResultReject = null;
        this._isAborted = false;
        this.finishExecutionAbort();
      }
    })();

    // Create handle - use .result for final value, not PromiseLike
    const handle: SessionExecutionHandle = {
      // AsyncIterable delegation - delegates to EventBuffer for dual consumption
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return eventBuffer[Symbol.asyncIterator]();
      },

      // ExecutionHandle properties
      get status() {
        return status;
      },
      get traceId() {
        return traceId;
      },
      get eventBuffer() {
        return eventBuffer;
      },
      get events() {
        return eventBuffer;
      },
      get result() {
        return resultPromise;
      },
      abort(reason?: string) {
        if (status === "running") {
          status = "aborted";
          session._isAborted = true;
          session.executionAbortController?.abort(reason ?? "Aborted via handle");
          eventBuffer.close();
          rejectResult!(new AbortError(reason ?? "Aborted via handle", "ABORT_SIGNAL"));
          completeIteration();
        }
      },

      // Session-specific properties
      get sessionId() {
        return session.id;
      },
      get currentTick() {
        return session._tick;
      },
      queueMessage(message: Message) {
        session._queuedMessages.push(message);
        session.channel("messages").publish({
          type: "message_queued",
          channel: "messages",
          payload: message,
        });
      },
      submitToolResult(toolUseId: string, result: ToolResult) {
        session.channel("tool_confirmation").publish({
          type: "response",
          channel: "tool_confirmation",
          id: toolUseId,
          payload: result,
        });
      },
    };

    // Wire up event emission from session to handle
    this.on("event", pushEvent);

    return handle;
  }

  /**
   * Create an empty handle for when there's nothing to do.
   */
  private createEmptyHandle(): SessionExecutionHandle {
    const session = this;
    const emptyResult: SendResult = {
      response: "",
      outputs: {},
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      raw: {
        timeline: [],
        system: [],
        ephemeral: [],
        sections: {},
        tools: [],
        metadata: {},
      },
    };

    // Empty event buffer for empty handle
    const emptyEventBuffer = new EventBuffer<StreamEvent>();
    emptyEventBuffer.close();

    const handle: SessionExecutionHandle = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return emptyEventBuffer[Symbol.asyncIterator]();
      },
      get status() {
        return "completed" as const;
      },
      get traceId() {
        return randomUUID();
      },
      get eventBuffer() {
        return emptyEventBuffer;
      },
      get events() {
        return emptyEventBuffer;
      },
      get result() {
        return Promise.resolve(emptyResult);
      },
      abort() {},
      get sessionId() {
        return session.id;
      },
      get currentTick() {
        return session._tick;
      },
      queueMessage(message: Message) {
        session._queuedMessages.push(message);
      },
      submitToolResult(_toolUseId: string, _result: ToolResult) {},
    };

    return handle;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Channels
  // ════════════════════════════════════════════════════════════════════════

  channel(name: string): Channel {
    let channel = this._channels.get(name);
    if (!channel) {
      channel = new Channel(name);
      this._channels.set(name, channel);
    }
    return channel;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Deprecated Methods (for backward compatibility)
  // ════════════════════════════════════════════════════════════════════════

  async queueMessage(message: Message): Promise<void> {
    // queue is a pass-through procedure, returns void directly
    await this.queue.exec(message);
  }

  async sendMessage(message: Message | Message[], props?: P): Promise<void> {
    const messages = Array.isArray(message) ? message : [message];
    const handle = this.send({ messages, props });
    await handle.result;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Interrupt & Abort
  // ════════════════════════════════════════════════════════════════════════

  interrupt(message?: Message, reason?: string): void {
    if (this._status === "closed") {
      throw new Error("Session is closed");
    }

    if (message) {
      this._queuedMessages.push(message);
    }

    if (this._status === "running") {
      this._isAborted = true;
      this.executionAbortController?.abort(reason ?? "interrupt");
    }
  }

  clearAbort(): void {
    this._isAborted = false;
  }

  private startExecutionAbort(signal?: AbortSignal): void {
    this.executionAbortCleanup.forEach((cleanup) => cleanup());
    this.executionAbortCleanup = [];
    this._isAborted = false;
    this.executionAbortController = new AbortController();

    this.addExecutionSignal(this.sessionAbortController.signal);
    this.addExecutionSignal(signal);
  }

  private addExecutionSignal(signal?: AbortSignal): void {
    if (!signal || !this.executionAbortController) return;
    if (signal.aborted) {
      this._isAborted = true;
      this.executionAbortController.abort(signal.reason);
      return;
    }
    const handler = () => {
      this._isAborted = true;
      this.executionAbortController?.abort(signal.reason);
    };
    signal.addEventListener("abort", handler);
    this.executionAbortCleanup.push(() => signal.removeEventListener("abort", handler));
  }

  private finishExecutionAbort(): void {
    this.executionAbortCleanup.forEach((cleanup) => cleanup());
    this.executionAbortCleanup = [];
    this.executionAbortController = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Events (AsyncIterable)
  // ════════════════════════════════════════════════════════════════════════

  events(): AsyncIterable<StreamEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            if (self._eventQueue.length > 0) {
              return { value: self._eventQueue.shift()!, done: false };
            }
            if (self._executionComplete) {
              return { value: undefined as any, done: true };
            }
            return new Promise((resolve) => {
              self._eventResolvers.push(resolve);
            });
          },
        };
      },
    };
  }

  /**
   * Get merged lifecycle callbacks (session overrides app).
   */
  private get callbacks() {
    return {
      onEvent: this.sessionOptions.onEvent ?? this.appOptions.onEvent,
      onTickStart: this.sessionOptions.onTickStart ?? this.appOptions.onTickStart,
      onTickEnd: this.sessionOptions.onTickEnd ?? this.appOptions.onTickEnd,
      onComplete: this.sessionOptions.onComplete ?? this.appOptions.onComplete,
      onError: this.sessionOptions.onError ?? this.appOptions.onError,
    };
  }

  private emitEvent(event: StreamEventInput): void {
    const executionId = this._currentExecutionId ?? Context.tryGet()?.executionId;

    // Enrich event with executionId and tick if missing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let enrichedEvent: any = executionId && !("executionId" in event) ? { ...event, executionId } : event;

    if (!("id" in event)) {
      enrichedEvent = { ...enrichedEvent, id: randomUUID() };
    }

    if (!("timestamp" in event)) {
      enrichedEvent = { ...enrichedEvent, timestamp: new Date().toISOString() };
    }

    // Always set tick if missing - session knows the actual tick
    if (!("tick" in event)) {
      enrichedEvent = { ...enrichedEvent, tick: this._tick || 1 };
    }

    // Assign monotonically increasing sequence number for durable streams
    this._sequence++;
    enrichedEvent = { ...enrichedEvent, sequence: this._sequence };

    // Forward to DevTools (check context for overrides)
    const sessionCtx = getSessionContext();
    forwardToDevTools(enrichedEvent, {
      sessionId: sessionCtx.sessionId ?? this.id,
      rootComponent: sessionCtx.rootComponent ?? (this.Component.name || "Agent"),
      devToolsEnabled: sessionCtx.devToolsEnabled ?? this.sessionOptions.devTools ?? false,
    });

    // Invoke lifecycle callbacks
    const cb = this.callbacks;
    try {
      cb.onEvent?.(enrichedEvent);

      // Call specific callbacks based on event type
      const eventType = enrichedEvent.type;
      if (eventType === "tick_start") {
        cb.onTickStart?.(enrichedEvent.tick, enrichedEvent.executionId);
      } else if (eventType === "tick_end") {
        cb.onTickEnd?.(enrichedEvent.tick, enrichedEvent.usage);
      }
    } catch {
      // Callbacks should not throw, but don't let them break execution
    }

    // Emit via EventEmitter
    this.emit("event", enrichedEvent);

    // Also queue for AsyncIterable consumers
    if (this._eventResolvers.length > 0) {
      const resolve = this._eventResolvers.shift()!;
      resolve({ value: enrichedEvent, done: false });
    } else {
      this._eventQueue.push(enrichedEvent);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Snapshot & Inspect
  // ════════════════════════════════════════════════════════════════════════

  snapshot(): SessionSnapshot {
    return {
      version: "1.0",
      tick: this._tick,
      timeline: this._previousOutput?.timeline ?? null,
      componentState: this.serializeFiberTree(), // Serialized fiber tree with hook states
      usage: { ...this._totalUsage },
      timestamp: Date.now(),
    };
  }

  inspect(): SessionInspection {
    // Get fiber summary for component/hook stats
    const fiberSummary = this.getFiberSummary();

    // Get component names from fiber tree
    const componentNames = this.collectComponentNames();

    // Get last tick's tool data from snapshots if available
    const lastSnapshot = this._snapshots.length > 0
      ? this._snapshots[this._snapshots.length - 1]
      : null;

    return {
      id: this.id,
      status: this._status,
      currentTick: this._tick,
      queuedMessages: [...this._queuedMessages],
      currentPhase: this._status === "running" ? "model" : undefined, // Approximate
      isAborted: this._isAborted,
      lastOutput: this._previousOutput,
      lastModelOutput: this._lastModelOutput,
      lastToolCalls: lastSnapshot?.tools.calls ?? [],
      lastToolResults: lastSnapshot?.tools.results.map((r) => ({
        toolUseId: r.toolUseId,
        name: r.name,
        success: r.success,
      })) ?? [],
      totalUsage: { ...this._totalUsage },
      tickCount: this._totalUsage.ticks ?? 0,
      components: {
        count: fiberSummary.componentCount,
        names: componentNames,
      },
      hooks: {
        count: fiberSummary.hookCount,
        byType: fiberSummary.hooksByType,
      },
    };
  }

  /**
   * Collect unique component names from the fiber tree.
   */
  private collectComponentNames(): string[] {
    if (!this.compiler) return [];

    const tree = this.compiler.serializeFiberTree();
    if (!tree) return [];

    const names = new Set<string>();
    const collectNames = (node: import("../compiler/index.js").SerializedFiberNode) => {
      // Skip host primitives (Section, Message, etc.) and fragments
      if (!node.type.startsWith("tentickle.") && node.type !== "Fragment") {
        names.add(node.type);
      }
      for (const child of node.children) {
        collectNames(child);
      }
    };
    collectNames(tree);
    return Array.from(names);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Recording (stub - can add back if needed)
  // ════════════════════════════════════════════════════════════════════════

  startRecording(mode: RecordingMode): void {
    this._recordingMode = mode;
    this._recordingStartedAt = new Date().toISOString();
    this._snapshots = [];
    this._recording = {
      sessionId: this.id,
      startedAt: this._recordingStartedAt,
      config: {
        componentName: this.Component.name || "Anonymous",
        initialProps: {},
        maxTicks: this.appOptions.maxTicks ?? 10,
        mode,
      },
      inputs: [],
      snapshots: this._snapshots,
      summary: {
        tickCount: 0,
        totalDuration: 0,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, ticks: 0 },
        finalStatus: "running",
      },
    };
  }

  stopRecording(): void {
    if (this._recording) {
      this._recording.endedAt = new Date().toISOString();
      this._recording.summary.tickCount = this._snapshots.length;
      this._recording.summary.totalUsage = { ...this._totalUsage };
      this._recording.summary.finalStatus = this._status === "idle" ? "completed" : this._status as any;
    }
    this._recordingMode = null;
  }

  getRecording(): SessionRecording | null {
    if (this._recording) {
      // Update summary with current state
      this._recording.summary.tickCount = this._snapshots.length;
      this._recording.summary.totalUsage = { ...this._totalUsage };
    }
    return this._recording;
  }

  getSnapshotAt(tick: number): TickSnapshot | null {
    return this._snapshots.find((s) => s.tick === tick) ?? null;
  }

  /**
   * Record a tick snapshot for time-travel debugging.
   */
  private recordSnapshot(
    tickNumber: number,
    tickStartTime: number,
    tickData: {
      formatted?: COMInput;
      modelId?: string | null;
      modelInput?: string;
      modelStartTime?: number;
      modelOutput?: any;
      toolCalls?: ToolCall[];
      toolResults?: ToolResult[];
      toolStartTime?: number;
      shouldContinue?: boolean;
      stopReason?: string;
    },
  ): void {
    if (!this._recordingMode) return;

    const {
      formatted,
      modelId,
      modelInput,
      modelStartTime,
      modelOutput,
      toolCalls = [],
      toolResults = [],
      toolStartTime,
      shouldContinue = false,
      stopReason,
    } = tickData;

    const now = Date.now();
    const fiberSummary = this.getFiberSummary();

    // Extract COM data from formatted input
    const comSections: Record<string, { content: string; priority?: number }> = {};
    if (formatted?.sections) {
      for (const [id, section] of Object.entries(formatted.sections)) {
        comSections[id] = {
          content: typeof section.content === "string"
            ? section.content
            : JSON.stringify(section.content),
          priority: (section as any).priority,
        };
      }
    }

    // Extract tool definitions (ToolDefinition has name/description/input directly)
    const comTools = (formatted?.tools ?? []).map((t) => ({
      name: t.name ?? "unknown",
      description: t.description,
      inputSchema: t.input,
    }));

    const snapshot: TickSnapshot = {
      sessionId: this.id,
      tick: tickNumber,
      timestamp: new Date().toISOString(),
      duration: now - tickStartTime,
      fiber: {
        tree: this._recordingMode === "full" ? this.serializeFiberTree() : null,
        summary: fiberSummary,
      },
      com: {
        sections: comSections,
        timeline: formatted?.timeline ?? [],
        tools: comTools,
        modelId: modelId ?? null,
        metadata: formatted?.metadata ?? {},
      },
      model: {
        input: {
          formatted: modelInput ?? "",
          tokenCount: undefined, // Could be populated if available
        },
        output: {
          content: modelOutput?.message?.content ?? [],
          stopReason: modelOutput?.stopReason ?? "unknown",
          tokenCount: modelOutput?.usage?.outputTokens,
        },
        latency: modelStartTime ? (toolStartTime ?? now) - modelStartTime : 0,
      },
      tools: {
        calls: toolCalls,
        results: toolResults.map((r) => ({
          toolUseId: r.toolUseId,
          name: r.name ?? "unknown",
          success: !r.error,
          content: r.content,
        })),
        totalDuration: toolStartTime ? now - toolStartTime : 0,
      },
      execution: {
        phase: "complete",
        shouldContinue,
        stopReason,
        queuedMessages: [...this._queuedMessages],
        executionId: Context.tryGet()?.executionId,
      },
    };

    this._snapshots.push(snapshot);
  }

  private serializeFiberTree(): import("../compiler/index.js").SerializedFiberNode | null {
    if (!this.compiler) return null;
    return this.compiler.serializeFiberTree();
  }

  private getFiberSummary(): import("../compiler/index.js").FiberSummary {
    if (!this.compiler) {
      return { componentCount: 0, hookCount: 0, hooksByType: {} };
    }
    return this.compiler.getFiberSummary();
  }

  /**
   * Emit a fiber_snapshot event to DevTools after each tick.
   * This enables the Fiber Tree panel in DevTools to show component hierarchy and hook values.
   */
  private emitFiberSnapshot(tick: number, executionId: string): void {
    // Only emit if DevTools has subscribers (avoid serialization overhead)
    if (!devToolsEmitter.hasSubscribers()) return;

    try {
      const tree = this.serializeFiberTree();
      const summary = this.getFiberSummary();

      const event: DTFiberSnapshotEvent = {
        type: "fiber_snapshot",
        sessionId: this.id,
        executionId,
        sequence: ++this._sequence, // Use session's sequence counter for DevTools events
        tick,
        timestamp: Date.now(),
        tree: tree as DTFiberSnapshotEvent["tree"],
        summary: summary as DTFiberSummary,
      };

      devToolsEmitter.emitEvent(event);
    } catch {
      // Silently ignore serialization errors - DevTools is optional
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Close
  // ════════════════════════════════════════════════════════════════════════

  close(): void {
    if (this._status === "closed") return;

    this._status = "closed";
    this.sessionAbortController.abort("Session closed");
    this.executionAbortController?.abort("Session closed");

    // Complete any pending event iterators
    this._executionComplete = true;
    for (const resolve of this._eventResolvers) {
      resolve({ value: undefined as any, done: true });
    }
    this._eventResolvers = [];

    // Dispose scheduler (cancels pending work and cleans up signal)
    if (this.scheduler) {
      this.scheduler.dispose();
      this.scheduler = null;
    }

    // Unmount compiler if it exists
    if (this.compiler) {
      this.compiler.unmount().catch(() => {});
      this.compiler = null;
    }

    this.com = null;
    this.structureRenderer = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Internal: Execution
  // ════════════════════════════════════════════════════════════════════════

  private async runWithContext<T>(fn: () => Promise<T>): Promise<T> {
    const current = Context.tryGet();
    const baseContext = this._capturedContext || current;

    // Session-specific context fields for DevTools enrichment
    const sessionContext = {
      sessionId: this.id,
      rootComponent: this.Component.name || "Agent",
      devToolsEnabled: this.sessionOptions.devTools ?? false,
    };

    if (!baseContext) {
      // No base context - create minimal context with session fields
      return Context.run(Context.create(sessionContext as any), fn);
    }

    // Merge base, current, and session context
    const merged = { ...baseContext, ...(current ?? {}), ...sessionContext };
    return Context.run(merged as any, fn);
  }

  private hydrate(snapshot: SessionSnapshot): void {
    this._tick = snapshot.tick;

    // Hydrate timeline (conversation history)
    if (snapshot.timeline) {
      this._previousOutput = {
        timeline: snapshot.timeline as any,
        system: [],
        ephemeral: [],
        sections: {},
        tools: [],
        metadata: {},
      };
    }

    // Hydrate usage stats
    if (snapshot.usage) {
      this._totalUsage = { ...snapshot.usage };
    }

    // Hydrate fiber tree (component state)
    // This will be applied when the compiler is first created
    if (snapshot.componentState) {
      this._pendingHydrationData = snapshot.componentState as import("../compiler/index.js").SerializedFiberNode;
    }
  }

  /**
   * The core tick execution loop.
   *
   * This is where the magic happens:
   * 1. Setup compilation infrastructure (COM, FiberCompiler)
   * 2. Loop: compile -> model -> tools -> ingest
   * 3. Return result
   */
  private async executeTick(props: P, options?: ExecutionOptions): Promise<SendResult> {
    if (this._status === "closed") {
      throw new Error("Session is closed");
    }

    const signal = this.executionAbortController?.signal ?? this.sessionAbortController.signal;
    if (signal.aborted) {
      throw new AbortError("Session aborted", signal.reason);
    }

    this._status = "running";
    this._executionComplete = false;
    this._lastProps = props;

    const executionId = Context.tryGet()?.executionId || randomUUID();
    this._currentExecutionId = executionId;
    const maxTicks =
      options?.maxTicks ?? this.sessionOptions.maxTicks ?? this.appOptions.maxTicks ?? 10;
    const timestamp = () => new Date().toISOString();

    // Create root JSX element
    const rootElement = jsx(this.Component as any, props);

    // Setup or reuse compilation infrastructure
    await this.ensureCompilationInfrastructure(rootElement);

    // Transfer queued messages to COM
    if (this._queuedMessages.length > 0 && this.com) {
      for (const msg of this._queuedMessages) {
        this.com.queueMessage({
          id: randomUUID(),
          type: "user",
          content: msg,
        } as any);
      }
      this._queuedMessages = [];
    }

    // Track state for this execution
    const usage: UsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ticks: 0,
    };
    let stopReason: string | undefined;
    let output: COMInput | undefined;
    const outputs: Record<string, unknown> = {};
    const responseChunks: string[] = [];
    const toolExecutor = new ToolExecutor();

    this.emitEvent({
      type: "execution_start",
      executionId,
      timestamp: timestamp(),
    });

    try {
      // Tick loop
      let shouldContinue = true;
      while (shouldContinue && this._tick <= maxTicks) {
        if (signal.aborted) {
          throw new AbortError("Execution aborted", signal.reason);
        }

        const currentTick = this._tick;
        const tickStartTime = Date.now();

        this.emitEvent({
          type: "tick_start",
          tick: currentTick,
          timestamp: timestamp(),
        });

        // Phase 1: Compile
        const compiled = await this.compileTick(rootElement);

        // Emit compiled context to DevTools
        // Extract system text from COMTimelineEntry[]
        const systemText = compiled.formatted?.system
          ?.map((entry: any) => {
            const content = entry.message?.content ?? entry.content;
            if (Array.isArray(content)) {
              return content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n");
            }
            return String(content ?? "");
          })
          .filter(Boolean)
          .join("\n\n");

        this.emitEvent({
          type: "compiled",
          tick: currentTick,
          timestamp: timestamp(),
          system: systemText || undefined,
          messages: compiled.formatted?.timeline,
          tools: compiled.tools?.map((t: any) => ({
            name: t.metadata?.name ?? t.name,
            description: t.metadata?.description ?? t.description,
          })),
        });

        if (compiled.shouldStop) {
          stopReason = compiled.stopReason;
          this.emitEvent({
            type: "tick_end",
            tick: currentTick,
            shouldContinue: false,
            timestamp: timestamp(),
          });

          // Emit fiber snapshot to DevTools
          this.emitFiberSnapshot(currentTick, executionId);
          // Clear queued messages - they were made available during compilation
          this.com?.clearQueuedMessages();
          break;
        }

        // Phase 2: Model
        const model = this.appOptions.model ?? compiled.model;
        if (!model) {
          throw new Error("No model configured. Add a <Model> component or pass model in options.");
        }

        if (signal.aborted) {
          throw new AbortError("Execution aborted", signal.reason);
        }

        const modelInput = compiled.modelInput ?? compiled.formatted;
        const modelStartTime = Date.now();

        // Emit model request to DevTools (provider-formatted input)
        this.emitEvent({
          type: "model_request",
          tick: currentTick,
          timestamp: timestamp(),
          modelId: model?.metadata?.id ?? model?.metadata?.model,
          input: modelInput,
        });

        // Stream model output if supported
        let modelOutput: any;
        if (model.stream) {
          const streamIterable = await model.stream(modelInput);
          for await (const event of streamIterable) {
            if (signal.aborted) {
              throw new AbortError("Execution aborted", signal.reason);
            }
            this.emitEvent(event as StreamEvent);

            if (event.type === "content_delta" && "delta" in event) {
              responseChunks.push((event as any).delta);
            }

            if (event.type === "message" && "message" in event) {
              const messageEvent = event as any;
              modelOutput = {
                messages: [messageEvent.message],
                message: messageEvent.message,
                stopReason: messageEvent.stopReason,
                usage: messageEvent.usage,
                raw: messageEvent,
              };
            }
          }

          if (!modelOutput) {
            modelOutput = await model.generate(modelInput);
          }
        } else {
          modelOutput = await model.generate(modelInput);
        }

        // Extract text from model output
        if (modelOutput?.message) {
          const textContent = modelOutput.message.content?.find((b: any) => b.type === "text");
          if (textContent && "text" in textContent) {
            responseChunks.length = 0;
            responseChunks.push(textContent.text);
          }
        }

        // Update usage
        if (modelOutput?.usage) {
          usage.inputTokens += modelOutput.usage.inputTokens ?? 0;
          usage.outputTokens += modelOutput.usage.outputTokens ?? 0;
          usage.totalTokens += modelOutput.usage.totalTokens ?? 0;
        }

        if (signal.aborted) {
          throw new AbortError("Execution aborted", signal.reason);
        }

        // Convert model output to engine format
        if (!model.toEngineState) {
          throw new Error("Model missing toEngineState method");
        }
        const response = await model.toEngineState(modelOutput);

        // Emit model response to DevTools (raw provider output + transformed)
        this.emitEvent({
          type: "model_response",
          tick: currentTick,
          timestamp: timestamp(),
          rawOutput: modelOutput,
          transformedResponse: response,
          usage: modelOutput?.usage,
        });

        // Track last model output for inspection
        if (modelOutput?.message) {
          this._lastModelOutput = {
            content: modelOutput.message.content ?? [],
            stopReason: modelOutput.stopReason ?? "unknown",
          };
        }

        // Phase 3: Tools
        let toolResults: ToolResult[] = [];
        let toolStartTime: number | undefined;
        if (response.toolCalls?.length && this.com) {
          toolStartTime = Date.now();
          for (const call of response.toolCalls) {
            const toolCallTimestamp = timestamp();
            this.emitEvent({
              type: "tool_call",
              callId: call.id,
              blockIndex: 0,
              name: call.name,
              input: call.input,
              startedAt: toolCallTimestamp,
              completedAt: toolCallTimestamp,
            });
          }

          toolResults = await this.executeTools(
            toolExecutor,
            response.toolCalls,
            compiled.tools,
            outputs,
            currentTick,
            timestamp,
          );
        }

        // Phase 4: Ingest
        const ingestResult = await this.ingestTickResult(response, toolResults);
        shouldContinue = ingestResult.shouldContinue;

        this.emitEvent({
          type: "tick_end",
          tick: currentTick,
          shouldContinue,
          usage: modelOutput?.usage,
          stopReason: modelOutput?.stopReason,
          model: model?.metadata?.id || model?.metadata?.model,
          timestamp: timestamp(),
        });

        // Emit fiber snapshot to DevTools
        this.emitFiberSnapshot(currentTick, executionId);

        // Clear queued messages after tick completes - they've been processed
        this.com?.clearQueuedMessages();

        // Record snapshot if recording is enabled
        this.recordSnapshot(currentTick, tickStartTime, {
          formatted: compiled.formatted,
          modelId: model?.metadata?.id ?? model?.metadata?.model ?? null,
          modelInput: typeof modelInput === "string" ? modelInput : JSON.stringify(modelInput),
          modelStartTime,
          modelOutput,
          toolCalls: response.toolCalls ?? [],
          toolResults,
          toolStartTime,
          shouldContinue,
          stopReason,
        });

        this._tick++;
        usage.ticks = (usage.ticks ?? 0) + 1;
      }

      // Complete
      output = await this.complete();
      this._previousOutput = output;

      // Accumulate usage
      this._totalUsage.inputTokens += usage.inputTokens;
      this._totalUsage.outputTokens += usage.outputTokens;
      this._totalUsage.totalTokens += usage.totalTokens;
      this._totalUsage.ticks = (this._totalUsage.ticks ?? 0) + (usage.ticks ?? 0);

      const resultPayload = {
        response: responseChunks.join(""),
        outputs,
        usage,
        stopReason,
      };

      this.emitEvent({
        type: "result",
        result: resultPayload,
        timestamp: timestamp(),
      });
    } finally {
      this._executionComplete = true;

      // Ensure queued messages are cleared even on error/abort paths
      // (normal path already clears at tick_end, this is a safety net)
      this.com?.clearQueuedMessages();

      this.emitEvent({
        type: "execution_end",
        executionId,
        stopReason,
        aborted: this._isAborted,
        usage,
        output: output ?? null,
        timestamp: timestamp(),
      });

      // Clear execution ID after emitting execution_end
      this._currentExecutionId = null;

      for (const resolve of this._eventResolvers) {
        resolve({ value: undefined as any, done: true });
      }
      this._eventResolvers = [];

      this._status = "idle";
    }

    return {
      response: responseChunks.join(""),
      outputs,
      usage,
      stopReason,
      raw: output!,
    };
  }

  /**
   * Ensure compilation infrastructure exists or reset for new run.
   */
  private async ensureCompilationInfrastructure(_rootElement: JSX.Element): Promise<void> {
    if (this.com && this.compiler && this.structureRenderer) {
      // Reuse existing - reset for new run
      this.com.clear();
      this._tick = 1;
      return;
    }

    // Create new infrastructure
    this.com = new COM({
      metadata: {},
    });

    this.compiler = new FiberCompiler(this.com, undefined, {
      defaultRenderer: new MarkdownRenderer(),
    });

    // Apply pending hydration data if available
    if (this._pendingHydrationData) {
      this.compiler.setHydrationData(this._pendingHydrationData);
      this._pendingHydrationData = null; // Clear after applying
    }

    // Create scheduler and wire it to the compiler
    // This enables the reactive model: state changes between ticks trigger reconciliation
    this.scheduler = new ReconciliationScheduler(this.compiler, {
      onReconcile: (event) => {
        this.emit("reconcile", event);
      },
    });

    // Wire compiler state changes to scheduler
    this.compiler.setReconcileCallback((reason) => {
      this.scheduler!.schedule(reason);
    });

    // Wire COM recompile requests to scheduler
    // This unifies COM state signals with the reactive model
    this.com.setRecompileCallback((reason) => {
      this.scheduler!.schedule(reason ?? "COM recompile request");
    });

    this.structureRenderer = new StructureRenderer(this.com);
    this.structureRenderer.setDefaultRenderer(new MarkdownRenderer());

    // Register tools from appOptions
    if (this.appOptions.tools) {
      for (const tool of this.appOptions.tools) {
        this.com.addTool(tool);
      }
    }

    // Notify compiler that compilation is starting
    await this.compiler.notifyStart();
  }

  /**
   * Compile a single tick.
   */
  private async compileTick(rootElement: JSX.Element): Promise<{
    formatted: COMInput;
    model?: ModelInstance;
    modelInput?: any;
    tools: (ToolClass | ExecutableTool)[];
    shouldStop: boolean;
    stopReason?: string;
  }> {
    if (!this.com || !this.compiler || !this.structureRenderer) {
      throw new Error("Compilation infrastructure not initialized");
    }

    // Clear COM for this tick
    this.com.clear();

    // Re-register tools
    if (this.appOptions.tools) {
      for (const tool of this.appOptions.tools) {
        this.com.addTool(tool);
      }
    }

    // Prepare tick state
    const tickState: TickState = {
      tick: this._tick,
      previous: this._previousOutput ?? undefined,
      current: this._currentOutput as any,
      queuedMessages: this.com.getQueuedMessages(),
      stop: (reason: string) => {
        (tickState as any).stopReason = reason;
      },
    };

    // Notify compiler of tick start
    await this.compiler.notifyTickStart(tickState);

    // Create tick control for useTick() hook
    const tickControl = {
      requestTick: () => {
        // For now, requesting a tick schedules the next iteration
        // This will be used by the reactive model for external triggers
        this.emit("tick:request");
      },
      cancelTick: () => {
        this.emit("tick:cancel");
      },
      status: this._status as "idle" | "running" | "pending",
      tickCount: this._tick,
    };

    // Create channel accessor for useChannel() hook
    const getChannel = (name: string) => this.channel(name);

    // Enter tick mode - scheduler will defer reconciliations until exitTick
    this.scheduler?.enterTick();

    let compiled;
    const wasHydrating = this.compiler.isHydratingNow();
    try {
      // Compile until stable
      const result = await this.compiler.compileUntilStable(rootElement, tickState, {
        maxIterations: 50,
        tickControl,
        getChannel,
      });
      compiled = result.compiled;

      // Complete hydration after first successful compile
      if (wasHydrating) {
        this.compiler.completeHydration();
      }
    } finally {
      // Exit tick mode - any pending reconciliations will now flush
      this.scheduler?.exitTick();
    }

    // Apply compiled structure
    this.structureRenderer.apply(compiled);

    // Format input
    const formatted = await this.structureRenderer.formatInput(this.com.toInput());

    // Get model from COM if not in options
    const model = this.com.getModel?.() as ModelInstance | undefined;
    let modelInput: any;
    if (model?.fromEngineState) {
      modelInput = await model.fromEngineState(formatted);
    }

    // Get tools
    const tools = this.com.getTools?.() ?? [];

    // Check for stop
    const stopReason = (tickState as any).stopReason;

    return {
      formatted,
      model,
      modelInput,
      tools: tools as (ToolClass | ExecutableTool)[],
      shouldStop: !!stopReason,
      stopReason,
    };
  }

  /**
   * Execute tools and emit results.
   */
  private async executeTools(
    executor: ToolExecutor,
    toolCalls: ToolCall[],
    configTools: (ToolClass | ExecutableTool)[],
    outputs: Record<string, unknown>,
    currentTick: number,
    timestamp: () => string,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    const executableTools = configTools.filter((t): t is ExecutableTool => "run" in t);

    for (const call of toolCalls) {
      const startedAt = timestamp();
      // Check if OUTPUT tool
      const tool = executableTools.find((t) => t.metadata?.name === call.name);
      const isOutputTool = tool && tool.metadata?.type === "output";

      if (isOutputTool) {
        outputs[call.name] = call.input;
        const completedAt = timestamp();
        this.emitEvent({
          type: "tool_result",
          callId: call.id,
          name: call.name,
          result: call.input,
          isError: false,
          executedBy: "engine",
          startedAt,
          completedAt,
        });
        continue;
      }

      // Execute tool
      try {
        const result = await executor.processToolWithConfirmation(
          call,
          this.com!,
          executableTools,
        );
        results.push(result.result);
        const completedAt = timestamp();
        this.emitEvent({
          type: "tool_result",
          callId: result.result.toolUseId,
          name: result.result.name,
          result: result.result,
          isError: !result.result.success,
          executedBy: "engine",
          startedAt,
          completedAt,
        });
      } catch (error) {
        const errorResult: ToolResult = {
          id: randomUUID(),
          toolUseId: call.id,
          name: call.name,
          success: false,
          content: [
            {
              type: "text" as const,
              text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
        results.push(errorResult);
        const completedAt = timestamp();
        this.emitEvent({
          type: "tool_result",
          callId: call.id,
          name: call.name,
          result: errorResult,
          isError: true,
          executedBy: "engine",
          startedAt,
          completedAt,
        });
      }
    }

    return results;
  }

  /**
   * Ingest model response and tool results.
   */
  private async ingestTickResult(
    response: any,
    toolResults: ToolResult[],
  ): Promise<{ shouldContinue: boolean; stopReason?: string }> {
    if (!this.com || !this.compiler) {
      throw new Error("Compilation infrastructure not initialized");
    }

    // Convert queued user messages to timeline entries BEFORE clearing
    // This preserves the user message in the conversation history
    const queuedMessages = this.com.getQueuedMessages();
    const userEntries: COMTimelineEntry[] = queuedMessages
      .filter((m) => m.type === "user" && m.content)
      .map((m) => ({
        kind: "message" as const,
        message: m.content as Message,
        tags: ["user_input"] as TimelineTag[],
      }));

    // Build tool result entries
    const toolResultEntries: COMTimelineEntry[] =
      toolResults.length > 0
        ? [
            {
              kind: "message" as const,
              message: {
                role: "tool" as const,
                content: toolResults.map((r) => ({
                  id: r.id,
                  type: "tool_result" as const,
                  toolUseId: r.toolUseId,
                  name: r.name,
                  content: r.content || [],
                  isError: !r.success,
                })),
              },
              tags: ["tool_output"],
            },
          ]
        : [];

    // Build current output - user messages first, then assistant response, then tool results
    const current: COMOutput = {
      timeline: [...userEntries, ...(response.newTimelineEntries || []), ...toolResultEntries],
      toolCalls: response.toolCalls,
      toolResults,
    };

    // Add entries to COM - user entries first, then assistant response
    for (const entry of userEntries) {
      this.com.addTimelineEntry(entry);
    }

    if (response.newTimelineEntries) {
      for (const entry of response.newTimelineEntries) {
        this.com.addTimelineEntry(entry);
      }
    }

    if (toolResults.length > 0) {
      this.com.addTimelineEntry({
        kind: "message",
        message: {
          role: "tool" as const,
          content: toolResults.map((r) => ({
            type: "tool_result" as const,
            toolUseId: r.toolUseId,
            name: r.name,
            content: r.content || [],
            isError: !r.success,
          })),
        },
        tags: ["tool_output"],
      });
    }

    this._currentOutput = current;

    // Resolve tick control
    const shouldStop = response.shouldStop || false;
    const stopReason = response.stopReason?.reason;

    return {
      shouldContinue: !shouldStop && (response.toolCalls?.length > 0 || false),
      stopReason,
    };
  }

  /**
   * Complete execution and return final state.
   */
  private async complete(): Promise<COMInput> {
    if (!this.com || !this.structureRenderer || !this.compiler) {
      throw new Error("Compilation infrastructure not initialized");
    }

    const comOutput = this.com.toInput();
    const finalOutput = await this.structureRenderer.formatInput(comOutput);

    // Notify compiler of completion
    try {
      await this.compiler.notifyComplete(finalOutput);
    } catch {
      // Ignore completion errors
    }

    return finalOutput;
  }
}
