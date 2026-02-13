/**
 * Session - The Execution Unit
 *
 * A session holds component state (fiber tree) across ticks.
 * Each tick: compile JSX -> call model -> execute tools -> decide continue?
 *
 * Design principles:
 * - Single class, no intermediate layers
 * - Minimal state - just what's needed for execution
 * - render() is a Procedure returning SessionExecutionHandle (AsyncIterable)
 * - Clean, elegant code over feature completeness
 *
 * @module agentick/app/session
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  Context,
  createProcedure,
  Channel,
  EventBuffer,
  ExecutionHandleBrand,
  Logger,
  type KernelContext,
  type Procedure,
  type ChannelServiceInterface,
  type ChannelEvent,
} from "@agentick/kernel";
import {
  FiberCompiler,
  StructureRenderer,
  ReconciliationScheduler,
  type SerializedFiberNode,
  type FiberSummary,
} from "../compiler";
import { COM, type COMStopRequest, type COMContinueRequest } from "../com/object-model";
import { MarkdownRenderer } from "../renderers/index";
import { ToolExecutor } from "../engine/tool-executor";
import { AbortError } from "../utils/abort-utils";
import { jsx } from "../jsx/jsx-runtime";
import type { JSX } from "../jsx/jsx-runtime";
import type { COMInput, COMOutput, COMTimelineEntry, TimelineTag } from "../com/types";
import type { EngineModel } from "../model/model";
import type {
  ToolResult,
  ToolCall,
  Message,
  UsageStats,
  ContentBlock,
  ToolConfirmationResponse,
} from "@agentick/shared";
import {
  devToolsEmitter,
  forwardToDevTools,
  type DTFiberSnapshotEvent,
  type DTFiberSummary,
  type DTTokenSummary,
  type DTCompiledPreview,
  FrameworkChannels,
  type SessionContextPayload,
  getEffectiveModelInfo,
  getContextUtilization,
} from "@agentick/shared";
import { computeTokenSummary } from "../utils/token-estimate";
import type { CompiledStructure } from "../compiler/types";
import type { ExecutableTool, ToolClass } from "../tool/tool";
import type { TickState } from "../component/component";
import type { TickResult } from "../hooks/types";
import type { ExecutionMessage } from "../engine/execution-types";
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
  SendInput,
  SpawnOptions,
  HookType,
  ResolveConfig,
  ResolveContext,
} from "./types";
import React from "react";

// ════════════════════════════════════════════════════════════════════════════
const log = Logger.for("Session");

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
    sessionId: ctx?.sessionId,
    rootComponent: (ctx as any)?.rootComponent,
    devToolsEnabled: (ctx as any)?.devToolsEnabled,
  };
}

/**
 * Ensure a message has an ID. If no ID exists, generate one.
 * This is critical for deduplication in reactive clients.
 */
function ensureMessageId(message: Message): Message {
  if (message.id) return message;
  return { ...message, id: randomUUID() };
}

function tryDisplaySummary(
  tool: ExecutableTool | undefined,
  input: Record<string, unknown>,
): string | undefined {
  if (!tool?.metadata?.displaySummary) return undefined;
  try {
    return tool.metadata.displaySummary(input);
  } catch (err) {
    log.warn({ error: err, tool: tool.metadata.name }, "displaySummary threw");
    return undefined;
  }
}

/**
 * Session implementation.
 *
 * A session manages the execution lifecycle: compile JSX, call model, execute tools.
 * Component state (hooks, signals) persists across ticks within a session.
 */
export class SessionImpl<P = Record<string, unknown>> extends EventEmitter implements Session<P> {
  readonly id: string;
  private readonly log = Logger.for("SessionImpl");

  // Core execution state
  private _status: SessionStatus = "idle";
  private _tick = 1;
  private _isAborted = false;
  private _currentExecutionId: string | null = null;

  // Compilation infrastructure (no intermediate layer)
  private compiler: FiberCompiler | null = null;
  private ctx: COM | null = null;
  private structureRenderer: StructureRenderer | null = null;
  private scheduler: ReconciliationScheduler | null = null;

  // Last completed tick's compiled output. Used only by inspect().lastOutput.
  private _lastCompleteOutput: COMInput | null = null;
  private _currentOutput: COMOutput | null = null;

  // Session-owned timeline (source of truth, append-only)
  private _timeline: COMTimelineEntry[] = [];
  private _maxTimelineEntries: number | undefined;

  // Estimated context tokens from last compilation (pre-model-call)
  private _estimatedContextTokens?: number;

  // Track last published timeline length for delta publishing
  private _lastPublishedTimelineLength = 0;

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

  // Auto-persist callback (set by App when store is configured)
  private _persistCallback: ((snapshot: SessionSnapshot) => Promise<void>) | null = null;

  // Snapshot for resolve (set when restoring from store)
  private _snapshotForResolve: SessionSnapshot | null = null;

  // Execution runner initialization tracking
  private _runnerInitialized = false;

  // Spawn hierarchy
  private _parent: Session | null = null;
  private _children: Session[] = [];
  private _spawnDepth = 0;
  private static readonly MAX_SPAWN_DEPTH = 10;

