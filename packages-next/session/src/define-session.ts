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
 * Required callbacks: `send`, `snapshot`, and the state applicator
 * triple (`applyExecutorResult`/`applyToolResults`/`appendEntry`).
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
 *   snapshot() { ... },
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
  ulid,
} from "@agentick/runtime-next";
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
  RestoreSnapshotInput,
  SendInput,
  SessionError,
  SessionExecutionHandle,
  SessionHarnessFactory,
  SessionHarnessFactoryDeps,
  SessionHarnessProtocol,
  SessionSnapshot,
  ForkInput,
  SpawnInput,
  TickEndForwardDecision,
  Unsubscribe,
} from "@agentick/spec-next";
import type { KnobsHandle } from "@agentick/knobs-next";
import type { GateHandle, GatesHandle } from "@agentick/gates-next";
import type { StateHandle } from "@agentick/state-next";
import type { TimelineHandle } from "@agentick/timeline-next";
import { buildSessionElicit, ElicitationHarness } from "@agentick/elicitation-next";
import { TasksHarness } from "@agentick/tasks-next";
import { ResourcesHarness } from "@agentick/resources-next";
import type {
  Elicit,
  ElicitationHarnessProtocol,
  RegisteredModel,
  Resources,
  TasksHarnessProtocol,
} from "@agentick/spec-next";
import { ExecutionFailed, HandlerError } from "@agentick/spec-next";
import type { ModelSelectionHandle } from "./model-facade.js";

// ============================================================================
// Public API
// ============================================================================

export interface DefineSessionInput<P = unknown> {
  // ── Required: lifecycle + core verbs ─────────────────────────────────
  readonly send: (input: SendInput<P>) => Promise<SessionExecutionHandle>;
  readonly snapshot: () => SessionSnapshot | Promise<SessionSnapshot>;
  /**
   * Restore a previously captured snapshot. Optional — omit to get a
   * façade that rejects `restore()` with "not configured" (a callback
   * session that captures state but can't take it back).
   */
  readonly restore?: (input: RestoreSnapshotInput) => Promise<void>;
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
   * `SessionHarnessProtocol.model` slot (ADR 89 §2). Omit to get a no-op
   * stub whose `setModel` / `setTarget` reject and whose `current` throws
   * "not configured" — a callback session owns no model default. Supply a
   * real {@link ModelSelectionHandle} to expose model swap/interception.
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
    const scopeId = deps?.scopeId ?? `define-session:${ulid()}`;
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

class CallbackSessionHarness<P = unknown>
  extends BaseHarness<"session">
  implements SessionHarnessProtocol<P>
{
  get id(): string {
    return this.scopeId;
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
      opId: `session:send:${ulid()}`,
      surface: "session",
      name: "session:command:send",
      scope: { sessionId: this.scopeId },
      input,
    };
    // Same one-boundary cast as the reference harness: the pipeline is erased
    // to `unknown` data; the caller's `output` schema is the narrowing truth.
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.spec.send(i),
          catch: (cause): SessionError => coerceSessionError(cause),
        }),
      ),
    ) as Promise<SessionExecutionHandle<T>>;
  }

  async snapshot(): Promise<SessionSnapshot> {
    return this.spec.snapshot();
  }

  restore(input: RestoreSnapshotInput): Promise<void> {
    if (this.spec.restore) return this.spec.restore(input);
    return Promise.reject(
      new ExecutionFailed({
        cause: new Error("defineSession: restore() not configured"),
      }) satisfies SessionError,
    );
  }

  async close(): Promise<void> {
    if (this.spec.close) await this.spec.close();
    await super.close();
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
    trailingInput: () => [],
    inputEntryCount: () => 0,
    endTurn: async () => {},
    history: async () => [],
    subscribe: () => unsubscribe,
    append: async () => {},
    compact: async (strategy) => ({
      entriesBefore: 0,
      entriesAfter: 0,
      source: strategy.source ?? "persisted",
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

function noopModelHandle(): ModelSelectionHandle {
  const message =
    "defineSession: `model` not configured — supply a ModelSelectionHandle via `model`.";
  const unsubscribe = () => {};
  return {
    get current(): RegisteredModel {
      throw new Error(message);
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
