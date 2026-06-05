/**
 * `SessionHarness` — reference implementation of
 * `SessionHarnessProtocol`.
 *
 * Owns the integration between JSX agent + reconciler + loop executor.
 * The user-facing entry point: `session.send({ messages })` runs one
 * agent execution and returns a `SessionExecutionHandle`.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

import { Effect, Fiber, Stream } from "effect";

import {
  BaseHarness,
  resolveSyncSubstrateSlot,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime";
import type { LoopExecutorProtocol, ReconcilerProtocol } from "@agentick/spec";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ContentBlock,
  EventBus,
  EventBusFactory,
  ExecutionTarget,
  ExecutorProtocol,
  KnobHandle,
  LanguageModelExecutionResult,
  LoopEmittedEvent,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MessageInboxFactory,
  NotifyTickEndInput,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  ProtocolEvent,
  SendInput,
  SendMessageInput,
  SendResult,
  SessionError,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionSnapshot,
  SpawnContext,
  SpawnInput,
  StateApplyError,
  StreamEvent,
  TickEndForwardDecision,
  TimelineEntry,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { DEFAULT_JOURNALING_POLICY, SPEC_VERSION } from "@agentick/spec";
import type { KnobsHandle } from "@agentick/knobs";
import type { StateHandle } from "@agentick/state";
import type { TimelineHandle } from "@agentick/timeline";

import { buildSessionBridges, type SessionHookBridges } from "./session-bridges.js";
import { SessionStateStore } from "./session-state.js";
import { createSessionExecutionHandle, type SessionEmitInput } from "./session-execution-handle.js";

// ============================================================================
// Construction options
// ============================================================================

/**
 * Forward-reference shell handed to session-level substrate factories.
 * The session's BaseHarness fields aren't wired yet at substrate-
 * resolution time, so factories see a thin shell exposing only what's
 * safe at this phase: id, metadata, the *parent* (app) substrate as
 * default upstream, and a buffered `onClose` that replays onto the
 * real harness after construction.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Two-phase construction
 */
