/**
 * `defineSession` — callback-style `SessionHarnessProtocol` factory.
 *
 * Lets a user satisfy `SessionHarnessProtocol` without subclassing
 * `BaseHarness`/`SessionHarness`. Useful for testing topologies, mocks,
 * and the rare case where session orchestration is fundamentally
 * different from the framework default.
 *
 * **Most adopters should subclass `SessionHarness`** — the session is
 * deeply integrated with compiler/executor/loop/tool-executor wiring,
 * and the default impl handles a lot of plumbing. `defineSession` is
 * for the cases where that plumbing is the wrong fit.
 *
 * Required callbacks: `send` and the state applicator triple
 * (`applyExecutorResult`/`applyToolResults`/`appendEntry`).
 * Other methods (including the optional `close`) default to throwing
 * "method not configured" — adopters override what they need.
 *
 * Top-level handles (`timeline`/`knobs`/`state` per ADR 27 augmentation)
 * default to no-op stubs. Adopters override with real handles if they
 * want adopters of their session to read/write timeline state.
 *
 * ```ts
 * const mySession = defineSession<MyProps>({
 *   async send(input) { ... },
 *   async close() { ... },
 *   async applyExecutorResult(input) { ... },
 *   async applyToolResults(input) { ... },
 *   async appendEntry(input) { ... },
 * });
 *
 * const session = mySession({
 *   scopeId: "s_test",
 *   journal: new MemoryJournal(),
 *   bus: new LocalEventBus(),
 *   inbox: new LocalInbox(),
 * });
 * ```
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (FAÇADE.6)
 */

import { Effect } from "effect";
import {
  BaseHarness,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  generateId,
} from "@agentick/runtime";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ToolsHandle,
  EscalationInterceptor,
  EventBus,
  EventEnvelope,
  KnobHandle,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NotifyTickEndInput,
  Operation,
  OperationJournal,
  SendInput,
  SessionError,
  SessionExecutionHandle,
  SessionStatus,
  SessionHarnessFactory,
  SessionHarnessFactoryDeps,
  SessionHarnessProtocol,
  ForkInput,
  SpawnInput,
  TickEndForwardDecision,
  Unsubscribe,
  ModelInfoResult,
} from "@agentick/spec";
import type { KnobsHandle } from "@agentick/knobs";
import type { GateHandle, GatesHandle } from "@agentick/gates";
import type { StateHandle } from "@agentick/state";
import type { TimelineHandle } from "@agentick/timeline";
import { buildSessionElicit, ElicitationHarness } from "@agentick/elicitation";
import { TasksHarness } from "@agentick/tasks";
import { ResourcesHarness } from "@agentick/resources";
import type {
  Elicit,
  ElicitationHarnessProtocol,
  RegisteredModel,
  Resources,
  TasksHarnessProtocol,
} from "@agentick/spec";
import { ExecutionFailed, HandlerError } from "@agentick/spec";
import type { ModelSelectionHandle } from "./model-facade.js";

// ============================================================================
// Public API
// ============================================================================

export interface DefineSessionInput<P = unknown> {
  // ── Required: lifecycle + core verbs ─────────────────────────────────
  readonly send: (input: SendInput<P>) => Promise<SessionExecutionHandle>;
  /**
   * Flush this session's durable state to wherever it lives — the checkpoint
   * barrier. Optional; omit and `snapshot()` resolves as a no-op (a callback
   * session with nothing write-behind to drain).
   */
  readonly snapshot?: () => Promise<void>;
  /**
   * Rehydrate this session from wherever its state lives. Optional — omit to
   * get a façade that rejects `restore()` with "not configured" (a callback
   * session that checkpoints but cannot reopen).
   */
  readonly restore?: () => Promise<void>;
  /**
   * Cancel the current execution. Optional — omit to get a façade that
   * rejects `abort()` with "not configured" (a callback session that runs
   * work but exposes no way to stop it).
   */
  readonly abort?: (reason?: string) => Promise<void>;
  readonly close?: () => Promise<void>;

  // ── Required: state applicator (the loop calls these) ────────────────
  readonly applyExecutorResult: (input: ApplyExecutorResultInput) => Promise<ApplyResult>;
  readonly applyToolResults: (input: ApplyToolResultsInput) => Promise<ApplyResult>;
  readonly appendEntry: (input: AppendEntryInput) => Promise<ApplyResult>;

