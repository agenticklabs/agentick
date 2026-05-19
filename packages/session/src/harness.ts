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

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime";
import type { LoopExecutorProtocol, ReconcilerProtocol } from "@agentick/spec";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ContentBlock,
  EventBus,
  ExecutionTarget,
  ExecutorProtocol,
  KnobHandle,
  LanguageModelExecutionResult,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NotifyTickEndInput,
  ObserveInput,
  Operation,
  OperationJournal,
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
  TickEndForwardDecision,
  TimelineEntry,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { buildSessionBridges, type SessionHookBridges } from "./session-bridges.js";
import { SessionStateStore } from "./session-state.js";
import { createSessionExecutionHandle } from "./session-execution-handle.js";

// ============================================================================
// Construction options
// ============================================================================

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
  readonly executor: ExecutorProtocol<
    unknown,
    unknown,
    LanguageModelExecutionResult
  >;
  /** Tool executor harness for tool dispatch. */
  readonly toolExecutor: ToolExecutorProtocol;
  /** Default execution target — overridable per send (later). */
  readonly target: ExecutionTarget;
  /** Default per-execution max tick bound. Default: 8. */
  readonly defaultMaxTicks?: number;
  /** Optional initial knob values. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
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

  private _closed = false;
  private _mountReady: Promise<void>;
  private _currentExecution: Promise<unknown> | null = null;

  constructor(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SessionHarnessOptions<P>,
  ) {
    super("session", options.sessionId, journal, bus, inbox);
    this.store = new SessionStateStore(options.sessionId);
    this.bridges = buildSessionBridges(this.store, {
      ...(options.toolBridge !== undefined
        ? { toolBridge: options.toolBridge }
        : {}),
    });
    if (options.initialKnobs) {
      this.bridges.knobs.importSnapshot(options.initialKnobs);
    }
    this.reconciler = options.reconciler;
    this.loop = options.loop;
    this.executor = options.executor;
    this.toolExecutor = options.toolExecutor;
    this.target = options.target;
    this.spawnContext = options.spawnContext;
    this.parentSessionId = options.parentSessionId;
    this.defaultMaxTicks = options.defaultMaxTicks ?? 8;
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

  timeline(): readonly TimelineEntry[] {
    return this.store.timeline();
  }

  snapshot(): SessionSnapshot {
    return {
      specVersion: SPEC_VERSION,
      id: this.store.id,
      status: this.store.status(),
      currentTick: this.store.currentTick(),
      // Materialize a copy — `store.timeline()` returns a live reference.
      // Without the slice, a captured snapshot mutates in place as the
      // session does more work, defeating the snapshot contract.
      timeline: this.store.timeline().slice(),
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
    await super.close();
  }

  // ── StateApplicator ──────────────────────────────────────────────

  applyExecutorResult(
    input: ApplyExecutorResultInput,
  ): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.try({
        try: () => this.applyExecutorResultSync(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.try({
        try: () => this.applyToolResultsSync(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return runHarnessProtocol(
      Effect.try({
        try: () => this.appendEntrySync(input),
        catch: (cause): StateApplyError => ({
          _tag: "TimelineWriteFailed",
          cause,
        }),
      }),
    );
  }

  async notifyLifecycle(
    _input: NotifyTickEndInput,
  ): Promise<TickEndForwardDecision> {
    // Phase 4e default: forward the tick-end to the reconciler so
    // any `useOnTickEnd` hooks fire, but don't override the loop's
    // continuation decision yet. Verdict-merge with in-tree hooks
    // arrives in a follow-on.
    return undefined;
  }

  // ──────── Extended interaction surface (block 5) ────────

  async spawn(
    input: SpawnInput<P>,
  ): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
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
      ...(input.initialProps !== undefined
        ? { initialProps: input.initialProps }
        : {}),
      ...(input.initialKnobs !== undefined
        ? { initialKnobs: input.initialKnobs }
        : {}),
      ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
    };
    const child = await this.spawnContext.createChildSession(childInput);
    if (input.send !== undefined) {
      return child.send(input.send);
    }
    return child;
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<readonly ContentBlock[]> {
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

  /**
   * `queue` writes a user-role message directly to the timeline and
   * — if no execution is in flight — fires a fresh `send` immediately.
   *
   * Mid-execution, the message becomes visible through the reactive
   * timeline subscription: the next render picks it up, the next tick
   * feeds it to the model. No separate "queued messages" buffer; the
   * timeline is the buffer.
   *
   * v1 parity: queued items flow through the JSX `<Timeline>`
   * component, which the reconciler reads live each render — same
   * effect as appending to the session timeline here.
   */
  async queue(message: SendMessageInput): Promise<void> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "queue" } satisfies SessionError;
    }
    // queue() coerces to user role regardless of message.role — that's
    // the verb's contract. Use append() / observe() for non-user entries.
    this.appendInputMessage({ ...message, role: "user" });
    // Auto-trigger when the session is idle. Mid-execution, the
    // running send picks up the message at its next render naturally.
    if (this._currentExecution === null) {
      // Fire-and-forget — the caller doesn't await the resulting
      // execution. Use `send({ messages: [m] })` if you need the
      // handle.
      void this.send({ messages: [] }).catch(() => {
        // Surfaced via session events; nothing to do here.
      });
    }
  }

  async append(
    input: AppendEntryInput,
    opts: { readonly trigger?: boolean } = {},
  ): Promise<{ readonly entryId: string } | SessionExecutionHandle> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "append" } satisfies SessionError;
    }
    const applied = this.appendEntrySync(input);
    const entryId = applied.appendedEntryIds[0]!;
    if (opts.trigger) {
      // Trigger an execution with no new messages — the appended
      // entry is already in the timeline. The send path picks it up.
      return this.send({ messages: [] });
    }
    return { entryId };
  }

  async observe(input: ObserveInput): Promise<{ readonly entryId: string }> {
    if (this._closed) {
      throw { _tag: "SessionClosedError", attemptedCommand: "observe" } satisfies SessionError;
    }
    const content: readonly ContentBlock[] =
      typeof input.content === "string"
        ? [{ type: "text", text: input.content }]
        : input.content;
    // Call the store directly so the metadata field is preserved.
    // appendEntrySync's narrower input doesn't carry metadata.
    const id = this.store.appendMessage({
      role: "event",
      content,
      metadata: { type: input.type, ...(input.metadata ?? {}) },
    });
    return { entryId: id };
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    const fullName = `session:channel:${name}`;
    const sessionId = this.store.id;
    const bus = this.bus;
    const inbox = this.inbox;
    const sessionAddress = this.address;
    return {
      name,
      publish: async (
        payload: T,
        metadata?: Readonly<Record<string, unknown>>,
      ) => {
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
                  ...(evx.metadata !== undefined
                    ? { metadata: evx.metadata }
                    : {}),
                  ...(evx.correlationId !== undefined
                    ? { correlationId: evx.correlationId }
                    : {}),
                  ...(evx.parentOpId !== undefined
                    ? { parentOpId: evx.parentOpId }
                    : {}),
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
        listener: (
          payload: TReq,
          ctx: import("@agentick/spec").RequestContext<TResp>,
        ) => void,
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
                        addressedTo: replyTo,
                        type: "request-response",
                        messageId: `m_${correlationId}`,
                        timestamp: Date.now(),
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
      set: (value: T) => bridge.set(name, value),
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

    // Apply new messages to the timeline.
    for (const m of input.messages ?? []) this.appendInputMessage(m);

    const executionId = `exec:${ulid()}`;
    this.store.setCurrentExecutionId(executionId);
    this.store.setStatus("running");

    // Per-call overrides — executor + target — fall through from
    // SendInput. The app-level executor/target is the default; this
    // send swaps in caller-supplied alternatives without changing
    // session state.
    const executorForCall = input.executor ?? this.executor;
    const targetForCall = input.target ?? this.target;

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
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    this._currentExecution = runPromise;

    const resultPromise: Promise<SendResult> = runPromise
      .then((terminal) => {
        const result = terminal.result;
        if (terminal.outcome !== "succeeded" || !result) {
          throw new Error(
            `execution ended with outcome=${terminal.outcome}: ${terminal.reason ?? ""}`,
          );
        }
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
        return sendResult;
      })
      .finally(() => {
        this._currentExecution = null;
        this.store.setCurrentExecutionId(null);
        this.store.setStatus("idle");
      });
    resultPromise.catch(() => {
      // Prevent unhandled rejections — handle has its own .result.
    });

    const handle = createSessionExecutionHandle({
      executionId,
      bus: this.bus,
      resultPromise,
      abort: async (reason) => {
        await this.loop.abort({ executionId, ...(reason !== undefined ? { reason } : {}) });
      },
    });

    return handle;
  }

  private applyExecutorResultSync(input: ApplyExecutorResultInput): ApplyResult {
    const ids: string[] = [];
    if (input.result.output.length > 0) {
      ids.push(
        this.store.appendMessage({
          role: "assistant",
          content: input.result.output,
        }),
      );
    }
    this.store.addUsage(input.result.usage);
    this.store.bumpTick();
    return { appendedEntryIds: ids };
  }

  private applyToolResultsSync(input: ApplyToolResultsInput): ApplyResult {
    const ids: string[] = [];
    for (const tr of input.results) {
      const block: ContentBlock = {
        type: "tool_result",
        toolUseId: tr.toolCallId,
        name: tr.toolName,
        content: tr.content,
        ...(tr.succeeded === false ? { isError: true } : {}),
      };
      ids.push(
        this.store.appendMessage({
          role: "tool",
          content: [block],
          toolCallId: tr.toolCallId,
          name: tr.toolName,
        }),
      );
    }
    return { appendedEntryIds: ids };
  }

  private appendEntrySync(input: AppendEntryInput): ApplyResult {
    const id = this.store.appendMessage({
      role: input.entry.role,
      content: input.entry.content,
    });
    return { appendedEntryIds: [id] };
  }

  private appendInputMessage(m: SendMessageInput): void {
    const content =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : m.content;
    this.store.appendMessage({
      role: m.role,
      content,
      ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
    });
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