export interface SessionSubstrateParent {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** App's substrate, exposed as the default upstream for wrapping. */
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

export interface SessionHarnessOptions<P = unknown> {
  /** Stable session id. */
  readonly sessionId: string;
  /**
   * Agent root element. Opaque to the session — forwarded as-is to
   * `reconciler.mount({ element })`. The concrete reconciler impl owns
   * the type contract (React, Angular, etc.); the session is
   * reconciler-agnostic.
   */
  readonly agent: unknown;
  /** Initial component props (optional). */
  readonly props?: P;
  /**
   * Optional per-session substrate overrides. Each accepts a
   * pre-built instance (sharing with the app) or a factory
   * `(parent: SessionSubstrateParent) => R` that constructs a
   * session-scoped wrapper. When omitted, the session inherits the
   * app's substrate directly (today's default behavior).
   *
   * The factory pattern is how multi-tenant isolation lands:
   * `bus: LocalEventBus.factory()` returns a fresh bus that wraps the
   * app's bus (fan-in writes, isolated reads). Adopter metadata flows
   * through `parent.metadata` so the factory can branch on
   * per-session context (e.g. an adopter-defined `tenant` key).
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly bus?: EventBus | EventBusFactory<SessionSubstrateParent>;
  readonly inbox?: MessageInbox | MessageInboxFactory<SessionSubstrateParent>;
  readonly journal?: OperationJournal | OperationJournalFactory<SessionSubstrateParent>;
  /**
   * Adopter-defined metadata bag carried on the session and exposed
   * to substrate factories via `parent.metadata`. Framework defines
   * no keys; adopters stash whatever they want (tenant id, trace id,
   * routing hints).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Reconciler that owns the agent's element tree. Typed as the
   * protocol — any conformant impl (React reconciler, future Angular
   * reconciler, etc.) drops in.
   */
  readonly reconciler: ReconcilerProtocol;
  /**
   * Loop executor that orchestrates ticks. Typed as the protocol so
   * alternative orchestrators (cluster-aware, replay-based, etc.) can
   * be injected without changing the session boundary.
   */
  readonly loop: LoopExecutorProtocol;
  /** Executor harness for model invocations. */
  readonly executor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  /** Tool executor harness for tool dispatch. */
  readonly toolExecutor: ToolExecutorProtocol;
  /** Default execution target — overridable per send (later). */
  readonly target: ExecutionTarget;
  /** Default per-execution max tick bound. Default: 8. */
  readonly defaultMaxTicks?: number;
  /**
   * Session-level streaming default. Overridden by `SendInput.stream`
   * per-call. Falls through to the executor-capability default when
   * unset (streaming on when `executor.executeStream` exists AND
   * `target.capabilities.supportsStreaming` ≠ false).
   */
  readonly defaultStreaming?: boolean;
  /** Optional initial knob values. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /** Optional initial session-state values (`useSessionState`). */
  readonly initialState?: Readonly<Record<string, unknown>>;
  /**
   * Extension-provided bridges (sandbox, mcp, subscriptions, …) merged
   * into the per-session HookBridges. Adopters typically don't supply
   * this directly — the AppHarness installs extensions and passes the
   * resulting map through.
   */
  readonly extensionBridges?: ReadonlyMap<string, unknown>;
  /**
   * Optional tool bridge exposed to the reconciler via HookBridges.
   * When supplied, reconciler-side tools (e.g. React `createTool`
   * with `use()` hook) register handlers at render time. The bridge
   * is typically built by the AppHarness wrapping its shared
   * HandlerResolver.
   */
  readonly toolBridge?: import("@agentick/spec").ToolBridge;
  /**
   * Spawn context for child sessions. Typically injected by the
   * AppHarness when it constructs a session — the session keeps a
   * narrow back-reference to its parent app so `spawn()` works.
   * Sessions without a spawnContext throw when `spawn()` is called.
   */
  readonly spawnContext?: SpawnContext<P>;
  /** Parent session id when this session is itself a spawned child. */
  readonly parentSessionId?: string;
}

// ============================================================================
// SessionHarness
// ============================================================================

export class SessionHarness<P = unknown>
  extends BaseHarness<"session">
  implements SessionHarnessProtocol<P>
{
  private readonly store: SessionStateStore;
  private readonly bridges: SessionHookBridges;
  private readonly mountId: string;
  private readonly reconciler: ReconcilerProtocol;
  private readonly loop: LoopExecutorProtocol;
  private readonly executor: SessionHarnessOptions<P>["executor"];
  private readonly toolExecutor: ToolExecutorProtocol;
  private readonly target: ExecutionTarget;
  private readonly spawnContext: SpawnContext<P> | undefined;
  private readonly parentSessionId: string | undefined;
  private readonly defaultMaxTicks: number;
  private readonly defaultStreaming: boolean | undefined;

  private _closed = false;
  private _mountReady: Promise<void>;
  private _currentExecution: Promise<unknown> | null = null;

  constructor(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SessionHarnessOptions<P>,
  ) {
    // ADR 31 Phase 3 — session-level substrate slots accept
    // `instance | factory`. The factory's `parent` is a session shell
    // exposing the APP'S substrate as default upstream. Factories that
    // return wrapping primitives (e.g. `LocalEventBus.factory()`) thus
    // fan in to the app's bus by default — the multi-tenant pattern.
    // When no factory is supplied, the session inherits the app
    // substrate directly (today's default behavior).
    const pendingCloseHandlers: Array<() => void | Promise<void>> = [];
    const sessionShell: SessionSubstrateParent = {
      id: options.sessionId,
      metadata: Object.freeze({ ...(options.metadata ?? {}) }),
      bus,
      inbox,
      journal,
      onClose: (h) => pendingCloseHandlers.push(h),
    };
    const resolvedJournal = resolveSyncSubstrateSlot<
      OperationJournal,
      SessionSubstrateParent,
      OperationJournalFactory<SessionSubstrateParent>
    >(options.journal, sessionShell, () => journal, "session.journal");
    const resolvedBus = resolveSyncSubstrateSlot<
      EventBus,
      SessionSubstrateParent,
      EventBusFactory<SessionSubstrateParent>
    >(options.bus, sessionShell, () => bus, "session.bus");
    const resolvedInbox = resolveSyncSubstrateSlot<
      MessageInbox,
      SessionSubstrateParent,
      MessageInboxFactory<SessionSubstrateParent>
    >(options.inbox, sessionShell, () => inbox, "session.inbox");

    // Mark close-Operation envelopes bus-only (ADR 31 §close semantics).
    // The session's close body fires substrate-close handlers via
    // `super.close()` — close.body would crash on a closed journal
    // otherwise. Mirrors the AppHarness pattern.
    super("session", options.sessionId, resolvedJournal, resolvedBus, resolvedInbox, {
      metadata: options.metadata,
      policy: {
        ...DEFAULT_JOURNALING_POLICY,
        override: {
          "session:command:close": "bus-only",
        },
      },
    });
    // Replay any close handlers session-level factories registered
    // against the shell onto the now-real harness.
    for (const h of pendingCloseHandlers) this.onClose(h);

    this.store = new SessionStateStore(options.sessionId);
    this.bridges = buildSessionBridges(
      this.store,
      { journal: resolvedJournal, bus: resolvedBus, inbox: resolvedInbox },
      {
        ...(options.toolBridge !== undefined ? { toolBridge: options.toolBridge } : {}),
        ...(options.extensionBridges !== undefined
          ? { extensionBridges: options.extensionBridges }
          : {}),
      },
    );
    if (options.initialKnobs) {
      this.bridges.knobs.importSnapshot(
        options.initialKnobs as Readonly<Record<string, string | number | boolean>>,
      );
    }
    if (options.initialState) {
      this.bridges.state.importSnapshot(options.initialState);
    }
    this.reconciler = options.reconciler;
    this.loop = options.loop;
    this.executor = options.executor;
    this.toolExecutor = options.toolExecutor;
    this.target = options.target;
    this.spawnContext = options.spawnContext;
    this.parentSessionId = options.parentSessionId;
    this.defaultMaxTicks = options.defaultMaxTicks ?? 8;
    this.defaultStreaming = options.defaultStreaming;
    this.mountId = `mount:${options.sessionId}`;

    // Eagerly mount — the reconciler exposes `.ready` for its own
    // inbox registration; our mount is awaited via `_mountReady`. The
    // element type is opaque here — `MountInput.element: unknown` in
    // the spec — and the bound reconciler impl interprets it.
    this._mountReady = this.reconciler
      .mount({
        mountId: this.mountId,
        sessionId: options.sessionId,
        element: options.agent,
        bridges: this.bridges,
      })
      .then(() => {});
  }

  /**
   * Resolves once the underlying reconciler mount is complete. Most
   * callers can `await session.ready` (the base inbox ready) and then
   * `await session.mountReady` if they need to be sure the JSX tree
   * has rendered at least once.
   */
  get mountReady(): Promise<void> {
    return this._mountReady;
  }

  // ──────── SessionHarnessProtocol ────────

  send(input: SendInput<P>): Promise<SessionExecutionHandle> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.sendBody(input),
        catch: (cause): SessionError => coerceSessionError(cause),
      }),
    );
  }

  // ──────── Top-level harness handles (ADR 27 augmentations) ────────

  /**
   * The session's timeline handle — append/queue/drain/compact/subscribe
   * + sync reads of projection, persisted log, and pending. Curated
   * subset of `TimelineHarnessProtocol`. The `bridges.timeline` runtime
   * harness satisfies the `TimelineHandle` interface structurally;
   * no wrapper.
   *
   * Adopters who previously called `session.timeline()`, `session.append()`,
   * `session.queue()`, or `session.observe()` now reach for
   * `session.timeline.{read, append, queue, observe?, ...}`.
   */
  get timeline(): TimelineHandle {
    return this.bridges.timeline;
  }

  /**
   * The session's knobs handle — list/get/set/dispatch/subscribe over
   * the model-visible reactive state. Per-knob access (by reference)
   * remains `session.knob(name)`.
   */
  get knobs(): KnobsHandle {
    return this.bridges.knobs;
  }

  /**
   * The session's adopter-stash state handle — K/V get/set/has/delete/
   * list + per-key and global subscription. Not model-visible.
   */
  get state(): StateHandle {
    return this.bridges.state;
  }

  snapshot(): SessionSnapshot {
    // Step 5a: snapshot.timeline holds the durable persisted log. The
    // projection (potentially compacted) is not yet round-tripped via
    // SessionSnapshot — Step 6 (SnapshotHarness) will compose per-harness
    // snapshots into the session shape and carry both layers.
    return {
      specVersion: SPEC_VERSION,
      id: this.store.id,
      status: this.store.status(),
      currentTick: this.store.currentTick(),
      timeline: [...this.bridges.timeline.readPersisted()],
      knobs: this.bridges.knobs.exportSnapshot(),
      usage: this.store.usage(),
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.store.setStatus("closed" as never);
    // Tear down the reconciler mount; ignore errors during shutdown.
    try {
      await this.reconciler.unmount({ mountId: this.mountId });
    } catch {
      // shutdown — best effort
    }
    // Close every bridge that exposes a `close()` — built-ins
    // (timeline/knobs/state) and extension-installed bridges
    // (sandbox/mcp/subscriptions/...) alike. Duck-typed: any bridge
    // entry whose `close` is a function gets shut down. Plain accessor
    // bridges (data/loop/session) are no-ops here.
    const closes: Promise<unknown>[] = [];
    for (const value of Object.values(this.bridges)) {
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { close?: unknown }).close === "function"
      ) {
        closes.push(
          Promise.resolve((value as { close: () => unknown }).close()).catch(() => undefined),
        );
      }
    }
    await Promise.all(closes);
    await super.close();
  }

  // ── StateApplicator ──────────────────────────────────────────────

  applyExecutorResult(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.applyExecutorResultBody(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.applyToolResultsBody(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.tryPromise({
        try: () => this.appendEntryBody(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  async notifyLifecycle(_input: NotifyTickEndInput): Promise<TickEndForwardDecision> {
    // Phase 4e default: forward the tick-end to the reconciler so
    // any `useOnTickEnd` hooks fire, but don't override the loop's
    // continuation decision yet. Verdict-merge with in-tree hooks
    // arrives in a follow-on.
    return undefined;
  }

  // ──────── Extended interaction surface (block 5) ────────

  async spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "spawn" } satisfies SessionError;
    }
    if (this.spawnContext === undefined) {
      throw {
        _tag: "ExecutionFailed",
        cause: new Error(
          "spawn() requires a spawnContext — the session was constructed without an app-level parent",
        ),
      } satisfies SessionError;
    }
    const childInput = {
      parentSessionId: this.store.id,
      agent: input.agent,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.initialProps !== undefined ? { initialProps: input.initialProps } : {}),
      ...(input.initialKnobs !== undefined ? { initialKnobs: input.initialKnobs } : {}),
      ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
    };
    const child = await this.spawnContext.createChildSession(childInput);
    if (input.send !== undefined) {
      return child.send(input.send);
    }
    return child;
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<readonly ContentBlock[]> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "dispatch" } satisfies SessionError;
    }
    await this._mountReady;
    const result = await this.toolExecutor.dispatch({
      toolCallId: `host:${ulid()}`,
      name,
      input,
      context: { via: "dispatch", sessionId: this.store.id },
    });
    return result.content;
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    const fullName = `session:channel:${name}`;
    const sessionId = this.store.id;
    const bus = this.bus;
    const inbox = this.inbox;
    const sessionAddress = this.address;
    return {
      name,
      publish: async (payload: T, metadata?: Readonly<Record<string, unknown>>) => {
        const ev: ProtocolEvent = {
          id: ulid(),
          surface: "session",
          name: fullName,
          phase: "delta",
          timestamp: Date.now(),
          scope: { sessionId },
          payload,
          ...(metadata !== undefined ? { metadata } : {}),
        } as ProtocolEvent;
        await Effect.runPromise(bus.publish(ev));
      },
      subscribe: (listener) => {
        // Subscribe is pub/sub only — drop envelopes tagged as
        // requests so handlers using onRequest aren't double-routed.
        const fiber = Effect.runFork(
          Stream.runForEach(
            bus.subscribe({ surface: "session", name: { exact: fullName } }),
            (ev) =>
              Effect.sync(() => {
                const evx = ev as {
                  channelSequence?: number;
                  parentOpId?: string;
                  metadata?: Readonly<Record<string, unknown>>;
                  correlationId?: string;
                };
                if (evx.metadata?.requestType === "request") return;
                const meta: import("@agentick/spec").ChannelEventMeta = {
                  id: ev.id,
                  timestamp: ev.timestamp,
                  ...(evx.metadata !== undefined ? { metadata: evx.metadata } : {}),
                  ...(evx.correlationId !== undefined ? { correlationId: evx.correlationId } : {}),
                  ...(evx.parentOpId !== undefined ? { parentOpId: evx.parentOpId } : {}),
                  ...(evx.channelSequence !== undefined
                    ? { channelSequence: evx.channelSequence }
                    : {}),
                };
                listener(ev.payload as T, meta);
              }),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
      },
      request: async <TReq, TResp>(
        payload: TReq,
        opts?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<TResp> => {
        // Delegate to the session's BaseHarness.request capability.
        // The session is itself a BaseHarness — protected method
        // accessed via the public sessionRequest helper below.
        return this.sessionRequest<TReq, TResp>(name, payload, opts);
      },
      onRequest: <TReq = unknown, TResp = unknown>(
        listener: (payload: TReq, ctx: import("@agentick/spec").RequestContext<TResp>) => void,
      ) => {
        const fiber = Effect.runFork(
          Stream.runForEach(
            bus.subscribe({ surface: "session", name: { exact: fullName } }),
            (ev) =>
              Effect.sync(() => {
                const evx = ev as {
                  metadata?: Readonly<Record<string, unknown>>;
                };
                const md = evx.metadata;
                if (md?.requestType !== "request") return;
                const correlationId = md.correlationId as string | undefined;
                const replyTo = md.replyTo as string | undefined;
                if (!correlationId || !replyTo) return;
                const ctx: import("@agentick/spec").RequestContext<TResp> = {
                  correlationId,
                  replyTo,
                  metadata: md,
                  respond: async (response: TResp) => {
                    await Effect.runPromise(
                      inbox.send(replyTo, {
                        type: "request-response",
                        messageId: `m_${correlationId}`,
                        payload: { correlationId, response },
                      }),
                    );
                  },
                };
                listener(ev.payload as TReq, ctx);
              }),
          ),
        );
        return () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
        // sessionAddress acknowledged via the outer closure so the
        // lint doesn't flag it as unused when the parent uses it.
        void sessionAddress;
      },
    };
  }

  /**
   * Public bridge to `BaseHarness.request` — channel handles call
   * this so they don't need access to the protected method.
   */
  async sessionRequest<TReq, TResp>(
    channel: string,
    payload: TReq,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TResp> {
    const eff = this.request<TReq, TResp>(channel, payload, opts ?? {});
    return runHarnessProtocol(eff);
  }

  knob<T = unknown>(name: string): KnobHandle<T> {
    const bridge = this.bridges.knobs;
    return {
      name,
      get: () => bridge.get(name) as T,
      // Fire-and-forget the async Operation; callers using this
      // sync surface expect "queue the mutation, move on."
      set: (value: T) => {
        void bridge.set({ id: name, value: value as string | number | boolean });
      },
      subscribe: (listener) => bridge.subscribe(name, listener),
    };
  }

  // ──────── inbox dispatch ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("session inbox dispatch not yet wired (Phase 4e+)"),
    });
  }

  // ──────── internals ────────

  private async sendBody(input: SendInput<P>): Promise<SessionExecutionHandle> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "send" };
    }
    if (this._currentExecution !== null) {
      throw {
        _tag: "SessionBusyError",
        reason: "another execution is in flight (single-execution semantics in 4e MVP)",
      };
    }

    await this._mountReady;

    // Queue new input messages onto pending. The model sees them on
    // the next render via the Timeline component (which reads pending
    // alongside the projection); the durable timeline catches up below
    // when we drain.
    for (const m of input.messages ?? []) await this.queueInputMessage(m);

    // Drain all pending messages into the timeline before this execution
    // starts so the loop's first tick sees them in the durable timeline.
    // Messages queued mid-execution stay in pending until the NEXT
    // sendBody; the Timeline component still surfaces them to the model
    // via render. (Per-tick drain is a follow-up — see ADR 26 Step 6+.)
    await this.bridges.timeline.drain();

    const executionId = `exec:${ulid()}`;
    this.store.setCurrentExecutionId(executionId);
    this.store.setStatus("running");

    // Per-call overrides — executor + target — fall through from
    // SendInput. The app-level executor/target is the default; this
    // send swaps in caller-supplied alternatives without changing
    // session state.
    const executorForCall = input.executor ?? this.executor;
    const targetForCall = input.target ?? this.target;

    // Resolve streaming preference. Cascade:
    //   SendInput.stream  >  session-level streaming default
    //                     >  executor capability default
    // The capability default is true when both:
    //   - the executor exposes `executeStream`
    //   - target.capabilities.supportsStreaming is not explicitly false
    const capabilityStreamDefault =
      typeof executorForCall.executeStream === "function" &&
      (targetForCall.capabilities?.supportsStreaming ?? true);
    const streamForCall =
      input.stream ?? this.defaultStreaming ?? capabilityStreamDefault;

    // Set up the handle + emit chain BEFORE running the loop so the
    // loop can pump events into it from the first tick.
    const resultDeferred = {} as { resolve: (r: SendResult) => void; reject: (e: unknown) => void };
    const resultPromise = new Promise<SendResult>((resolve, reject) => {
      resultDeferred.resolve = resolve;
      resultDeferred.reject = reject;
    }).finally(() => {
      this._currentExecution = null;
      this.store.setCurrentExecutionId(null);
      this.store.setStatus("idle");
    });
    resultPromise.catch(() => {
      // Prevent unhandled rejections — handle has its own .result.
    });

    const { handle, emit, close } = createSessionExecutionHandle({
      sessionId: this.store.id,
      executionId,
      resultPromise,
      abort: async (reason) => {
        await this.loop.abort({ executionId, ...(reason !== undefined ? { reason } : {}) });
      },
    });

    const onEvent = this.buildOnEvent(emit);

    const runPromise = this.loop.runExecution({
      executionId,
      sessionId: this.store.id,
      reconciler: this.reconciler,
      mountId: this.mountId,
      executor: executorForCall,
      target: targetForCall,
      toolExecutor: this.toolExecutor,
      stateApplicator: {
        applyExecutorResult: (i) => this.applyExecutorResult(i).then(() => undefined),
        applyToolResults: (i) => this.applyToolResults(i).then(() => undefined),
        appendEntry: (i) => this.appendEntry(i).then(() => undefined),
      },
      maxTicks: input.maxTicks ?? this.defaultMaxTicks,
      stream: streamForCall,
      onEvent,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    this._currentExecution = runPromise;

    // Resolve the result promise + emit the final `result` StreamEvent
    // when the loop terminates. Iterator closes after the result event.
    void runPromise.then(
      (terminal) => {
        const result = terminal.result;
        if (terminal.outcome === "succeeded" && result) {
          const response = result.output
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          const sendResult: SendResult = {
            response,
            output: result.output,
            toolResults: result.toolResults,
            usage: result.usage,
            stopReason: result.stopReason,
            ticks: result.ticks,
            executionId,
          };
          emit({ type: "result", tick: 0, result: sendResult });
          resultDeferred.resolve(sendResult);
        } else {
          resultDeferred.reject(
            new Error(
              `execution ended with outcome=${terminal.outcome}: ${terminal.reason ?? ""}`,
            ),
          );
        }
        close();
      },
      (err) => {
        resultDeferred.reject(err);
        close();
      },
    );

    return handle;
  }

  /**
   * Translate a `LoopEmittedEvent` into the public StreamEvent shape
   * and push it onto the handle's iterator queue. Used as the loop's
   * `onEvent` callback during `runExecution`.
   */
  private buildOnEvent(emit: (event: SessionEmitInput) => void): (event: LoopEmittedEvent) => void {
    return (loopEvent) => {
      switch (loopEvent.kind) {
        case "model":
          emit({ ...loopEvent.delta, tick: loopEvent.tick } as never);
          return;
        case "tick-start":
          emit({ type: "tick-start", tick: loopEvent.tick, tickIndex: loopEvent.tickIndex });
          return;
        case "tick-end":
          emit({
            type: "tick-end",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            shouldContinue: loopEvent.shouldContinue,
            ...(loopEvent.stopReason !== undefined ? { stopReason: loopEvent.stopReason } : {}),
            ...(loopEvent.usage !== undefined ? { usage: loopEvent.usage } : {}),
          });
          return;
        case "tick":
          emit({
            type: "tick",
            tick: loopEvent.tick,
            tickIndex: loopEvent.tickIndex,
            stopReason: loopEvent.stopReason,
            usage: loopEvent.usage,
            durationMs: loopEvent.durationMs,
          });
          return;
        case "execution-start":
          emit({
            type: "execution-start",
            tick: loopEvent.tick,
            ...(loopEvent.rootExecutionId !== undefined
              ? { rootExecutionId: loopEvent.rootExecutionId }
              : {}),
          });
          return;
        case "execution-end":
          emit({
            type: "execution-end",
            tick: loopEvent.tick,
            stopReason: loopEvent.stopReason,
            ...(loopEvent.aborted !== undefined ? { aborted: loopEvent.aborted } : {}),
            ...(loopEvent.error !== undefined ? { error: loopEvent.error } : {}),
          });
          return;
        case "tool-dispatch-start":
          emit({
            type: "tool-dispatch-start",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            via: loopEvent.via,
          });
          return;
        case "tool-dispatch-end":
          emit({
            type: "tool-dispatch-end",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            outcome: loopEvent.outcome,
            durationMs: loopEvent.durationMs,
          });
          return;
        case "tool-dispatch":
          emit({
            type: "tool-dispatch",
            tick: loopEvent.tick,
            callId: loopEvent.callId,
            name: loopEvent.name,
            content: loopEvent.content,
            succeeded: loopEvent.succeeded,
            durationMs: loopEvent.durationMs,
            ...(loopEvent.executedBy !== undefined ? { executedBy: loopEvent.executedBy } : {}),
            ...(loopEvent.isError !== undefined ? { isError: loopEvent.isError } : {}),
          });
          return;
      }
    };
  }

  private async applyExecutorResultBody(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    const ids: string[] = [];
    if (input.result.output.length > 0) {
      const id = await this.appendMessageEntry({
        role: "assistant",
        content: input.result.output,
      });
      ids.push(id);
    }
    this.store.addUsage(input.result.usage);
    this.store.bumpTick();
    return { appendedEntryIds: ids };
  }

  private async applyToolResultsBody(input: ApplyToolResultsInput): Promise<ApplyResult> {
    const ids: string[] = [];
    for (const tr of input.results) {
      const block: ContentBlock = {
        type: "tool_result",
        toolUseId: tr.toolCallId,
        name: tr.toolName,
        content: tr.content,
        ...(tr.succeeded === false ? { isError: true } : {}),
      };
      const id = await this.appendMessageEntry({
        role: "tool",
        content: [block],
        toolCallId: tr.toolCallId,
        name: tr.toolName,
      });
      ids.push(id);
    }
    return { appendedEntryIds: ids };
  }

  private async appendEntryBody(input: AppendEntryInput): Promise<ApplyResult> {
    const id = await this.appendMessageEntry({
      role: input.entry.role,
      content: input.entry.content,
    });
    return { appendedEntryIds: [id] };
  }

  /**
   * Route a user-input message into the pending queue. The harness's
   * Timeline component reads `readPending()` and renders pending
   * entries alongside the projection so the model sees them on the
   * next render. The actual append (durable timeline write) happens
   * at the start of the next `sendBody` via `bridges.timeline.drain()`.
   */
  private async queueInputMessage(m: SendMessageInput): Promise<void> {
    const content =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    await this.bridges.timeline.queue({
      role: m.role,
      content,
      ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
    });
    // Single-input call → result.ids has length 1; caller doesn't need it.
  }

  /**
   * Internal helper — build a `TimelineEntry` for a message and route
   * the append through the TimelineHarness. Returns the message id so
   * `StateApplicator` callers can include it in their `ApplyResult`.
   */
  private async appendMessageEntry(input: {
    readonly role: import("@agentick/spec").SessionMessageRole;
    readonly content: readonly ContentBlock[];
    readonly visibility?: "model" | "observer" | "log";
    readonly toolCallId?: string;
    readonly name?: string;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const messageId = `m_${ulid()}`;
    const message: import("@agentick/spec").SessionMessage = {
      id: messageId,
      role: input.role,
      content: input.content,
      ts: Date.now(),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const entry: TimelineEntry = {
      kind: "message",
      message,
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    await this.bridges.timeline.append(entry);
    return messageId;
  }
}

// Resolve unused-import lint for Operation when concrete subclasses
// add commands that use it.
void (undefined as unknown as Operation<unknown, unknown, unknown>);

/**
 * If the thrown value is already a tagged `SessionError`, pass it
 * through; otherwise wrap as `ExecutionFailed`. Without this, internal
 * pre-execution failures (e.g., `SessionClosedError`, `SessionBusyError`)
 * get swallowed into a generic ExecutionFailed and the caller can't
 * tell what went wrong.
 */
function coerceSessionError(cause: unknown): SessionError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as SessionError;
  }
  return { _tag: "ExecutionFailed", cause };
}