  // ── Optional: extended surface (default to throwing) ─────────────────
  readonly notifyLifecycle?: (input: NotifyTickEndInput) => Promise<TickEndForwardDecision>;
  readonly spawn?: (
    input: SpawnInput<P>,
  ) => Promise<SessionExecutionHandle | SessionHarnessProtocol<P>>;
  readonly fork?: (input?: ForkInput) => Promise<SessionHarnessProtocol<P>>;
  readonly modelInfo?: () => ModelInfoResult | undefined;
  /**
   * The session's tools handle (three-audiences-plan §F). Replaces the former
   * `dispatch` callback — a whole `ToolsHandle` (View reads + host-door
   * `dispatch` + subscription). Omit to get a throwing default.
   */
  readonly tools?: ToolsHandle;
  readonly channel?: <T = unknown>(name: string) => ChannelHandle<T>;
  /**
   * Render a channel's current snapshot as its opening frame (slice 2 —
   * `SessionHarnessProtocol.channelSnapshot`). Omit to opt out: the façade
   * then reports "no provider owns this channel" (`undefined`) for every
   * channel, so a subscription simply opens with no seed frame.
   */
  readonly channelSnapshot?: (channel: string) => Promise<EventEnvelope | undefined>;
  readonly knob?: <T = unknown>(name: string) => KnobHandle<T>;
  readonly gate?: (name: string) => GateHandle | undefined;

  // ── Optional: top-level handles (ADR 27 augmentations) ───────────────
  readonly timeline?: TimelineHandle;
  readonly knobs?: KnobsHandle;
  readonly gates?: GatesHandle;
  readonly state?: StateHandle;
  /**
   * Model selection / swap facade for the augmented
   * `SessionHarnessProtocol.model` slot (ADR 89 §2). Omit to get a no-op stub
   * whose `current` reads `undefined` (a callback session owns no model
   * default, which the handle's contract calls legal) and whose `setModel` /
   * `setTarget` reject with "not configured". Supply a real
   * {@link ModelSelectionHandle} to expose model swap/interception.
   */
  readonly model?: ModelSelectionHandle;
  /**
   * Pre-constructed elicitation harness for the
   * `SessionHarnessProtocol.elicitation` slot. Omit to let the
   * factory spin one up on the supplied substrate (the common case
   * for tests + ad-hoc harnesses).
   */
  readonly elicitation?: ElicitationHarnessProtocol;
  /**
   * Pre-constructed tasks harness for the augmented
   * `SessionHarnessProtocol.tasks` slot (#120 / #156). Same omission
   * semantics as `elicitation` — factory spins one up if absent.
   */
  readonly tasks?: TasksHarnessProtocol;
  /**
   * Pre-constructed resources harness for the augmented
   * `SessionHarnessProtocol.resources` slot (ADR 62). Same omission
   * semantics as `elicitation` / `tasks` — the factory spins one up on
   * the supplied substrate if absent.
   */
  readonly resources?: Resources;
}

