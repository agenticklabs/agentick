/**
 * `defineSession` — callback-style `SessionHarnessProtocol` factory.
 *
 * Lets a user satisfy `SessionHarnessProtocol` without subclassing
 * `BaseHarness`/`SessionHarness`. Useful for testing topologies, mocks,
 * and the rare case where session orchestration is fundamentally
 * different from the framework default.
 *
 * **Most adopters should subclass `SessionHarness`** — the session is
 * deeply integrated with reconciler/executor/loop/tool-executor wiring,
 * and the default impl handles a lot of plumbing. `defineSession` is
 * for the cases where that plumbing is the wrong fit.
 *
 * Required callbacks: `send`, `snapshot`, `close`, and the state
 * applicator triple (`applyExecutorResult`/`applyToolResults`/
 * `appendEntry`). Other methods default to throwing
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
} from "@agentick/runtime";
import type {
  AppendEntryInput,
  ApplyExecutorResultInput,
  ApplyResult,
  ApplyToolResultsInput,
  ChannelHandle,
  ContentBlock,
  EventBus,
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
  SessionHarnessFactory,
  SessionHarnessFactoryDeps,
  SessionHarnessProtocol,
  SessionSnapshot,
  SpawnInput,
  TickEndForwardDecision,
} from "@agentick/spec";
import type { KnobsHandle } from "@agentick/knobs";
import type { StateHandle } from "@agentick/state";
import type { TimelineHandle } from "@agentick/timeline";

// ============================================================================
// Public API
// ============================================================================

export interface DefineSessionInput<P = unknown> {
  // ── Required: lifecycle + core verbs ─────────────────────────────────
  readonly send: (input: SendInput<P>) => Promise<SessionExecutionHandle>;
  readonly snapshot: () => SessionSnapshot;
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
  readonly dispatch?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<readonly ContentBlock[]>;
  readonly channel?: <T = unknown>(name: string) => ChannelHandle<T>;
  readonly knob?: <T = unknown>(name: string) => KnobHandle<T>;

  // ── Optional: top-level handles (ADR 27 augmentations) ───────────────
  readonly timeline?: TimelineHandle;
  readonly knobs?: KnobsHandle;
  readonly state?: StateHandle;
}

export function defineSession<P = unknown>(
  spec: DefineSessionInput<P>,
): SessionHarnessFactory<P> {
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
  private readonly spec: DefineSessionInput<P>;
  readonly timeline: TimelineHandle;
  readonly knobs: KnobsHandle;
  readonly state: StateHandle;

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
    this.state = spec.state ?? noopStateHandle();
  }

  // ──────── SessionHarnessProtocol — core ────────

  send(input: SendInput<P>): Promise<SessionExecutionHandle> {
    const op: Operation<SendInput<P>, SessionExecutionHandle> = {
      opId: `session:send:${ulid()}`,
      surface: "session",
      name: "session:command:send",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.spec.send(i),
          catch: (cause): SessionError => coerceSessionError(cause),
        }),
      ),
    );
  }

  snapshot(): SessionSnapshot {
    return this.spec.snapshot();
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
    return Promise.reject({
      _tag: "ExecutionFailed",
      cause: new Error("defineSession: spawn() not configured"),
    } satisfies SessionError);
  }

  dispatch(name: string, input: Record<string, unknown>): Promise<readonly ContentBlock[]> {
    if (this.spec.dispatch) return this.spec.dispatch(name, input);
    return Promise.reject({
      _tag: "ExecutionFailed",
      cause: new Error("defineSession: dispatch() not configured"),
    } satisfies SessionError);
  }

  channel<T = unknown>(name: string): ChannelHandle<T> {
    if (this.spec.channel) return this.spec.channel<T>(name);
    throw new Error(`defineSession: channel("${name}") not configured`);
  }

  knob<T = unknown>(name: string): KnobHandle<T> {
    if (this.spec.knob) return this.spec.knob<T>(name);
    throw new Error(`defineSession: knob("${name}") not configured`);
  }

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("defineSession inbox dispatch not yet wired (FAÇADE.6 MVP)"),
    });
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
    readPending: () => [],
    subscribe: () => unsubscribe,
    append: async () => {},
    queue: async () => ({ ids: [] }),
    drain: async () => ({ entries: [] }),
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
  return { _tag: "ExecutionFailed", cause };
}