  constructor(
    Component: ComponentFunction<P>,
    appOptions: AppOptions,
    sessionOptions: SessionOptions = {},
  ) {
    super();
    this.id = sessionOptions.sessionId ?? randomUUID();
    this.Component = Component;
    this.appOptions = appOptions;
    this.sessionOptions = sessionOptions;

    // Capture ALS context at session creation time
    // Include Agentick middleware registry if available (for procedure middleware support)
    const currentContext = Context.tryGet();
    const agentickInstance = (appOptions as { _agentickInstance?: KernelContext["middleware"] })
      ._agentickInstance;
    if (agentickInstance && currentContext) {
      this._capturedContext = { ...currentContext, middleware: agentickInstance };
    } else if (agentickInstance && !currentContext) {
      this._capturedContext = Context.create({ middleware: agentickInstance });
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

    // Read maxTimelineEntries from appOptions
    this._maxTimelineEntries = appOptions.maxTimelineEntries;

    // Note: snapshot/initialTimeline hydration now handled via _snapshotForResolve
    // set by App.createSessionFromSnapshot() — applied in ensureCompilationInfrastructure()

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

  /** Whether the session is in a terminal state (closed). */
  private get isTerminal(): boolean {
    return this._status === "closed";
  }

  /** Error message for operations attempted on a terminal session. */
  private get terminalError(): string {
    return "Session is closed";
  }

  get currentTick(): number {
    return this._tick;
  }

  get isAborted(): boolean {
    return this._isAborted;
  }

  get parent(): Session | null {
    return this._parent;
  }

  get children(): readonly Session[] {
    return this._children;
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
    return this.scheduler?.getState() ?? null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Queue Procedure
  // ════════════════════════════════════════════════════════════════════════

  queue!: Procedure<(message: Message) => Promise<void>, true>;
  send!: Procedure<(input: SendInput<P>) => SessionExecutionHandle, true>;
  render!: Procedure<(props: P, options?: ExecutionOptions) => SessionExecutionHandle, true>;
  spawn!: Procedure<
    (
      component: ComponentFunction | JSX.Element,
      input?: SendInput,
      options?: SpawnOptions,
    ) => SessionExecutionHandle,
    true
  >;

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
        if (this.isTerminal) {
          throw new Error(this.terminalError);
        }
        const messageWithId = ensureMessageId(message);
        this._queuedMessages.push(messageWithId);

        // Publish to messages channel for reactive updates
        this.channel("messages").publish({
          type: "message_queued",
          channel: "messages",
          payload: messageWithId,
        });

        // Notify components via useOnMessage hooks if compiler exists
        if (this.compiler) {
          const executionMessage: ExecutionMessage = {
            id: randomUUID(),
            type: "message",
            content: message,
            timestamp: Date.now(),
          };
          const tickState: TickState = {
            tick: this._tick,
            timeline: this._timeline,
            stop: () => {},
            queuedMessages: [],
          };
          await this.compiler.notifyOnMessage(executionMessage, tickState);
        }
      },
    );

    // Send procedure - queues messages + delegates to render
    this.send = createProcedure(
      {
        name: "session:send",
        metadata: { operation: "send" },
        handleFactory: false,
        executionBoundary: false,
      },
      async (input: SendInput<P>): Promise<SessionExecutionHandle> => {
        if (this.isTerminal) {
          throw new Error(this.terminalError);
        }

        const { messages = [], props, metadata, maxTicks, signal, tools: executionTools } = input;

        // Apply metadata to messages
        const allMessages = messages.map((m) => (metadata ? { ...m, metadata } : m));

        // Update props if provided
        if (props) {
          this._lastProps = props;
        }

        // Queue messages synchronously and notify components
        for (const msg of allMessages) {
          const msgWithId = ensureMessageId(msg);
          this._queuedMessages.push(msgWithId);
          this.channel("messages").publish({
            type: "message_queued",
            channel: "messages",
            payload: msgWithId,
          });

          // Notify components via useOnMessage hooks if compiler exists
          if (this.compiler) {
            const executionMessage: ExecutionMessage = {
              id: randomUUID(),
              type: "message",
              content: msgWithId,
              timestamp: Date.now(),
            };
            const tickState: TickState = {
              tick: this._tick,
              timeline: this._timeline,
              stop: () => {},
              queuedMessages: [],
            };
            // Fire and forget - don't await to keep send() fast
            this.compiler.notifyOnMessage(executionMessage, tickState).catch(() => {});
          }
        }

        // Build execution options from input
        const executionOptions: ExecutionOptions = {};
        if (maxTicks !== undefined) executionOptions.maxTicks = maxTicks;
        if (signal) executionOptions.signal = signal;
        if (executionTools?.length) executionOptions.executionTools = executionTools;

        // If already running, return the existing handle (concurrent send idempotency)
        if (this._status === "running" && this._currentHandle) {
          this.addExecutionSignal(signal);
          return this._currentHandle;
        }

        // If idle and we have something to do, start tick
        if ((allMessages.length > 0 || props) && this._status === "idle") {
          // Use last known props if available, otherwise default to empty props.
          const tickProps = (this._lastProps ?? ({} as P)) as P;
          return await this.render(tickProps, executionOptions);
        }

        // Nothing to do - create a handle that resolves immediately with empty result
        return this.createEmptyHandle();
      },
    );

    // Render procedure - creates and runs a tick execution
    this.render = createProcedure(
      {
        name: "session:render",
        metadata: { operation: "render" },
        handleFactory: false,
        executionBoundary: false,
      },
      (props: P, options?: ExecutionOptions): SessionExecutionHandle => {
        if (this.isTerminal) {
          throw new Error(this.terminalError);
        }

        // Props is explicitly provided (even if empty object) - always run tick
        // Only skip if props is undefined/null AND no queued messages
        const propsProvided = props !== undefined && props !== null;
        if (!propsProvided && this._queuedMessages.length === 0) {
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
      },
    );

    // Spawn procedure - creates ephemeral child session
    this.spawn = createProcedure(
      {
        name: "session:spawn",
        metadata: { operation: "spawn" },
        handleFactory: false,
        executionBoundary: false,
      },
      async (
        component: ComponentFunction | JSX.Element,
        input?: SendInput,
        spawnOptions?: SpawnOptions,
      ): Promise<SessionExecutionHandle> => {
        if (this.isTerminal) {
          throw new Error(this.terminalError);
        }
        if (this._spawnDepth >= SessionImpl.MAX_SPAWN_DEPTH) {
          throw new Error(`Maximum spawn depth (${SessionImpl.MAX_SPAWN_DEPTH}) exceeded`);
        }

        // 1. Resolve to ComponentFunction
        const resolvedInput = input ?? {};
        const { Component, mergedProps } = this.resolveSpawnTarget(component, resolvedInput);

        // 2. Create child SessionImpl (ephemeral — NOT registered in App's registry)
        //    Whitelist structural fields only — lifecycle callbacks, session management,
        //    signal, and devTools are intentionally excluded. New AppOptions fields
        //    must be explicitly added here if children should inherit them.
        //
        //    NOTE: `runner` IS inherited by default. A REPL runner, sandbox,
        //    or human-in-the-loop gateway should apply to sub-agents — the execution
        //    model is structural, not observational (unlike lifecycle callbacks).
        //    Use SpawnOptions to override for specific children.
        const childAppOptions: AppOptions = {
          model: spawnOptions?.model ?? this.appOptions.model,
          tools: this.appOptions.tools,
          mcpServers: this.appOptions.mcpServers,
          maxTicks: spawnOptions?.maxTicks ?? this.appOptions.maxTicks,
          inheritDefaults: this.appOptions.inheritDefaults,
          runner: spawnOptions?.runner ?? this.appOptions.runner,
        };

        const childOptions: SessionOptions = {
          signal: this.executionAbortController?.signal,
          devTools: this.sessionOptions.devTools ?? this.appOptions.devTools,
        };
        const child = new SessionImpl(Component, childAppOptions, childOptions);
        (child as any)._parent = this;
        (child as any)._spawnDepth = this._spawnDepth + 1;
        this._children.push(child as unknown as Session);

        // 3. Delegate to child.send()
        const handle = await child.send({
          ...resolvedInput,
          props: mergedProps,
        });

        // 4. Cleanup on completion
        handle.result
          .finally(async () => {
            this._children = this._children.filter((c) => c !== (child as unknown as Session));
            await child.close();
          })
          .catch(() => {});

        return handle;
      },
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // SessionExecutionHandle Creation
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Create a SessionExecutionHandle with explicit delegation.
   * The handle is AsyncIterable (not PromiseLike — use `.result` for the final value).
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
    let _iterationComplete = false;

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
      _iterationComplete = true;
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
      [ExecutionHandleBrand]: true as const,

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
      submitToolResult(
        toolUseId: string,
        response: {
          approved: boolean;
          reason?: string;
          modifiedArguments?: Record<string, unknown>;
        },
      ) {
        session.channel("tool_confirmation").publish({
          type: "response",
          channel: "tool_confirmation",
          id: toolUseId,
          payload: response,
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
      [ExecutionHandleBrand]: true as const,
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return emptyEventBuffer[Symbol.asyncIterator]();
      },
      get status() {
        return "completed" as const;
      },
      get traceId() {
        return randomUUID();
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
      submitToolResult(
        _toolUseId: string,
        _response: {
          approved: boolean;
          reason?: string;
          modifiedArguments?: Record<string, unknown>;
        },
      ) {},
    };

    return handle;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Spawn Target Resolution
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Resolve spawn target to a ComponentFunction and merged props.
   */
  private resolveSpawnTarget(
    component: ComponentFunction | JSX.Element,
    input: SendInput,
  ): { Component: ComponentFunction; mergedProps: Record<string, unknown> } {
    // JSX Element
    if (React.isValidElement(component)) {
      return {
        Component: component.type as ComponentFunction,
        mergedProps: {
          ...(component.props as Record<string, unknown>),
          ...(input.props ?? {}),
        },
      };
    }

    // Component function
    return {
      Component: component as ComponentFunction,
      mergedProps: input.props ?? {},
    };
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

  submitToolResult(
    toolUseId: string,
    response: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
  ): void {
    this.channel("tool_confirmation").publish({
      type: "response",
      channel: "tool_confirmation",
      id: toolUseId,
      payload: response,
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Interrupt & Abort
  // ════════════════════════════════════════════════════════════════════════

  interrupt(message?: Message, reason?: string): void {
    if (this.isTerminal) {
      throw new Error(this.terminalError);
    }

    if (message) {
      this._queuedMessages.push(message);
    }

    if (this._status === "running") {
      this._isAborted = true;
      this.executionAbortController?.abort(reason ?? "interrupt");

      // Propagate interrupt to child sessions (spread-copy: interrupt cleanup may mutate array)
      for (const child of [...this._children]) {
        child.interrupt(undefined, reason ?? "Parent interrupted");
      }
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

    let enrichedEvent: any =
      executionId && !("executionId" in event) ? { ...event, executionId } : event;

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
      sessionId: this.id,
      tick: this._tick,
      timeline: [...this._timeline],
      comState: this.compiler
        ? this.compiler.getSerializableComState(this.ctx?.getStateAll() ?? {})
        : {},
      dataCache: this.compiler?.getSerializableDataCache() ?? {},
      usage: { ...this._totalUsage },
      timestamp: Date.now(),
    };
  }

  /**
   * Set the auto-persist callback.
   * Called by the App when a store is configured.
   * @internal
   */
  setPersistCallback(callback: (snapshot: SessionSnapshot) => Promise<void>): void {
    this._persistCallback = callback;
  }

  /**
   * Set a snapshot to be applied/resolved when compilation infrastructure is created.
   * @internal
   */
  setSnapshotForResolve(snapshot: SessionSnapshot): void {
    this._snapshotForResolve = snapshot;
  }

  inspect(): SessionInspection {
    // Get fiber summary for component/hook stats
    const fiberSummary = this.getFiberSummary();

    // Get component names from fiber tree
    const componentNames = this.collectComponentNames();

    // Get last tick's tool data from snapshots if available
    const lastSnapshot =
      this._snapshots.length > 0 ? this._snapshots[this._snapshots.length - 1] : null;

    return {
      id: this.id,
      status: this._status,
      currentTick: this._tick,
      queuedMessages: [...this._queuedMessages],
      currentPhase: this._status === "running" ? "model" : undefined, // Approximate
      isAborted: this._isAborted,
      lastOutput: this._lastCompleteOutput,
      lastModelOutput: this._lastModelOutput,
      lastToolCalls: lastSnapshot?.tools.calls ?? [],
      lastToolResults:
        lastSnapshot?.tools.results.map((r) => ({
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
        // React manages hooks internally, so detailed type info isn't available
        byType: {},
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
    const collectNames = (node: SerializedFiberNode) => {
      // Skip host primitives (Section, Message, etc.) and fragments
      if (!node.type.startsWith("agentick.") && node.type !== "Fragment") {
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
      this._recording.summary.finalStatus =
        this._status === "idle" ? "completed" : (this._status as any);
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
          content:
            typeof section.content === "string" ? section.content : JSON.stringify(section.content),
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
        summary: {
          componentCount: fiberSummary.componentCount,
          hookCount: fiberSummary.hookCount,
          hooksByType: fiberSummary.hooksByType as Partial<Record<HookType, number>>,
        },
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

  private serializeFiberTree(): SerializedFiberNode | null {
    if (!this.compiler) return null;
    return this.compiler.serializeFiberTree();
  }

  private getFiberSummary(): FiberSummary {
    if (!this.compiler) {
      return { componentCount: 0, hookCount: 0, effectCount: 0, depth: 0, hooksByType: {} };
    }
    return this.compiler.getFiberSummary();
  }

  /**
   * Broadcast context utilization info via the session:context channel.
   * Enables real-time context tracking in UI via useContextInfo() hook.
   */
  private broadcastContextInfo(
    executionId: string,
    modelId: string,
    modelMetadata:
      | { contextWindow?: number; maxOutputTokens?: number; provider?: string }
      | undefined,
    tickUsage: UsageStats | undefined,
    tick: number,
    cumulativeUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      ticks?: number;
    },
    timestampStr: string,
  ): void {
    // Get context info (effective = adapter metadata merged with catalog)
    const modelInfo = getEffectiveModelInfo(
      {
        model: modelId,
        provider: modelMetadata?.provider,
        contextWindow: modelMetadata?.contextWindow,
        maxOutputTokens: modelMetadata?.maxOutputTokens,
      },
      modelId,
    );

    const inputTokens = tickUsage?.inputTokens ?? 0;
    const outputTokens = tickUsage?.outputTokens ?? 0;
    const totalTokens = tickUsage?.totalTokens ?? inputTokens + outputTokens;

    // Calculate utilization if we have context window info
    const utilization = modelInfo?.contextWindow
      ? (getContextUtilization(modelId, inputTokens) ?? undefined)
      : undefined;

    const payload: SessionContextPayload = {
      modelId,
      modelName: modelInfo?.name,
      provider: modelInfo?.provider || modelMetadata?.provider,
      contextWindow: modelInfo?.contextWindow,
      inputTokens,
      outputTokens,
      totalTokens,
      utilization,
      maxOutputTokens: modelInfo?.maxOutputTokens,
      supportsVision: modelInfo?.supportsVision,
      supportsToolUse: modelInfo?.supportsToolUse,
      isReasoningModel: modelInfo?.isReasoningModel,
      tick,
      cumulativeUsage: {
        inputTokens: cumulativeUsage.inputTokens,
        outputTokens: cumulativeUsage.outputTokens,
        totalTokens: cumulativeUsage.totalTokens,
        ticks: cumulativeUsage.ticks ?? tick,
      },
      timestamp: timestampStr,
    };

    // Publish to channel (if channel service is available)
    const ctx = Context.tryGet();
    if (ctx?.channels) {
      try {
        ctx.channels.publish(ctx, FrameworkChannels.CONTEXT, {
          type: "context_update",
          payload,
        });
      } catch {
        // Silently ignore if channel publish fails
      }
    }

    // Also emit as DevTools event for DevTools UI
    if (devToolsEmitter.hasSubscribers()) {
      devToolsEmitter.emitEvent({
        type: "context_update",
        executionId,
        sessionId: this.id,
        sequence: ++this._sequence,
        timestamp: Date.now(),
        modelId: payload.modelId,
        modelName: payload.modelName,
        provider: payload.provider,
        contextWindow: payload.contextWindow,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        totalTokens: payload.totalTokens,
        utilization: payload.utilization,
        maxOutputTokens: payload.maxOutputTokens,
        supportsVision: payload.supportsVision,
        supportsToolUse: payload.supportsToolUse,
        isReasoningModel: payload.isReasoningModel,
        tick: payload.tick,
        cumulativeUsage: payload.cumulativeUsage,
      });
    }

    // Update compiler's contextInfoStore so JSX components can access via useContextInfo
    if (this.compiler) {
      this.compiler.contextInfoStore.update({
        modelId: payload.modelId,
        modelName: payload.modelName,
        provider: payload.provider,
        contextWindow: payload.contextWindow,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        totalTokens: payload.totalTokens,
        utilization: payload.utilization,
        maxOutputTokens: payload.maxOutputTokens,
        supportsVision: payload.supportsVision,
        supportsToolUse: payload.supportsToolUse,
        isReasoningModel: payload.isReasoningModel,
        tick: payload.tick,
        cumulativeUsage: payload.cumulativeUsage,
        estimatedContextTokens: this._estimatedContextTokens,
      });
    }

    // Emit as stream event for client-side React consumption
    this.emitEvent({
      type: "context_update",
      modelId: payload.modelId,
      modelName: payload.modelName,
      provider: payload.provider,
      contextWindow: payload.contextWindow,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      totalTokens: payload.totalTokens,
      utilization: payload.utilization,
      maxOutputTokens: payload.maxOutputTokens,
      supportsVision: payload.supportsVision,
      supportsToolUse: payload.supportsToolUse,
      isReasoningModel: payload.isReasoningModel,
      cumulativeUsage: payload.cumulativeUsage,
      tick,
      timestamp: timestampStr,
    });
  }

  /**
   * Emit a fiber_snapshot event to DevTools after each tick.
   * This enables the Fiber Tree panel in DevTools to show component hierarchy and hook values.
   *
   * @param tick - The tick number
   * @param executionId - The execution ID
   * @param compiled - Optional compiled structure for token estimation
   */
  private emitFiberSnapshot(tick: number, executionId: string, compiled?: CompiledStructure): void {
    // Only emit if DevTools has subscribers (avoid serialization overhead)
    if (!devToolsEmitter.hasSubscribers()) return;

    try {
      const tree = this.serializeFiberTree();
      const summary = this.getFiberSummary();

      // Compute token summary if compiled structure is available
      let tokenSummary: DTTokenSummary | undefined;
      let compiledPreview: DTCompiledPreview | undefined;

      if (compiled) {
        try {
          const tokens = computeTokenSummary(compiled);
          tokenSummary = {
            system: tokens.system,
            messages: tokens.messages,
            tools: tokens.tools,
            ephemeral: tokens.ephemeral,
            total: tokens.total,
            byComponent: Object.fromEntries(tokens.byComponent),
          };

          // Get system prompt preview (first 200 chars)
          let systemPrompt: string | undefined;
          if (compiled.systemEntries.length > 0) {
            const firstSystem = compiled.systemEntries[0];
            if (firstSystem.content.length > 0) {
              const firstBlock = firstSystem.content[0];
              if ("text" in firstBlock && typeof firstBlock.text === "string") {
                systemPrompt = firstBlock.text.slice(0, 200);
              }
            }
          }

          compiledPreview = {
            systemPrompt,
            messageCount: compiled.timelineEntries.length,
            toolCount: compiled.tools.length,
            ephemeralCount: compiled.ephemeral.length,
          };
        } catch {
          // Ignore token estimation errors
        }
      }

      const event: DTFiberSnapshotEvent = {
        type: "fiber_snapshot",
        sessionId: this.id,
        executionId,
        sequence: ++this._sequence, // Use session's sequence counter for DevTools events
        tick,
        timestamp: Date.now(),
        tree: tree as DTFiberSnapshotEvent["tree"],
        summary: summary as DTFiberSummary,
        tokenSummary,
        compiledPreview,
      };

      devToolsEmitter.emitEvent(event);
    } catch {
      // Silently ignore serialization errors - DevTools is optional
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Close & Teardown
  // ════════════════════════════════════════════════════════════════════════

  async close(): Promise<void> {
    if (this.isTerminal) return;

    this._status = "closed";

    // Notify execution runner of destroy
    if (this._runnerInitialized && this.appOptions.runner?.onDestroy) {
      try {
        await this.appOptions.runner.onDestroy(this);
      } catch (err) {
        this.log.warn({ error: err }, "Runner onDestroy failed");
      }
    }

    // Close all child sessions
    await Promise.all(this._children.map((child) => child.close()));
    this._children = [];

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
      try {
        await this.compiler.unmount();
      } catch {
        // Unmount errors during close are non-fatal
      }
      this.compiler = null;
    }

    this.ctx = null;
    this.structureRenderer = null;

    this.emit("close", this.id);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Internal: Execution
  // ════════════════════════════════════════════════════════════════════════

  private async runWithContext<T>(fn: () => Promise<T>): Promise<T> {
    const current = Context.tryGet();
    const baseContext = this._capturedContext || current;

    // Create a channel service that wraps session channels
    // This allows tools to publish events via Context.get().channels
    const channelService: ChannelServiceInterface = {
      getChannel: (_ctx: KernelContext, channelName: string) => this.channel(channelName),
      publish: (_ctx: KernelContext, channelName: string, event: Omit<ChannelEvent, "channel">) => {
        this.channel(channelName).publish({ ...event, channel: channelName } as ChannelEvent);
      },
      subscribe: (
        _ctx: KernelContext,
        channelName: string,
        handler: (event: ChannelEvent) => void,
      ) => {
        return this.channel(channelName).subscribe(handler);
      },
      waitForResponse: (
        _ctx: KernelContext,
        channelName: string,
        requestId: string,
        timeoutMs?: number,
      ) => {
        return this.channel(channelName).waitForResponse(requestId, timeoutMs);
      },
    };

    // Session-specific context fields for DevTools enrichment
    const sessionContext = {
      sessionId: this.id,
      rootComponent: this.Component.name || "Agent",
      devToolsEnabled: this.sessionOptions.devTools ?? false,
      channels: channelService,
    };

    if (!baseContext) {
      // No base context - create minimal context with session fields
      return Context.run(Context.create(sessionContext as any), fn);
    }

    // Merge base, current, and session context
    const merged = { ...baseContext, ...(current ?? {}), ...sessionContext };
    return Context.run(merged as any, fn);
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
    if (this.isTerminal) {
      throw new Error(this.terminalError);
    }

    const signal = this.executionAbortController?.signal ?? this.sessionAbortController.signal;
    if (signal.aborted) {
      throw new AbortError("Session aborted", signal.reason);
    }

    this._status = "running";
    this._executionComplete = false;
    this._lastProps = props;

    // Clear _currentOutput from previous execution to prevent stale data
    // from being included in useConversationHistory() via state.current
    this._currentOutput = null;

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
    if (this._queuedMessages.length > 0 && this.ctx) {
      this.log.debug({ count: this._queuedMessages.length }, "Transferring queued messages to COM");
      for (const msg of this._queuedMessages) {
        this.log.debug({ role: msg.role }, "Queuing message to COM");
        this.ctx.queueMessage({
          id: randomUUID(),
          type: "message",
          content: msg,
        } as any);
      }
      this._queuedMessages = [];
      this.log.debug(
        { comQueuedCount: this.ctx.getQueuedMessages().length },
        "COM queued messages after transfer",
      );
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
    let responseText = "";
    const toolExecutor = new ToolExecutor();

    this.emitEvent({
      type: "execution_start",
      executionId,
      timestamp: timestamp(),
    });

    const executionStartTimelineIndex = this._timeline.length;

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
        const compiled = await this.compileTick(rootElement, options?.executionTools ?? []);

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
          // Rendered output (existing)
          system: systemText || undefined,
          messages: compiled.formatted?.timeline,
          tools: compiled.tools?.map((t: any) => ({
            name: t.metadata?.name ?? t.name,
            description: t.metadata?.description ?? t.description,
          })),
          // Raw compiled structure (before rendering)
          rawCompiled: compiled.rawCompiled
            ? {
                sections: Object.fromEntries(compiled.rawCompiled.sections ?? new Map()),
                timelineEntries: compiled.rawCompiled.timelineEntries,
                systemEntries: compiled.rawCompiled.systemEntries,
                tools: compiled.rawCompiled.tools,
                ephemeral: compiled.rawCompiled.ephemeral,
              }
            : undefined,
          // Formatted COMInput (after rendering)
          formattedInput: compiled.formatted,
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
          this.emitFiberSnapshot(currentTick, executionId, compiled.rawCompiled);
          // Clear queued messages - they were made available during compilation
          this.ctx?.clearQueuedMessages();
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

        // Start with compiled COMInput — the rich semantic structure
        let formatted = compiled.formatted;

        // Apply execution runner transformation (operates on COMInput, before model flattening)
        if (this.appOptions.runner?.transformCompiled) {
          formatted = await this.appOptions.runner.transformCompiled(
            formatted,
            (compiled.tools ?? []) as ExecutableTool[],
          );
        }

        // Convert COMInput → ModelInput via adapter's fromEngineState
        let modelInput: any = formatted;
        if (model?.fromEngineState) {
          modelInput = await model.fromEngineState(formatted);
        }

        const modelStartTime = Date.now();

        // Emit model request to DevTools
        // modelInput is the Agentick ModelInput format (after fromEngineState transformation)
        this.emitEvent({
          type: "model_request",
          tick: currentTick,
          timestamp: timestamp(),
          modelId: model?.metadata?.id ?? model?.metadata?.model,
          // ModelInput: Agentick's model input format
          input: modelInput,
          // Stage marker for pipeline visualization
          stage: "model_input",
        });

        // Emit provider request to DevTools (Stage 4: what the SDK actually receives)
        if (model.getProviderInput) {
          const providerInput = await model.getProviderInput(modelInput);
          this.emitEvent({
            type: "provider_request",
            tick: currentTick,
            timestamp: timestamp(),
            modelId: model?.metadata?.id ?? model?.metadata?.model,
            provider: model?.metadata?.provider,
            providerInput,
          });
        }

        // Stream model output if supported
        let modelOutput: any;
        if (model.stream) {
          const streamIterable = await model.stream(modelInput);
          for await (const event of streamIterable) {
            if (signal.aborted) {
              throw new AbortError("Execution aborted", signal.reason);
            }
            this.emitEvent(event as StreamEvent);

            if (event.type === "message" && "message" in event) {
              const messageEvent = event as any;
              modelOutput = {
                messages: [messageEvent.message],
                message: messageEvent.message,
                stopReason: messageEvent.stopReason,
                usage: messageEvent.usage,
                raw: messageEvent.raw, // Reconstructed provider response from adapter
              };
            }
          }

          if (!modelOutput) {
            throw new Error("Streaming completed but no model output was received");
          }
        } else {
          // Procedure returns ExecutionHandle by default - access .result for actual return value
          // Handle both real procedures (with .result) and mock functions (direct value)
          const generateResult = model.generate(modelInput);
          modelOutput =
            generateResult && "result" in generateResult
              ? await generateResult.result
              : await generateResult;
        }

        // Extract text from model output
        if (modelOutput?.message) {
          const textContent = modelOutput.message.content?.find((b: any) => b.type === "text");
          if (textContent && "text" in textContent) {
            responseText = textContent.text;
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

        // Emit model response to DevTools with full pipeline visibility
        this.emitEvent({
          type: "model_response",
          tick: currentTick,
          timestamp: timestamp(),
          // Provider output (raw from SDK - may be reconstructed for streaming)
          providerOutput: modelOutput?.raw,
          // ModelOutput (normalized Agentick format)
          modelOutput: {
            model: modelOutput?.model,
            message: modelOutput?.message,
            usage: modelOutput?.usage,
            stopReason: modelOutput?.stopReason,
            toolCalls: modelOutput?.toolCalls,
          },
          // Engine state (how it's ingested into timeline)
          engineState: {
            newTimelineEntries: response.newTimelineEntries,
            toolCalls: response.toolCalls,
            shouldStop: response.shouldStop,
            stopReason: response.stopReason,
          },
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
        if (response.toolCalls?.length && this.ctx) {
          toolStartTime = Date.now();
          for (const call of response.toolCalls) {
            const toolCallTimestamp = timestamp();
            const toolDef = compiled.tools?.find((t: any) => t.metadata?.name === call.name);
            const summary = tryDisplaySummary(toolDef, call.input);
            this.emitEvent({
              type: "tool_call",
              callId: call.id,
              blockIndex: 0,
              name: call.name,
              input: call.input,
              summary,
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

        // Phase 4: Ingest & Tick End Callbacks
        const ingestResult = await this.ingestTickResult(response, toolResults);

        // Build TickResult for useTickEnd/useContinuation callbacks
        // Extract text from model response
        let tickText: string | undefined;
        if (modelOutput?.message?.content) {
          const textContent = modelOutput.message.content.find(
            (b: ContentBlock) => b.type === "text",
          );
          if (textContent && "text" in textContent) {
            tickText = textContent.text;
          }
        }

        // Build TickResult with data and control methods.
        // shouldContinue is initialized from ingestResult so callbacks see the framework default.
        const tickResult: TickResult = {
          tick: currentTick,
          shouldContinue: ingestResult.shouldContinue,
          text: tickText,
          content: modelOutput?.message?.content ?? [],
          toolCalls: response.toolCalls ?? [],
          toolResults,
          stopReason: modelOutput?.stopReason,
          usage: modelOutput?.usage,
          timeline: ingestResult.timeline,
          stop: (reasonOrOptions?: string | COMStopRequest) => {
            if (typeof reasonOrOptions === "string") {
              this.ctx?.requestStop({ reason: reasonOrOptions });
            } else {
              this.ctx?.requestStop(reasonOrOptions ?? {});
            }
          },
          continue: (reasonOrOptions?: string | COMContinueRequest) => {
            if (typeof reasonOrOptions === "string") {
              this.ctx?.requestContinue({ reason: reasonOrOptions });
            } else {
              this.ctx?.requestContinue(reasonOrOptions ?? {});
            }
          },
        };

        // Run useTickEnd/useContinuation callbacks.
        // storeRunTickEndCallbacks chains shouldContinue through each callback
        // via _resolveCurrentShouldContinue, so each sees the accumulated decision.
        const tickEndState: TickState = {
          tick: currentTick,
          current: this._currentOutput as any,
          queuedMessages: [],
          timeline: this._timeline,
          stop: () => {}, // No-op at tick end - use tickResult.stop() instead
        };
        await this.compiler?.notifyTickEnd(tickEndState, tickResult);

        // Final decision comes from tickResult.shouldContinue (already resolved
        // incrementally through callbacks). Fall back to _resolveTickControl for
        // any remaining requests not consumed by chaining (shouldn't happen, but safe).
        const remainingDecision = this.ctx?._resolveTickControl(
          tickResult.shouldContinue ? "continue" : "completed",
          ingestResult.stopReason,
        ) ?? { status: tickResult.shouldContinue ? "continue" : "completed" };
        shouldContinue = remainingDecision.status === "continue";

        // Get actual model ID: prefer response model, then metadata.model, then metadata.id
        const actualModelId =
          modelOutput?.model || model?.metadata?.model || model?.metadata?.id || "unknown";

        this.emitEvent({
          type: "tick_end",
          tick: currentTick,
          shouldContinue,
          usage: modelOutput?.usage,
          stopReason: modelOutput?.stopReason,
          model: actualModelId,
          timestamp: timestamp(),
        });

        // Broadcast context utilization via channel
        this.broadcastContextInfo(
          executionId,
          actualModelId,
          model?.metadata,
          modelOutput?.usage,
          currentTick,
          usage,
          timestamp(),
        );

        // Emit fiber snapshot to DevTools
        this.emitFiberSnapshot(currentTick, executionId, compiled.rawCompiled);

        // Clear queued messages after tick completes - they've been processed
        this.ctx?.clearQueuedMessages();

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

        output = await this.complete();
        this._lastCompleteOutput = output;

        this._tick++;
        usage.ticks = (usage.ticks ?? 0) + 1;
      }

      // Accumulate usage
      this._totalUsage.inputTokens += usage.inputTokens;
      this._totalUsage.outputTokens += usage.outputTokens;
      this._totalUsage.totalTokens += usage.totalTokens;
      this._totalUsage.ticks = (this._totalUsage.ticks ?? 0) + (usage.ticks ?? 0);

      const resultPayload = {
        response: responseText,
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
      this.ctx?.clearQueuedMessages();

      // Notify execution end (runs useOnExecutionEnd callbacks)
      // Fires before snapshot — state changes here are persisted clean
      try {
        await this.compiler?.notifyExecutionEnd();
      } catch {
        // Ignore execution end errors (same pattern as notifyComplete)
      }

      this.emitEvent({
        type: "execution_end",
        executionId,
        stopReason,
        aborted: this._isAborted,
        usage,
        output: output ?? null,
        newTimelineEntries: this._timeline.slice(executionStartTimelineIndex),
        timestamp: timestamp(),
      });

      // Auto-persist snapshot after successful execution (fire-and-forget, skip on abort)
      if (this._persistCallback && !this._isAborted) {
        let snap = this.snapshot();
        if (this.appOptions.runner?.onPersist) {
          snap = await this.appOptions.runner.onPersist(this, snap);
        }
        this._persistCallback(snap).catch((err) => {
          this.log.warn({ error: err }, "Auto-persist failed");
        });
      }

      // Publish timeline delta to channel for real-time sync across clients
      // Only send NEW messages since last publish - O(delta) not O(n)
      if (output?.timeline) {
        const allMessages = output.timeline
          .filter((entry: COMTimelineEntry) => entry.message)
          .map((entry: COMTimelineEntry) => entry.message);

        // Only publish if there are new messages
        if (allMessages.length > this._lastPublishedTimelineLength) {
          const newMessages = allMessages.slice(this._lastPublishedTimelineLength);
          this._lastPublishedTimelineLength = allMessages.length;

          this.channel("timeline").publish({
            type: "timeline_delta",
            channel: "timeline",
            payload: {
              messages: newMessages, // Only new messages
              totalCount: allMessages.length, // For sync verification
              tick: this._tick,
            },
          });
        }
      }

      // Clear per-execution state
      this._currentExecutionId = null;

      for (const resolve of this._eventResolvers) {
        resolve({ value: undefined as any, done: true });
      }
      this._eventResolvers = [];

      this._status = "idle";

      // Auto-resume if messages were queued during execution
      if (this._queuedMessages.length > 0) {
        const tickProps = (this._lastProps ?? ({} as P)) as P;
        void this.render(tickProps);
      }
    }

    return {
      response: responseText,
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
    if (this.ctx && this.compiler && this.structureRenderer) {
      // Reuse existing - reset for new run
      this.ctx.clear();
      this._tick = 1;
      return;
    }

    // Create new infrastructure
    this.ctx = new COM({
      metadata: {},
    });

    this.compiler = new FiberCompiler(this.ctx);

    // Wire timeline accessors to RuntimeStore
    const runtimeStore = this.compiler.getRuntimeStore();
    runtimeStore.getSessionTimeline = () => this._timeline;
    runtimeStore.setSessionTimeline = (entries) => {
      this._timeline = [...entries];
    };

    // Create scheduler and wire it to the compiler
    // This enables the reactive model: state changes between ticks trigger reconciliation
    this.scheduler = new ReconciliationScheduler(this.compiler, {
      onReconcile: (event) => {
        this.emit("reconcile", event);
      },
    });

    // Wire compiler state changes to scheduler
    this.compiler.setReconcileCallback((reason) => {
      this.scheduler!.schedule(reason ?? "compiler recompile request");
    });

    // Wire COM recompile requests to scheduler
    // This unifies COM state signals with the reactive model
    this.ctx.setRecompileCallback((reason) => {
      this.scheduler!.schedule(reason ?? "COM recompile request");
    });

    // Wire COM spawn delegate to session's spawn Procedure
    this.ctx.setSpawnCallback((agent: any, input: any) => this.spawn(agent, input));

    this.structureRenderer = new StructureRenderer(this.ctx);
    this.structureRenderer.setDefaultRenderer(new MarkdownRenderer());

    // Tools are registered in compileTick() after merging all sources

    // Notify compiler that compilation is starting
    await this.compiler.notifyStart();

    // Apply snapshot-for-resolve if set (restore from store)
    if (this._snapshotForResolve) {
      try {
        const resolveConfig = this.appOptions.resolve as ResolveConfig | undefined;
        if (resolveConfig) {
          // Layer 2: resolve controls reconstruction
          const ctx: ResolveContext = { sessionId: this.id, snapshot: this._snapshotForResolve };
          const resolved = await this.executeResolve(resolveConfig, ctx);
          runtimeStore.resolvedData = resolved;
        } else {
          // Layer 1: auto-apply snapshot
          const snap = this._snapshotForResolve;
          this._timeline = [...(snap.timeline ?? [])];
          this._tick = snap.tick;
          if (snap.usage) this._totalUsage = { ...snap.usage };
          if (snap.comState && Object.keys(snap.comState).length > 0) {
            this.ctx.setStatePartial(snap.comState);
          }
          if (snap.dataCache && Object.keys(snap.dataCache).length > 0) {
            this.compiler.setDataCache(snap.dataCache);
          }
        }

        // Notify execution runner of restore
        if (this.appOptions.runner?.onRestore) {
          await this.appOptions.runner.onRestore(this, this._snapshotForResolve);
        }
      } finally {
        this._snapshotForResolve = null;
      }
    }

    // Initialize execution runner (once per session lifecycle)
    if (!this._runnerInitialized) {
      if (this.appOptions.runner?.onSessionInit) {
        await this.appOptions.runner.onSessionInit(this);
      }
      this._runnerInitialized = true;
    }
  }

  /**
   * Execute resolve configuration and return results.
   */
  private async executeResolve(
    config: ResolveConfig,
    ctx: ResolveContext,
  ): Promise<Record<string, unknown>> {
    if (typeof config === "function") {
      try {
        return await config(ctx);
      } catch (err) {
        throw new Error(
          `resolve function failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Object form: resolve each entry
    const results: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "function") {
        try {
          results[key] = await value(ctx);
        } catch (err) {
          throw new Error(
            `resolve["${key}"] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        results[key] = value;
      }
    }
    return results;
  }

  /**
   * Compile a single tick.
   */
  private async compileTick(
    rootElement: JSX.Element,
    executionTools: ExecutableTool[] = [],
  ): Promise<{
    formatted: COMInput;
    model?: EngineModel;
    modelInput?: any;
    tools: (ToolClass | ExecutableTool)[];
    shouldStop: boolean;
    stopReason?: string;
    /** Raw compiled structure for DevTools token estimation */
    rawCompiled?: CompiledStructure;
  }> {
    if (!this.ctx || !this.compiler || !this.structureRenderer) {
      throw new Error("Compilation infrastructure not initialized");
    }

    // Clear COM for this tick
    this.ctx.clear();

    // NOTE: Previous timeline entries are NOT injected into COM here.
    // They are merged in at formatInput time. This keeps the architecture declarative:
    // - JSX compilation produces CompiledStructure with NEW entries
    // - formatInput merges previousTimeline + new entries
    // - No imperative accumulation during render

    // Tools are NOT registered here — they're merged after compilation (see below)

    // Get queued messages for TickState - these are NEW messages for this tick
    const queuedMessages = this.ctx.getQueuedMessages();
    this.log.debug(
      { queuedCount: queuedMessages.length },
      "Queued messages available for TickState",
    );

    // Prepare tick state
    const tickState: TickState = {
      tick: this._tick,
      current: this._currentOutput as any,
      queuedMessages: queuedMessages,
      timeline: [...this._timeline],
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
    try {
      // Compile until stable
      // Note: tickControl and getChannel are available for future use
      // but not currently used by FiberCompiler
      void tickControl;
      void getChannel;
      const result = await this.compiler.compileUntilStable(
        rootElement as React.ReactNode,
        tickState,
        {
          maxIterations: 50,
        },
      );
      compiled = result.compiled;
    } finally {
      // Exit tick mode - any pending reconciliations will now flush
      this.scheduler?.exitTick();
    }

    // Apply compiled structure (sections, ephemeral, metadata — NOT tools or timeline)
    await this.structureRenderer.apply(compiled);

    // Merge tools from all sources (lowest → highest priority):
    // 1. App-level tools (appOptions.tools)
    // 2. Session-level tools (sessionOptions.tools)
    // 3. Per-execution tools (SendInput.tools)
    // 4. JSX-reconciled tools (compiled.tools) — highest priority
    const mergedTools = this.mergeTools(
      this.appOptions.tools ?? [],
      this.sessionOptions.tools ?? [],
      executionTools,
      compiled.tools,
    );

    // Register merged tools on COM (awaits schema conversion → ToolDefinition for model)
    await Promise.all(mergedTools.map((tool) => this.ctx!.addTool(tool)));

    // Format input - compiled structure IS the complete projection
    // JSX components render history as <Message>, so compiled.timelineEntries is complete
    const formatted = await this.structureRenderer.formatInput(this.ctx.toInput());

    // Track estimated context tokens for contextInfo
    this._estimatedContextTokens = formatted.totalTokens;

    // Get model from COM (set by <Model> components), fall back to appOptions
    const model = (this.ctx.getModel?.() as EngineModel | undefined) ?? this.appOptions.model;

    // Check for stop
    const stopReason = (tickState as any).stopReason;

    return {
      formatted,
      model,
      tools: mergedTools,
      shouldStop: !!stopReason,
      stopReason,
      rawCompiled: compiled,
    };
  }

  /**
   * Merge tools from multiple sources, deduplicating by name.
   * Later sources take priority (last-in wins).
   */
  private mergeTools(...sources: ExecutableTool[][]): ExecutableTool[] {
    const sourceLabels = ["app", "session", "execution", "JSX"];
    const byName = new Map<string, ExecutableTool>();
    for (let i = 0; i < sources.length; i++) {
      for (const tool of sources[i]) {
        const name = tool.metadata.name;
        if (byName.has(name)) {
          this.log.debug(
            { tool: name, source: sourceLabels[i] },
            "Tool collision: %s source overrides previous",
            sourceLabels[i],
          );
        }
        byName.set(name, tool);
      }
    }
    return Array.from(byName.values());
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

    // Subscribe to tool_confirmation channel to forward responses to the coordinator
    const confirmationChannel = this.channel("tool_confirmation");
    const coordinator = executor.getConfirmationCoordinator();
    const unsubscribe = confirmationChannel.subscribe((event) => {
      if (event.type === "response" && event.id) {
        const payload = event.payload as ToolConfirmationResponse | undefined;
        if (payload) {
          coordinator.resolveConfirmation(event.id, payload.approved, payload.always ?? false);
        }
      }
    });

    // Confirmation callbacks for stream event emission
    const confirmationCallbacks = {
      onConfirmationRequired: async (
        call: ToolCall,
        message: string,
        metadata?: Record<string, unknown>,
      ) => {
        this.emitEvent({
          type: "tool_confirmation_required",
          callId: call.id,
          name: call.name,
          input: call.input,
          message,
          metadata,
        });
      },
      onConfirmationResult: async (
        confirmation: { toolUseId: string; confirmed: boolean; always?: boolean },
        call: ToolCall,
      ) => {
        this.emitEvent({
          type: "tool_confirmation_result",
          callId: call.id,
          confirmed: confirmation.confirmed,
          always: confirmation.always,
        });
      },
    };

    try {
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

        // Execute tool (optionally wrapped by execution runner)
        try {
          const runner = this.appOptions.runner;
          let toolResult: ToolResult;

          if (runner?.executeToolCall) {
            toolResult = await runner.executeToolCall(call, tool, async () => {
              const r = await executor.processToolWithConfirmation(
                call,
                this.ctx!,
                executableTools,
                confirmationCallbacks,
              );
              return r.result;
            });
          } else {
            const r = await executor.processToolWithConfirmation(
              call,
              this.ctx!,
              executableTools,
              confirmationCallbacks,
            );
            toolResult = r.result;
          }

          results.push(toolResult);
          const completedAt = timestamp();
          this.emitEvent({
            type: "tool_result",
            callId: toolResult.toolUseId,
            name: toolResult.name,
            result: toolResult,
            isError: !toolResult.success,
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
    } finally {
      unsubscribe();
    }

    return results;
  }

  /**
   * Ingest model response and tool results.
   */
  private async ingestTickResult(
    response: any,
    toolResults: ToolResult[],
  ): Promise<{ shouldContinue: boolean; stopReason?: string; timeline: COMTimelineEntry[] }> {
    if (!this.ctx || !this.compiler) {
      throw new Error("Compilation infrastructure not initialized");
    }

    // Convert queued user messages to timeline entries BEFORE clearing
    // This preserves the user message in the conversation history
    const queuedMessages = this.ctx.getQueuedMessages();
    const existingTimeline = this.ctx.getTimeline();
    const existingByMessage = new Map<Message, COMTimelineEntry>();
    for (const entry of existingTimeline) {
      if (entry.message) {
        existingByMessage.set(entry.message, entry);
      }
    }

    const userEntries: COMTimelineEntry[] = [];
    const newUserEntries: COMTimelineEntry[] = [];

    for (const queued of queuedMessages) {
      if (!queued.content) continue;
      const message = queued.content as Message;
      if (message.role !== "user") continue;
      const existing = existingByMessage.get(message);
      if (existing) {
        userEntries.push(existing);
        continue;
      }
      const entry: COMTimelineEntry = {
        kind: "message",
        message,
        tags: ["user_input"] as TimelineTag[],
      };
      userEntries.push(entry);
      newUserEntries.push(entry);
    }

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

    // Add entries to COM and session timeline - user entries first, then assistant response
    for (const entry of newUserEntries) {
      this.ctx.addTimelineEntry(entry);
      this._timeline.push(entry);
    }

    if (response.newTimelineEntries) {
      for (const entry of response.newTimelineEntries) {
        this.ctx.addTimelineEntry(entry);
        this._timeline.push(entry);
      }
    }

    if (toolResults.length > 0) {
      const toolResultEntry: COMTimelineEntry = {
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
      };
      this.ctx.addTimelineEntry(toolResultEntry);
      this._timeline.push(toolResultEntry);
    }

    // Apply maxTimelineEntries trim
    if (this._maxTimelineEntries && this._timeline.length > this._maxTimelineEntries) {
      const removed = this._timeline.length - this._maxTimelineEntries;
      this._timeline = this._timeline.slice(-this._maxTimelineEntries);
      this.log.debug(
        { removed, remaining: this._timeline.length },
        "Timeline trimmed (maxTimelineEntries)",
      );
    }

    this._currentOutput = current;

    // Resolve tick control: continue if tool calls pending OR messages queued
    const shouldStop = response.shouldStop || false;
    const stopReason = response.stopReason?.reason;
    const hasToolCalls = (response.toolCalls?.length ?? 0) > 0;
    const hasPendingMessages =
      (this.ctx?.getQueuedMessages().length ?? 0) > 0 || this._queuedMessages.length > 0;

    return {
      shouldContinue: !shouldStop && (hasToolCalls || hasPendingMessages),
      stopReason,
      timeline: current.timeline,
    };
  }

  /**
   * Complete execution and return final state.
   *
   * Session._timeline is the source of truth. No merge/dedup logic needed.
   */
  private async complete(): Promise<COMInput> {
    if (!this.ctx || !this.structureRenderer || !this.compiler) {
      throw new Error("Compilation infrastructure not initialized");
    }

    const comOutput = this.ctx.toInput();
    const finalOutput: COMInput = {
      ...comOutput,
      timeline: [...this._timeline],
    };

    try {
      await this.compiler.notifyComplete(finalOutput);
    } catch {
      // Ignore completion errors
    }

    return finalOutput;
  }
}