export function defineSession<P = unknown>(spec: DefineSessionInput<P>): SessionHarnessFactory<P> {
  const factory = (deps?: SessionHarnessFactoryDeps): SessionHarnessProtocol<P> => {
    const scopeId = deps?.scopeId ?? `define-session:${generateId()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackSessionHarness<P>(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { sessionHarnessFactory: true as const });
}

// ============================================================================
// CallbackSessionHarness
// ============================================================================

/** A callback session has no render pipeline to preview. */
function unsupportedPreview(rung: string): SessionError {
  return coerceSessionError(
    new Error(
      `${rung}() is unavailable on a callback session — it has no compiler or ` +
        `executor to render through. Use a compiled session (createApp / ` +
        `createSession) to preview what a tick would send.`,
    ),
  );
}

class CallbackSessionHarness<P = unknown>
  extends BaseHarness<"session">
  implements SessionHarnessProtocol<P>
{
  get id(): string {
    return this.scopeId;
  }

  get status(): SessionStatus {
    return this._status;
  }
  private _status: SessionStatus = "idle";

  /**
   * Mark the session busy for the life of `handle.result`. A callback session
   * runs its own turn, so the handle settling is the only point at which the
   * framework can see the run end.
   */
  private trackRun<T>(handle: SessionExecutionHandle<T>): SessionExecutionHandle<T> {
    this._status = "running";
    void Promise.resolve(handle.result)
      .catch(() => undefined)
      .finally(() => {
        this._status = "idle";
      });
    return handle;
  }

  private readonly spec: DefineSessionInput<P>;
  readonly timeline: TimelineHandle;
  readonly knobs: KnobsHandle;
  readonly gates: GatesHandle;
  readonly state: StateHandle;
  readonly model: ModelSelectionHandle;
  readonly elicitation: ElicitationHarnessProtocol;
  readonly elicit: Elicit;
  readonly tasks: TasksHarnessProtocol;
  readonly resources: Resources;
  private escalationInterceptor: EscalationInterceptor | undefined;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineSessionInput<P>,
  ) {
    super("session", scopeId, journal, bus, inbox);
    this.spec = spec;
    this.timeline = spec.timeline ?? noopTimelineHandle();
    this.knobs = spec.knobs ?? noopKnobsHandle();
    this.gates = spec.gates ?? noopGatesHandle();
    this.state = spec.state ?? noopStateHandle();
    this.model = spec.model ?? noopModelHandle();
    // Adopter-provided elicitation overrides; otherwise spin up a
    // fresh harness on the same substrate so the SessionHarnessProtocol
    // slot is honored without forcing test callers to thread one in.
    // `parentScope` carries the sessionId so published elicitation
    // request envelopes match session-scoped client subscriptions.
    this.elicitation =
      spec.elicitation ??
      new ElicitationHarness(`${scopeId}:elicitation`, journal, bus, inbox, {
        parentScope: { sessionId: scopeId },
      });
    this.elicit = buildSessionElicit({ harness: this.elicitation });
    this.tasks =
      spec.tasks ??
      new TasksHarness(`${scopeId}:tasks`, journal, bus, inbox, {
        parentScope: { sessionId: scopeId },
      });
    this.resources =
      spec.resources ?? new ResourcesHarness(`${scopeId}:resources`, journal, bus, inbox);
  }

  // ──────── SessionHarnessProtocol — core ────────

  send<T = unknown>(input: SendInput<P, T>): Promise<SessionExecutionHandle<T>> {
    const op: Operation<SendInput<P>, SessionExecutionHandle> = {
      opId: `session:send:${generateId()}`,
      surface: "session",
      name: "session:command:send",
      scope: {},
      input,
    };
    // Same one-boundary cast as the reference harness: the pipeline is erased
    // to `unknown` data; the caller's `output` schema is the narrowing truth.
    return (
      runHarnessProtocol(
        this.runOperation(op, (i) =>
          Effect.tryPromise({
            try: () => this.spec.send(i),
            catch: (cause): SessionError => coerceSessionError(cause),
          }),
        ),
      ) as Promise<SessionExecutionHandle<T>>
    ).then((handle) => this.trackRun(handle));
  }

  abort(reason?: string): Promise<void> {
    if (this.spec.abort) return this.spec.abort(reason);
    // Rejects rather than resolving quietly: a caller that asked to cancel and
    // got a success from a session that cancelled nothing is the exact defect
    // the `session/abort` wire verb had. "Nothing running" is the SESSION's
    // no-op to make (see `SessionHarness.abort`); "I never wired cancellation"
    // is a configuration gap and says so.
    return Promise.reject(
      new ExecutionFailed({
        cause: new Error("defineSession: abort() not configured"),
      }) satisfies SessionError,
    );
  }

  /**
   * A callback session has no compiler and no executor — it IS the callback —
   * so there is no tree to render and no request to prepare. Refusing loudly
   * beats returning an empty preview a caller would read as "nothing rendered".
   */
  dryRun(): Promise<never> {
    return Promise.reject(unsupportedPreview("dryRun"));
  }

  compile(): Promise<never> {
    return Promise.reject(unsupportedPreview("compile"));
  }

  project(): Promise<never> {
    return Promise.reject(unsupportedPreview("project"));
  }

  prepareRequest(): never {
    throw unsupportedPreview("prepareRequest");
  }

  async snapshot(): Promise<void> {
    await this.spec.snapshot?.();
  }

  restore(): Promise<void> {
    if (this.spec.restore) return this.spec.restore();
    return Promise.reject(
      new ExecutionFailed({
        cause: new Error("defineSession: restore() not configured"),
      }) satisfies SessionError,
    );
  }

  /**
   * The adopter's `close` runs as {@link teardown}, so a spec whose close
   * rejects still gets the substrate unwind (inbox detach, `onClose` LIFO)
   * that `BaseHarness.close` guarantees — and still surfaces its error.
   */
  protected override async teardown(): Promise<void> {
    if (this.spec.close) await this.spec.close();
  }

  // ──────── StateApplicator ────────

  applyExecutorResult(input: ApplyExecutorResultInput): Promise<ApplyResult> {
    return this.spec.applyExecutorResult(input);
  }

  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult> {
    return this.spec.applyToolResults(input);
  }

  appendEntry(input: AppendEntryInput): Promise<ApplyResult> {
    return this.spec.appendEntry(input);
  }

  // ──────── Extended surface ────────

  notifyLifecycle(input: NotifyTickEndInput): Promise<TickEndForwardDecision> {
    if (this.spec.notifyLifecycle) return this.spec.notifyLifecycle(input);
    return Promise.resolve(undefined);
  }

  spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>> {
    if (this.spec.spawn) return this.spec.spawn(input);
    return Promise.reject(
      new ExecutionFailed({
        cause: new Error("defineSession: spawn() not configured"),
      }) satisfies SessionError,
    );
  }

  /**
   * A callback session has no model layer of its own — the spec supplies one or
   * there is nothing to describe. `undefined` is the honest answer, and it is
   * the same one a model-less real session gives.
   */
  modelInfo(): ModelInfoResult | undefined {
    return this.spec.modelInfo?.();
  }

  fork(input?: ForkInput): Promise<SessionHarnessProtocol<P>> {
    if (this.spec.fork) return this.spec.fork(input);
    return Promise.reject(
      new ExecutionFailed({
        cause: new Error("defineSession: fork() not configured"),
      }) satisfies SessionError,
    );
  }

  get tools(): ToolsHandle {
    if (this.spec.tools) return this.spec.tools;
    throw new Error("defineSession: tools not configured");
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    if (this.spec.channel) return this.spec.channel<T>(name);
    throw new Error(`defineSession: channel("${name}") not configured`);
  }

  channelSnapshot(channel: string): Promise<EventEnvelope | undefined> {
    if (this.spec.channelSnapshot) return this.spec.channelSnapshot(channel);
    return Promise.resolve(undefined);
  }

  knob<T = unknown>(name: string): KnobHandle<T> {
    if (this.spec.knob) return this.spec.knob<T>(name);
    throw new Error(`defineSession: knob("${name}") not configured`);
  }

  /**
   * Single-slot escalation interceptor (ADR 69 T2a). Stored for
   * protocol conformance; consulted once this façade wires escalation
   * dispatch (`handleMessage` is currently unwired — FAÇADE MVP).
   */
  interceptEscalation(handler: EscalationInterceptor): Unsubscribe {
    this.escalationInterceptor = handler;
    return () => {
      if (this.escalationInterceptor === handler) {
        this.escalationInterceptor = undefined;
      }
    };
  }

  gate(name: string): GateHandle | undefined {
    return this.spec.gate?.(name) ?? this.gates.get(name);
  }

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error("defineSession inbox dispatch not yet wired (FAÇADE.6 MVP)"),
      }),
    );
  }
}

// ============================================================================
// No-op handle stubs
// ============================================================================

function noopTimelineHandle(): TimelineHandle {
  const unsubscribe = () => {};
  return {
    read: () => ({ entries: [], version: 0 }),
    readPersisted: () => [],
    executionCursor: () => undefined,
    trailingInput: () => [],
    inputEntryCount: () => 0,
    endTurn: async () => {},
    history: async () => [],
    subscribe: () => unsubscribe,
    append: async () => {},
    compact: async (strategy) => ({
      entriesBefore: 0,
      entriesAfter: 0,
      source: strategy?.source ?? "persisted",
    }),
  };
}

function noopKnobsHandle(): KnobsHandle {
  const unsubscribe = () => {};
  return {
    list: () => [],
    get: () => undefined,
    has: () => false,
    set: async () => {},
    dispatch: async () => [],
    subscribe: () => unsubscribe,
    subscribeAll: () => unsubscribe,
  };
}

function noopGatesHandle(): GatesHandle {
  const unsubscribe = () => {};
  return {
    register: () => {
      throw new Error(
        "defineSession: `gates` not configured — supply a GatesController via `gates` to register gates.",
      );
    },
    get: () => undefined,
    has: () => false,
    list: () => [],
    clear: () => Promise.resolve(),
    subscribe: () => unsubscribe,
    subscribeAll: () => unsubscribe,
  };
}

/**
 * The `model` slot for a session built without one. Reads DEGRADE, writes
 * COMPLAIN — the split the sibling no-op handles in this module follow.
 *
 * `current` answers `undefined` rather than throwing: `ModelSelectionHandle`
 * types it `RegisteredModel | undefined` precisely because a model-less session
 * is legal (the model is enforced at execution time), so
 * `if (session.model.current)` is the documented read and must not blow up.
 * `setModel` / `setTarget` have nowhere to write, which IS a configuration
 * error, so they keep rejecting.
 */
function noopModelHandle(): ModelSelectionHandle {
  const message =
    "defineSession: `model` not configured — supply a ModelSelectionHandle via `model`.";
  const unsubscribe = () => {};
  return {
    get current(): RegisteredModel | undefined {
      return undefined;
    },
    setModel: () => Promise.reject(new Error(message)),
    setTarget: () => Promise.reject(new Error(message)),
    use: () => unsubscribe,
    guard: () => unsubscribe,
  };
}

function noopStateHandle(): StateHandle {
  const unsubscribe = () => {};
  return {
    get: () => undefined,
    has: () => false,
    list: () => [],
    set: async () => {},
    delete: async () => {},
    subscribe: () => unsubscribe,
    subscribeAll: () => unsubscribe,
  };
}

function coerceSessionError(cause: unknown): SessionError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as SessionError;
  }
  return new ExecutionFailed({ cause });
}
