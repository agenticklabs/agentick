/**
 * TasksHarness — substrate-level long-running tool primitive, refactored
 * to **record-as-source-of-truth** (ADR 68).
 *
 * The pivot (ADR 68): a task is no longer *primarily* an in-process fiber
 * with the record as a view. Inverted — a task is a persisted
 * {@link TaskRecord} state machine living in a {@link TaskStore}; **how it
 * runs** is a swappable {@link TaskExecutor} strategy behind the record.
 * The harness orchestrates:
 *
 *   - `submit` writes a `working` record to the store and starts an
 *     executor, handing it the ONE `report` callback.
 *   - The executor **reports transitions** ({@link TaskTransition}); the
 *     harness applies each to the record, `store.put`s the new record,
 *     AND emits the EXISTING `task-status` / `task-progress` bus events.
 *     **The bus stays the LIVE plane; the store is the DURABLE plane —
 *     the wire behavior is UNCHANGED.**
 *   - `get` / `list` / `status` read a synchronous **projection** the
 *     harness keeps in lockstep with its store writes (the protocol
 *     reads are sync; the store port is async — CQRS materialized view).
 *     The store is the durable authority (rebuilt into the projection on
 *     hydration); the projection is the live read-model.
 *
 * The bundled default executor is {@link InProcessTaskExecutor} — the
 * current Promise/Effect fiber model, refactored onto the report seam,
 * BEHAVIOR-IDENTICAL for the caller. The child-process executor (isolation
 * / detached) and a `@agentick/tasks-store-postgres` durable store conform
 * to the SAME seams later — not built here.
 *
 * Per-task fan-out is unchanged: a single `LocalPubSub<TaskEvent>` per
 * task carries status transitions AND progress in causal order;
 * `events(taskId)` synthesizes the initial snapshot then closes on the
 * terminal frame via `Stream.takeUntil`. The MCP wire codec integrates
 * exactly as before (listens on the bus channels).
 *
 * ## Lifetime (ADR 68)
 *
 * The {@link TaskStore} is APP/GATEWAY-scoped (the AppHarness constructs
 * one and injects it into every session's harness), so a `detached` task
 * survives its spawning session's `close()`: non-detached tasks are
 * aborted on close (today's behavior, IDENTICAL); detached tasks are left
 * running + persisted. On construction (hydration) any store record still
 * `working` with no reattachable executor is marked `interrupted` (honest
 * orphan accounting — a same-process no-op for the in-memory store, the
 * logic the durable store exercises across restart).
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 */

import { Effect, Stream } from "effect";
import {
  BaseHarness,
  type BaseHarnessOptions,
  type Middleware,
  ulid,
  SESSION_ESCALATION_MESSAGE_TYPE,
  ESCALATION_TIMEOUT_MS,
  SESSION_TASK_WAKE_MESSAGE_TYPE,
  TASK_WAKE_SOURCE,
  type EscalationEnvelopePayload,
  type EscalationHop,
  type SessionTaskWakePayload,
} from "@agentick/runtime";
import { createLocalPubSub, type LocalPubSub } from "@agentick/pubsub";
import { View } from "@agentick/store";
import { omitUndefined } from "@agentick/utils";
import type {
  ChannelSnapshotProvider,
  CollectionMutation,
  ContentBlock,
  ElicitFn,
  ElicitationResult,
  EventBus,
  EventScope,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ProgressUpdate,
  SendInput,
  TaskCreationInput,
  TaskElicitFactory,
  TaskEvent,
  TaskExecution,
  TaskExecutor,
  TaskExecutorHooks,
  TaskFailure,
  TaskHandle,
  TaskInfo,
  TaskRecord,
  TaskRejection,
  TaskReport,
  TaskStatus,
  TaskStore,
  TaskStoreQuery,
  TaskTransition,
  TaskWakeOutcome,
  TaskWakePolicy,
  TaskWork,
  TaskWorkContext,
  TaskWorkVerbs,
  TasksHarnessProtocol,
} from "@agentick/spec";
import {
  HandlerError,
  isTerminalTaskStatus,
  TaskHandlerRefRequiredError,
  UnknownTaskError,
  UnknownTaskExecutorError,
} from "@agentick/spec";

import {
  TASK_PROGRESS_CHANNEL,
  TASK_STATUS_CHANNEL,
  type TaskStatusSnapshotFrame,
} from "./channel.js";
import { InMemoryTaskStore } from "./store.js";
import { InProcessTaskExecutor } from "./executor.js";
import {
  TASKS_CANCEL_MESSAGE_TYPE,
  TASKS_GET_MESSAGE_TYPE,
  TASKS_RESULT_MESSAGE_TYPE,
  type TasksCancelInboxPayload,
  type TasksGetInboxPayload,
  type TasksResultInboxPayload,
  type TasksResultReply,
} from "./inbox-protocol.js";

// ============================================================================
// Live task — the in-process runtime handle for a record this harness owns
// ============================================================================

/**
 * The runtime companion to a {@link TaskRecord}: the live handles that do
 * NOT serialize (AbortController, per-task event bus, result Promise,
 * executor handle). `record` is the current serializable state — a strict
 * mirror of the last `store.put`; reassigned (new immutable object) on
 * every transition so the sync `get` / `list` projection stays current.
 */
interface LiveTask {
  record: TaskRecord;
  /**
   * Universal cancellation signal surfaced on {@link TaskWorkContext.signal}.
   * Aborted on `cancel()` / non-detached `close()`. The executor-specific
   * teardown (Effect `Fiber.interrupt`, child kill) runs alongside via
   * {@link TaskExecutor.cancel}.
   */
  readonly controller: AbortController;
  /**
   * Single fan-out channel — status + progress in causal order. The
   * `onPublish` hook mirrors each event onto the substrate channel.
   */
  readonly eventBus: LocalPubSub<TaskEvent>;
  /**
   * Resolves with the work's value on `completed`; rejects with a
   * {@link TaskRejection} on `failed` / `cancelled` / `interrupted`.
   */
  readonly resultDeferred: Deferred<unknown>;
  /** Executor handle (for cancel). `undefined` once terminal / for orphans. */
  execution: TaskExecution | undefined;
  /** ttl reaper timer (ADR 68) — set when the record has a `ttl`; cleared on terminal (`settle`). */
  ttlTimer?: ReturnType<typeof setTimeout>;
  /**
   * Resolved wake policy (TASK-WAKE seam) — `opts.wake ?? harness.defaultWake`,
   * held only when truthy (a `wake` FSM was armed). The callable form is run
   * at {@link fireWake} time (so a consumed wake never invokes it).
   */
  wakePolicy?: TaskWakePolicy;
  /**
   * Wake FSM:
   *   `"none"`     — no wake armed (no policy, or `false`).
   *   `"armed"`    — policy present, not yet fired or consumed. A deferred
   *                  fire may be scheduled ({@link wakeTimer}).
   *   `"consumed"` — an in-band read (get/status/result terminal) or a cancel
   *                  saw the outcome first → the wake will never fire.
   *   `"fired"`    — the wake was delivered (or suppressed by a `null`-
   *                  returning callable policy). One-shot; never re-arms.
   * Exactly-once holds because every transition off `"armed"` is a
   * single synchronous check-and-set on this field.
   */
  wakeState: "none" | "armed" | "consumed" | "fired";
  /** Deferred-fire handle — a one-turn grace window so a same-turn in-band read can consume. */
  wakeTimer?: ReturnType<typeof setImmediate>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// Options
// ============================================================================

/**
 * `extends BaseHarnessOptions` so every substrate slot the base accepts —
 * `parentScope`, `principal`, telemetry, metadata, the interceptor fold — arrives
 * without being re-declared here and re-forwarded by hand. Standing alone, this
 * interface silently dropped every base option a caller passed, and each one had to
 * be rediscovered the next time something needed it.
 */
export interface TasksHarnessOptions extends BaseHarnessOptions {
  /**
   * Scope stamped on every published task envelope AND on every
   * {@link TaskRecord} (the store's scope-filter key). Session-scoped
   * client subscriptions filter on `scope.sessionId`, so per-session
   * harnesses MUST pass `{ sessionId }`. Harnesses that share an
   * app-scoped {@link TaskStore} MUST pass a distinguishing scope so
   * hydration + `list` don't bleed across sessions.
   */
  /**
   * Durable backing for the task FSM (ADR 68). Defaults to a fresh
   * per-harness {@link InMemoryTaskStore}. The AppHarness constructs ONE
   * app-scoped store and injects it into every session's harness so
   * `detached` records survive session close.
   */
  readonly store?: TaskStore;
  /**
   * Execution strategies (ADR 68 Build B) — a registry keyed by each
   * executor's self-reported `.kind`. The bundled default
   * {@link InProcessTaskExecutor} is ALWAYS present; the provided list is
   * merged over it (a provided executor whose `.kind` is `"in-process"`
   * wins — one way, no back-compat shim). A submit selects per-task via
   * `opts.executorKind` (omitted → `"in-process"`); hydration / reattach
   * dispatch on `record.executorKind`.
   *
   * The typical wiring: the AppHarness constructs ONE app-scoped
   * `ChildProcessTaskExecutor` (its child map must outlive sessions for
   * detached-survives-close) and passes `[childExecutor]` here.
   */
  readonly executors?: readonly TaskExecutor[];
  /**
   * Elicit-sugar factory for task `ctx.elicit` (ADR 69). Injected so this
   * package stays free of `@agentick/elicitation` — pass its
   * `buildElicitSugar`. When supplied, a task's `ctx.elicit.*` escalates
   * the request to the owning session (`scope.sessionId`) via
   * `inbox.ask` and resolves with the client's response; when omitted,
   * `ctx.elicit` throws a "not configured" error on use (a bare harness
   * has no client to reach). `buildSessionBridges` wires this.
   *
   * @see docs/proposals/v2/blueprint/69-request-escalation.md
   */
  readonly buildElicit?: TaskElicitFactory;
  /**
   * Session-level default {@link TaskWakePolicy} (TASK-WAKE seam) — applied to
   * every submit that does NOT pass its own `wake`. `undefined` (default) =
   * no wake unless a task opts in per-submit. Set it (typically via the app's
   * `tasks.defaultWake`) to "wake the model on every backgrounded completion
   * by default" — codex-parity ergonomics — while per-task `wake: false` /
   * `() => null` still overrides/suppresses. The per-submit `wake` is the
   * primary seam; this is the overridable default (capability, not opinion —
   * default OFF because waking is intrusive, flippable app-wide).
   */
  readonly defaultWake?: TaskWakePolicy;
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * parent scope's resolved interceptors (guards, `.use` transforms, AND
   * declarative command hooks adapted to op-scoped middleware), folded in at
   * construction and forwarded to {@link BaseHarness} so ancestor-scope
   * interceptors wrap this harness's ops. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the AppHarness (this per-session
   * harness is constructed by the app). Keeps inheritance live so a LATER
   * `app.use()` / `app.guard()` / `app.hook()` reaches this harness's ops, not
   * just the construction snapshot. Forwarded to {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
}

// ============================================================================
// Harness
// ============================================================================

export class TasksHarness
  extends BaseHarness<"tasks">
  implements TasksHarnessProtocol, ChannelSnapshotProvider
{
  /**
   * In-process projection of the store, scoped to this harness's tasks — a
   * {@link View} in its AUGMENTED-FUSED configuration (cache value ≠ stored
   * record). The cache value is a {@link LiveTask} (`TCache`): the persisted
   * `TaskRecord` slice (`live.record`, a strict mirror of the last store write)
   * PLUS live-only runtime handles (AbortController, per-task event bus, result
   * deferred, executor handle, ttl timer) that are NEVER persisted. The store
   * holds only the `TaskRecord` (`TStore`); `project: (lt) => lt.record` strips
   * the handles on every {@link View.write}, so write-through persists the
   * record slice while the cache carries more.
   *
   * The record slice mirrors the store the way {@link View} prescribes:
   * write-through on every transition ({@link applyTransition} → `view.write`)
   * and cache-only adoption on resume ({@link adoptHydrated} → `view.seedSync`,
   * for records that CAME FROM the store — re-persisting them would be wrong).
   * Tasks does NOT use `view.subscribe`/`onChange`/`hydrate`: fan-out rides the
   * per-task `eventBus` (the DOMAIN event stream) and resume is bespoke
   * ({@link hydrateOrphans} — reattach/interrupt logic). Holding a `View` for
   * the cache + write-through is the conformance; the notify seams are opt-in.
   */
  private readonly view: View<LiveTask, TaskRecord, TaskStoreQuery, CollectionMutation<TaskRecord>>;
  /** `parentScope ?? {}` — stamped on records + used as the store filter. */
  private readonly scope: EventScope;
  private readonly store: TaskStore;
  /**
   * Executor registry keyed by `.kind` (ADR 68 Build B). Always contains
   * the bundled `"in-process"` default; provided executors merge over it.
   * `submit` resolves by `opts.executorKind`; hydration dispatches by
   * `record.executorKind`.
   */
  private readonly executors: Map<string, TaskExecutor>;
  /**
   * Injected {@link TaskElicitFactory} (ADR 69) — the elicit-sugar
   * builder for task `ctx.elicit`. Undefined on a bare harness (no
   * escalation); `ctx.elicit` then throws on use.
   */
  private readonly buildElicit: TaskElicitFactory | undefined;
  /** Session-level default wake policy (TASK-WAKE seam). `undefined` = no default. */
  private readonly defaultWake: TaskWakePolicy | undefined;
  /**
   * Set at the TOP of {@link close} (before the cancel cascade) so a terminal
   * transition driven BY close never schedules/fires a zombie wake. Distinct
   * from the per-task `wakeState` because a detached task (not cancelled on
   * close) could still settle after this flag flips.
   */
  private closing = false;

  /**
   * Resolves once hydration (orphan accounting, ADR 68) has run — chained
   * AFTER {@link BaseHarness.ready}. Impl-specific (not on the protocol);
   * tests + rehydration paths that must observe `interrupted` marking
   * await this. For a fresh session the store is empty → a no-op.
   */
  readonly hydrated: Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: TasksHarnessOptions = {},
  ) {
    super("tasks", scopeId, journal, bus, inbox, options);
    this.scope = this.parentScope ?? {};
    this.store = options.store ?? new InMemoryTaskStore();
    // Fused View over the store: cache = LiveTask (record + live handles),
    // store = TaskRecord. `project` strips the non-serializable handles on
    // every write; `keyOf` is the record's taskId. No `reconstruct` — resume
    // is bespoke (hydrateOrphans → seedSync), never `view.hydrate`.
    this.view = new View<LiveTask, TaskRecord, TaskStoreQuery, CollectionMutation<TaskRecord>>({
      store: this.store,
      keyOf: (lt) => lt.record.taskId,
      project: (lt) => lt.record,
      toPut: (r) => ({ put: r }),
      toDelete: (k) => ({ delete: k }),
    });
    // Registry = bundled default FIRST, provided list merged over it
    // (provided wins on `.kind` collision). Keyed by each executor's own
    // `.kind` — the adopter never writes a Record whose keys would just
    // duplicate `.kind`.
    this.executors = new Map<string, TaskExecutor>([["in-process", new InProcessTaskExecutor()]]);
    for (const executor of options.executors ?? []) {
      this.executors.set(executor.kind, executor);
    }
    this.buildElicit = options.buildElicit;
    this.defaultWake = options.defaultWake;
    // Hydration reads the store AFTER inbox registration. `ready` is a
    // readonly BaseHarness field (can't reassign), so this is a sibling
    // barrier. TODO(#134-followup): fold into `ready` if BaseHarness gains
    // a post-construction async hook.
    this.hydrated = this.ready.then(() => this.hydrateOrphans());
  }

  // ─────────── submit ───────────

  // NOTE(adr-83, hookability blocker — DELIBERATELY NOT wrapped in `runOperation`).
  // `submit` is the natural before/after hook point ("gate/transform a
  // submission" / "observe the accepted handle"), mirroring the just-landed
  // `sessionOp` (session) and `elicitOp` (elicitation) wrappers. It CANNOT be
  // wrapped behavior-preservingly, for a structural reason:
  //
  //   • `submit` returns `TaskHandle<T>` **synchronously** — callers (and the
  //     existing test suite) read `handle.taskId` / `handle.initialStatus`
  //     immediately, and the executor must `start` synchronously so signal
  //     listeners register before `submit` returns. The public overloads MUST
  //     keep returning `TaskHandle<T>` (not a Promise).
  //   • `runOperation`'s interceptor seam is intrinsically **async**: command
  //     hooks lift through `asBefore`/`asAfter` (both `async`) via
  //     `liftMiddleware` → `Effect.tryPromise`. So the moment ANY hook (or an
  //     inherited async interceptor) is registered for the op, the composed
  //     effect suspends on the microtask queue.
  //   • Extracting a synchronous result from that effect requires
  //     `Effect.runSyncExit`, which **dies** (`AsyncFiberException`) on any
  //     async boundary — verified empirically. So a `runSyncExit`-based submit
  //     would work ONLY with zero hooks registered (hollow) and would REGRESS
  //     (throw) under any inherited async interceptor — strictly worse than
  //     today, where `submit` never throws for interception reasons.
  //
  // Every existing `runOperation`-wrapped verb in the repo (session `send` /
  // `append` / `apply*`, elicitation `elicit`, tool `dispatch`, gateway/app
  // ops) is ASYNC (Promise/Effect surface). A synchronous command has no
  // precedent because the seam does not support one.
  //
  // UNBLOCKERS (either lands this cleanly; both are out of this task's scope —
  // one changes the public type, the other touches shared `@agentick/runtime` hook
  // semantics used by every harness, so both want explicit sign-off):
  //   1. Make `submit` async (`Promise<TaskHandle<T>>`). The ONLY way to host
  //      async before-hooks. Violates today's "public types unchanged"
  //      constraint + breaks synchronous `handle.taskId` reads.
  //   2. A synchronous-hook fast-path in `@agentick/runtime` (the
  //      `asBefore`/`asAfter` lift): keep a synchronous hook synchronous
  //      (`Effect.sync`), only going async when the hook returns a Promise. Lets
  //      `runSyncExit` host sync hooks; async submit hooks would still throw
  //      loudly (documented). Does NOT fix the async-inherited-interceptor
  //      regression, so it is necessary-but-insufficient on its own.
  //
  // The `settle`/`applyTransition` "after the task COMPLETES" hook (the more
  // useful reactive seam) is blocked by the SAME async-seam issue plus the sync
  // executor-callback path — see the NOTE at `applyTransition`.

  // Closure path (unchanged — inference-first so existing call sites are
  // untouched; PARITY).
  submit<T = readonly ContentBlock[]>(
    work: (ctx: TaskWorkContext) => Promise<T> | T,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;
  submit<T = readonly ContentBlock[], E = unknown>(
    work: (ctx: TaskWorkContext) => Effect.Effect<T, E, never>,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;
  // By-ref path (ADR 68 Build B) — no closure; a by-ref executor resolves
  // `handlerRef` on the far side. Both `handlerRef` + `executorKind`
  // mandatory in this form so the caller needn't pass a dummy closure.
  submit<T = readonly ContentBlock[]>(
    opts: TaskCreationInput & { readonly handlerRef: string; readonly executorKind: string },
  ): TaskHandle<T>;
  submit<T = readonly ContentBlock[]>(
    workOrOpts:
      | ((ctx: TaskWorkContext) => Promise<T> | T | Effect.Effect<T, unknown, never>)
      | (TaskCreationInput & { handlerRef: string; executorKind: string })
      | undefined,
    maybeOpts: TaskCreationInput = {},
  ): TaskHandle<T> {
    // Discriminate the two call forms: a function first arg is the closure
    // (opts is the 2nd arg); anything else (an opts object, or an explicit
    // `undefined` for `submit(undefined, opts)`) is the by-ref form.
    const work: TaskWork | undefined =
      typeof workOrOpts === "function" ? (workOrOpts as TaskWork) : undefined;
    const opts: TaskCreationInput =
      typeof workOrOpts === "function" ? maybeOpts : (workOrOpts ?? maybeOpts);

    // Resolve the executor by kind (default "in-process") — fail loud on
    // an unregistered kind (developer misuse, not a task outcome).
    const executorKind = opts.executorKind ?? "in-process";
    const executor = this.executors.get(executorKind);
    if (executor === undefined) {
      throw new UnknownTaskExecutorError({ kind: executorKind });
    }
    // By-ref validation: a by-ref executor ignores the closure and MUST
    // have a `handlerRef` to resolve work on the far side. The second
    // clause catches the runtime-only misuse of the by-ref overload with a
    // closure executor (no closure AND no ref → nothing to run) — the
    // typed overloads already forbid it, this is the honest runtime guard.
    if (opts.handlerRef === undefined && (executor.byRef === true || work === undefined)) {
      throw new TaskHandlerRefRequiredError({ kind: executorKind });
    }

    const taskId = `task:${ulid()}`;
    const now = Date.now();
    const record: TaskRecord = {
      taskId,
      status: "working",
      // Originating-session scope: per-submit override (a shared/app-scoped
      // harness stamps each task's owning session) else the harness scope.
      // The record is the source of truth (ADR 68) — escalation routes from it.
      scope: opts.scope ?? this.scope,
      executorKind: executor.kind,
      detached: opts.detached ?? false,
      // `ttl` (ms from creation) is enforced by the reaper below (`expireTask`
      // via an unref'd timer): a still-non-terminal task whose ttl elapses is
      // failed with `kind: "timeout"`. `null` = no expiry.
      ttl: opts.ttl ?? null,
      createdAt: now,
      updatedAt: now,
      ...omitUndefined({
        input: opts.input,
        handlerRef: opts.handlerRef,
        statusMessage: opts.statusMessage,
        pollInterval: opts.pollInterval,
      }),
    };
    // Resolve the wake policy (TASK-WAKE seam): per-submit `wake` wins;
    // omitted → the session-level `defaultWake`. `??` respects an explicit
    // `wake: false` (which overrides a truthy default → no wake). Arm the FSM
    // only when the resolved policy is truthy.
    const wakePolicy = opts.wake ?? this.defaultWake;
    const wakeArmed = wakePolicy !== undefined && wakePolicy !== false;
    const live: LiveTask = {
      record,
      controller: new AbortController(),
      // Fan-out + substrate fan-in in one primitive. Errors in onPublish
      // are isolated by the bus — a substrate emit failure CANNOT block
      // in-process subscribers.
      eventBus: createLocalPubSub<TaskEvent>({
        onPublish: (event) => this.fanOutToSubstrate(event),
      }),
      resultDeferred: makeDeferred<unknown>(),
      execution: undefined,
      wakeState: wakeArmed ? "armed" : "none",
      ...(wakeArmed ? { wakePolicy } : {}),
    };
    // Cache (LiveTask) + durable-write (projected record) the initial
    // `working` snapshot, then live-emit it BEFORE the executor starts (so
    // subscribers see `working` first).
    this.view.write(live, this.storeCtx());
    this.publishStatus(live);

    // Start the resolved executor. A closure executor invokes `work`
    // synchronously (so signal listeners register before submit returns);
    // a by-ref executor ignores `work` (undefined here) and resolves
    // `record.handlerRef` on the far side. Both drive the ONE `report`.
    // ADR 91 §2 — the branded trunk+facets live harness-side; hand the
    // executor a `deriveCtx` that composes its locally-built verbs OVER this
    // task's trunk (`record.scope` carries the owning `sessionId`) + this
    // harness's `log`/`trace`/`metrics`/`run` facets. The executor mints the
    // full `TaskWorkContext` from it; the work body reads `ctx.sessionId` and
    // can `ctx.log(...)`.
    const deriveCtx = (verbs: TaskWorkVerbs): TaskWorkContext =>
      this.deriveOperationCtx(record.scope, verbs);
    const execution = executor.start(
      record,
      work as TaskWork,
      this.makeReport(live),
      live.controller.signal,
      this.makeHooks(live),
      deriveCtx,
    );
    // Sync-completing work (e.g. `Effect.succeed`) may have already driven
    // the record terminal during `start` — don't stash a dead handle.
    live.execution = this.isTerminal(live.record.status) ? undefined : execution;

    // ttl reaper (ADR 68): a still-`working` task whose `ttl` elapses is
    // failed with `kind: "timeout"`. `unref`'d so it never holds the event
    // loop open; cleared on any terminal (`settle`).
    if (record.ttl !== null && !this.isTerminal(live.record.status)) {
      live.ttlTimer = setTimeout(() => this.expireTask(live), record.ttl);
      live.ttlTimer.unref?.();
    }

    return this.makeHandle<T>(live);
  }

  /**
   * ttl reaper (ADR 68): the task's `ttl` elapsed while still non-terminal —
   * mark it `failed { kind: "timeout" }` and tear down the executor. A
   * post-terminal call is a no-op (`applyTransition` ignores it); `settle`
   * has already cleared the timer, so this only runs for a live, elapsed task.
   */
  private expireTask(live: LiveTask): void {
    if (this.isTerminal(live.record.status)) return;
    this.applyTransition(live, {
      status: "failed",
      failure: { kind: "timeout", reason: "ttl elapsed" },
    });
    live.controller.abort("ttl_timeout");
    if (live.execution !== undefined) {
      const execution = live.execution;
      live.execution = undefined;
      void this.executors.get(live.record.executorKind)?.cancel(execution, "ttl_timeout");
    }
  }

  /** The ONE uniform transition path from an executor back to the harness. */
  private makeReport(live: LiveTask): TaskReport {
    return (transition) => this.applyTransition(live, transition);
  }

  /**
   * Per-task escalation wiring handed to the executor's ctx-build (ADR
   * 69). `escalate` is the raw up-chain `inbox.ask` bound to THIS task's
   * signal (so an origin cancel / ttl interrupts the ask fiber via
   * `Effect.runPromise({ signal })`); `buildElicit` is the injected sugar
   * factory. The executor composes them into `ctx.elicit`; when
   * `buildElicit` is absent, `ctx.elicit` is a throwing stub and
   * `escalate` is never invoked.
   */
  private makeHooks(live: LiveTask): TaskExecutorHooks {
    return {
      escalate: this.makeEscalate(live.controller.signal, live.record),
      ...(this.buildElicit !== undefined ? { buildElicit: this.buildElicit } : {}),
    };
  }

  /**
   * Build the escalation {@link ElicitFn} for a task: `ask` the owning
   * session (`session:{scope.sessionId}`) with a payload-agnostic
   * escalation envelope (ADR 69), tagged `class: "elicit"`. The handler's
   * return value threads the client's {@link ElicitationResult} back —
   * the `ask` return stack IS the reply route (no envelope-forwarding
   * machinery). A long timeout (not the 30s `ask` default) governs a
   * human-in-the-loop wait; the task's `signal` (cancel / ttl / close)
   * interrupts the ask fiber early.
   *
   * Multi-session fan-in (app-scoped harness): the origin session is read
   * from the RECORD (`record.scope.sessionId`), not `this.scope`. So ONE
   * harness serving many sessions escalates each task's `ctx.elicit` to
   * that task's own owning session — the record is the source of truth
   * (ADR 68). A per-session harness stamps `record.scope = this.scope`, so
   * the two coincide there.
   */
  private makeEscalate(signal: AbortSignal, record: TaskRecord): ElicitFn {
    const inbox = this.inbox;
    const { taskId } = record;
    const sessionId = record.scope.sessionId;
    const principal = this.principal;
    return (request) => {
      if (sessionId === undefined) {
        throw new Error(
          "cannot escalate task elicit: the task's record has no owning session (scope.sessionId). Escalation requires a session-scoped task (ADR 69).",
        );
      }
      // Origin lineage stamp (ADR 69 §Provenance): the escalation starts
      // at THIS task in its owning session. Each forwarding session hop
      // appends its own entry (session/harness.ts). `principal` is
      // best-effort (ADR 51) — stamped when the harness has one in scope.
      const origin: EscalationHop = {
        scopeId: `session:${sessionId}`,
        taskId,
        ...(principal !== undefined ? { principal } : {}),
      };
      const payload: EscalationEnvelopePayload = {
        class: "elicit",
        request,
        lineage: [origin],
      };
      const ask = inbox.ask<EscalationEnvelopePayload, ElicitationResult>(
        `session:${sessionId}`,
        { type: SESSION_ESCALATION_MESSAGE_TYPE, payload },
        { timeoutMs: ESCALATION_TIMEOUT_MS },
      );
      return Effect.runPromise(ask, { signal });
    };
  }

  /**
   * Apply an executor-reported transition: mutate the projection record,
   * persist to the store, emit the matching bus event, and settle the
   * result deferred on a terminal. Post-terminal reports are ignored —
   * this is what preserves "caller cancel wins the race" against a work
   * fn that resolves/rejects after cancel.
   */
  // NOTE(adr-83, `onAfterTasksSettle` deferred — the terminal transition is
  // NOT wrapped in `runOperation`). The useful "react when the task actually
  // completes" hook lives here (the terminal `settle`), decoupled from the
  // `submit`-accept seam. It is deferred for TWO compounding reasons:
  //   • `applyTransition` / `settle` are SYNCHRONOUS `void` methods invoked
  //     from the executor's report callback (`makeReport`) and the ttl reaper /
  //     cancel paths. `runOperation` is async (Effect); wrapping the terminal
  //     transition would force this callback path async, risking the FSM
  //     ordering + "cancel wins the race" post-terminal-no-op invariant that
  //     the harness tests pin (ttl-reaper, cancel, post-terminal-no-op,
  //     orphan hydration). The task brief explicitly says: do NOT force
  //     sync→async on the callback path.
  //   • Even ignoring the callback path, the interceptor seam is async (see the
  //     NOTE at `submit`), so the same runSyncExit-dies-on-any-hook problem
  //     applies.
  // Unblock: make the FSM transition path async (a follow-up that reworks
  // `makeReport` + the ttl/cancel callers to compose an Effect), OR add a
  // dedicated task-lifecycle event seam that fires the terminal hook off the
  // durable record without touching the transition ordering.
  private applyTransition(live: LiveTask, t: TaskTransition): void {
    const record = live.record;
    if (this.isTerminal(record.status)) return;
    const now = Date.now();

    // Progress-only — the `onProgress` seam. Status unchanged.
    if (t.progress !== undefined && t.status === undefined && t.statusMessage === undefined) {
      const p = t.progress;
      live.record = {
        ...record,
        updatedAt: now,
        progress: {
          progress: p.current,
          ...omitUndefined({ total: p.total, message: p.message }),
        },
      };
      this.view.write(live, this.storeCtx());
      this.publishProgress(live, p);
      return;
    }

    // Status-message-only — the `setStatusMessage` seam. Still `working`.
    if (t.statusMessage !== undefined && t.status === undefined) {
      live.record = { ...record, updatedAt: now, statusMessage: t.statusMessage };
      this.view.write(live, this.storeCtx());
      this.publishStatus(live);
      return;
    }

    // Status transition (possibly terminal).
    if (t.status !== undefined) {
      live.record = {
        ...record,
        status: t.status,
        updatedAt: now,
        ...(t.failure !== undefined ? { failure: t.failure } : {}),
        ...(t.statusMessage !== undefined ? { statusMessage: t.statusMessage } : {}),
        ...(t.result !== undefined ? { result: t.result } : {}),
      };
      this.view.write(live, this.storeCtx());
      this.publishStatus(live);
      if (this.isTerminal(live.record.status)) this.settle(live);
    }
  }

  /**
   * Disarm the ttl reaper for one task (ADR 68). The invariant it enforces: a
   * task this harness has stopped serving — terminal, or abandoned at close —
   * holds NO timer that could later fire `expireTask` and drive a transition
   * through the (possibly closed) harness's write-through into the app-scoped
   * store. Idempotent.
   */
  private clearTtl(live: LiveTask): void {
    if (live.ttlTimer === undefined) return;
    clearTimeout(live.ttlTimer);
    live.ttlTimer = undefined;
  }

  /** Resolve / reject the result deferred from the (now terminal) record. */
  private settle(live: LiveTask): void {
    // Terminal — cancel any pending ttl reaper (ADR 68).
    this.clearTtl(live);
    const { record, resultDeferred } = live;
    if (record.status === "completed") {
      resultDeferred.resolve(record.result);
    } else {
      resultDeferred.reject(
        this.rejectionOf(
          record.taskId,
          record.status as "failed" | "cancelled" | "interrupted",
          record.failure,
        ),
      );
    }
    // TASK-WAKE: an unobserved terminal transition schedules exactly one wake.
    // Deferred one turn (see scheduleWake) so a same-turn in-band read can
    // still consume it; suppressed if already observed / cancelled / closing.
    this.scheduleWake(live);
  }

  // ─────────── task-completion wake (TASK-WAKE seam) ───────────

  /**
   * In-band observation (consume-on-observe). Called from the in-band read
   * points — `get`/`status` returning a terminal snapshot, `result(taskId)`
   * at invocation, and the cancel paths. Flips an ARMED wake to CONSUMED and
   * cancels any pending deferred fire. A no-op once the wake has fired
   * (one-shot) or was never armed.
   *
   * This single synchronous check-and-set IS the read-side of exactly-once:
   * whether an observation or the deferred fire runs first, exactly one of
   * {consumed, fired} results.
   */
  private markObserved(live: LiveTask): void {
    if (live.wakeState !== "armed") return;
    live.wakeState = "consumed";
    if (live.wakeTimer !== undefined) {
      clearImmediate(live.wakeTimer);
      live.wakeTimer = undefined;
    }
  }

  /**
   * Schedule the deferred wake fire (from `settle`). No-op if the wake was
   * already consumed (a pre-settle `result`/cancel observation) or the harness
   * is closing. Otherwise arm a ONE-TURN deferral (`setImmediate`) — the grace
   * window in which a same-turn synchronous in-band read (a `get`/`status`
   * right after the terminal transition) can still consume the wake before it
   * fires. When the turn elapses unobserved, {@link fireWake} runs.
   */
  private scheduleWake(live: LiveTask): void {
    if (live.wakeState !== "armed") return; // consumed pre-settle, or no wake
    if (this.closing) {
      live.wakeState = "consumed"; // a close-driven terminal never wakes
      return;
    }
    live.wakeTimer = setImmediate(() => {
      live.wakeTimer = undefined;
      this.fireWake(live);
    });
  }

  /**
   * Fire the wake (deferred, unobserved path). Guards `wakeState === "armed"`
   * (a read may have consumed it during the deferral); one-shot → `"fired"`.
   * Runs the resolved policy against the bounded outcome: `true` → the default
   * bounded-metadata send; a callable → its shaped `SendInput` (or `null` to
   * suppress). Delivers via a fire-and-forget `inbox.send` to the owning
   * session (`session:{sessionId}`), which turns it into a real, journaled
   * execution. An evicted/closed session has no registered inbox address, so
   * the send fails `AddressNotFound` and the wake is dropped — the completion
   * stays observable via the durable task store (the eviction decision).
   */
  private fireWake(live: LiveTask): void {
    if (live.wakeState !== "armed") return;
    live.wakeState = "fired";
    const policy = live.wakePolicy;
    if (policy === undefined) return; // defensive — armed implies a policy

    const sessionId = live.record.scope.sessionId;
    if (sessionId === undefined) return; // no session to wake (bare harness)

    const outcome = this.wakeOutcome(live.record);
    // `armed` only ever stores `true` or a function (never `false`); the
    // `typeof` check narrows the union and treats `true` as the default.
    const send = typeof policy === "function" ? policy(outcome) : buildDefaultWakeSend(outcome);
    if (send === null) return; // callable form suppressed this wake

    const payload: SessionTaskWakePayload = { taskId: live.record.taskId, outcome, send };
    // Fire-and-forget (tell). Swallow AddressNotFound / inbox-closed — a wake
    // TODO(task-wake): narrow this catch — today it swallows ALL errors, not
    // just the benign address-gone class; a real delivery bug is invisible.
    // to an evicted or torn-down session is a benign drop, not an error.
    void Effect.runPromise(
      this.inbox.send(`session:${sessionId}`, {
        type: SESSION_TASK_WAKE_MESSAGE_TYPE,
        payload,
      }),
    ).catch(() => undefined);
  }

  /** Bounded terminal metadata for a wake — identity + outcome, NEVER raw output. */
  private wakeOutcome(record: TaskRecord): TaskWakeOutcome {
    return {
      taskId: record.taskId,
      status: record.status,
      durationMs: record.updatedAt - record.createdAt,
      ...omitUndefined({ statusMessage: record.statusMessage, failure: record.failure }),
    };
  }

  // ─────────── lookups (served from the projection — the store read-model) ───────────

  get(taskId: string): TaskInfo | undefined {
    const live = this.view.getSync(taskId);
    if (!live) return undefined;
    // In-band observation point (TASK-WAKE): a `get` that returns a TERMINAL
    // snapshot means the model saw the outcome in-band → consume the wake.
    // A `get` on a still-`working` task observes no outcome (polling) and
    // does NOT consume.
    if (this.isTerminal(live.record.status)) this.markObserved(live);
    return this.snapshot(live.record);
  }

  list(): readonly TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const live of this.view.listSync()) out.push(this.snapshot(live.record));
    return out;
  }

  status(taskId: string): TaskStatus | undefined {
    const live = this.view.getSync(taskId);
    if (!live) return undefined;
    // Same in-band observation semantics as `get` — a terminal read consumes.
    if (this.isTerminal(live.record.status)) this.markObserved(live);
    return live.record.status;
  }

  async result<T = readonly ContentBlock[]>(taskId: string): Promise<T> {
    const live = this.view.getSync(taskId);
    if (!live) {
      throw new UnknownTaskError({ taskId });
    }
    // In-band observation point (TASK-WAKE): an awaiter (the model via
    // `task_await`) is committed to delivering the outcome in-band,
    // so consume the wake AT INVOCATION — this pre-empts the terminal
    // transition, so a `result(taskId)` issued while the task is still
    // `working` suppresses the wake before `settle` can schedule it.
    this.markObserved(live);
    return (await live.resultDeferred.promise) as T;
  }

  // ─────────── cancel ───────────

  async cancel(taskId: string, reason?: string): Promise<void> {
    const live = this.view.getSync(taskId);
    if (!live) {
      throw new UnknownTaskError({ taskId });
    }
    if (this.isTerminal(live.record.status)) return; // idempotent
    await this.cancelInternal(live, reason ?? "cancelled");
  }

  /**
   * Internal cancel — used by `cancel()` and by the `close()` cascade.
   * Applies the `cancelled` transition FIRST (persist + reject deferred +
   * emit) so the caller's reason wins over any executor-reported
   * interrupt reason (which becomes a no-op post-terminal), then aborts
   * the AbortController and triggers executor-specific teardown. `await`s
   * the executor's cancel Promise when it returns one (the interruptible-
   * fiber settled-cancel guarantee) — the Promise path returns void, so
   * this returns immediately, exactly as before.
   */
  private async cancelInternal(live: LiveTask, reason: string): Promise<void> {
    // The canceller (model `task_cancel`, ttl reaper, or the close
    // cascade) is already aware of the outcome — consume the wake BEFORE the
    // terminal transition so a cancelled task never wakes.
    this.markObserved(live);
    this.applyTransition(live, { status: "cancelled", failure: { kind: "aborted", reason } });
    live.controller.abort(reason);
    if (live.execution !== undefined) {
      const execution = live.execution;
      live.execution = undefined;
      // Dispatch teardown to the executor that ran this record.
      await this.executors.get(live.record.executorKind)?.cancel(execution, reason);
    }
  }

  // ─────────── events ───────────

  events(taskId: string): AsyncIterable<TaskEvent> {
    const live = this.view.getSync(taskId);
    if (!live) {
      throw new UnknownTaskError({ taskId });
    }
    return this.subscribeToTask(live);
  }

  // ─────────── close ───────────

  protected override async teardown(): Promise<void> {
    // TASK-WAKE: latch `closing` BEFORE the cancel cascade so a terminal
    // transition driven by close never schedules a wake, and cancel any
    // deferred wake already in flight — no zombie sends after close.
    this.closing = true;
    for (const live of this.view.listSync()) {
      if (live.wakeTimer !== undefined) {
        clearImmediate(live.wakeTimer);
        live.wakeTimer = undefined;
      }
      if (live.wakeState === "armed") live.wakeState = "consumed";
    }
    // Abort non-detached in-flight tasks BEFORE the inbox teardown so
    // subscribers see the terminal state through the normal failure path.
    // DETACHED tasks are left running + persisted (ADR 68) — the shared
    // app-scoped store keeps their records; their executor keeps running.
    const pending: Array<Promise<void>> = [];
    for (const live of this.view.listSync()) {
      if (this.isTerminal(live.record.status)) continue;
      if (live.record.detached) continue;
      pending.push(this.cancelInternal(live, "harness_closed"));
    }
    // `allSettled`, not `all`: the cancel cascade reaches an ADOPTER-supplied
    // `TaskExecutor.cancel` (a dead child process, an EPIPE on the IPC channel)
    // and one rejection there must not skip the reaper sweep below, nor the
    // inbox detach `BaseHarness.close` runs after this. Failures are collected
    // and re-thrown at the end — isolated, not swallowed.
    const failures: unknown[] = [];
    for (const outcome of await Promise.allSettled(pending)) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    // Drain event buses AND disarm ttl reapers — EXCEPT for still-running
    // DETACHED tasks, which keep emitting and keep their deadline after this
    // harness closes (ADR 68: they outlive the session, so the ttl that bounds
    // them has to outlive it too — dropping the timer here would hand a
    // detached task an unbounded lifetime, which is a worse leak than the timer
    // it replaces). Every OTHER task was just driven terminal by the cancel
    // cascade above, so `settle` already cleared its timer; the sweep makes the
    // invariant explicit and covers a task that reached terminal by a path that
    // did not go through `settle`.
    for (const live of this.view.listSync()) {
      if (live.record.detached && !this.isTerminal(live.record.status)) continue;
      this.clearTtl(live);
      try {
        await live.eventBus.close();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "tasks harness teardown failed");
  }

  // ─────────── inbox ───────────

  /**
   * Inbox dispatch:
   *
   *   - `request-response`  → auto-intercepted by `BaseHarness`.
   *   - `tasks-cancel`      → cancel-by-id; no reply. Idempotent.
   *   - `tasks-get`         → snapshot lookup; reply via `request-response`.
   *   - `tasks-result`      → await terminal; reply via `request-response`.
   *   - Anything else       → routing bug; fail loud.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    switch (msg.type) {
      case TASKS_CANCEL_MESSAGE_TYPE:
        return this.handleCancelInbox(msg as MessageEnvelope<TasksCancelInboxPayload>);
      case TASKS_GET_MESSAGE_TYPE:
        return this.handleGetInbox(msg as MessageEnvelope<TasksGetInboxPayload>);
      case TASKS_RESULT_MESSAGE_TYPE:
        return this.handleResultInbox(msg as MessageEnvelope<TasksResultInboxPayload>);
      default:
        return Effect.fail(
          new HandlerError({ cause: `Unknown tasks message type: ${String(msg.type)}` }),
        );
    }
  }

  private handleCancelInbox(
    msg: MessageEnvelope<TasksCancelInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        if (msg.payload === undefined) return undefined;
        const { taskId, reason } = msg.payload;
        const live = this.view.getSync(taskId);
        if (!live || this.isTerminal(live.record.status)) return undefined;
        await this.cancelInternal(live, reason ?? "remote_cancel");
        return undefined;
      },
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
    });
  }

  private handleGetInbox(
    msg: MessageEnvelope<TasksGetInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        if (msg.payload === undefined) return undefined;
        const { taskId, replyTo, correlationId } = msg.payload;
        const info = this.get(taskId); // undefined for unknown id
        await Effect.runPromise(
          this.inbox.send(replyTo, {
            type: "request-response",
            correlationId,
            payload: { correlationId, response: info },
          }),
        );
        return undefined;
      },
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
    });
  }

  private handleResultInbox(
    msg: MessageEnvelope<TasksResultInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        if (msg.payload === undefined) return undefined;
        const { taskId, replyTo, correlationId } = msg.payload;
        const live = this.view.getSync(taskId);
        let reply: TasksResultReply<unknown>;
        if (!live) {
          reply = {
            kind: "rejection",
            rejection: {
              _tag: "TaskRejection",
              taskId,
              status: "failed",
              failure: { kind: "error", reason: "UnknownTaskError" },
            },
          };
        } else {
          try {
            const value = await live.resultDeferred.promise;
            reply = { kind: "value", value };
          } catch (caught) {
            reply = { kind: "rejection", rejection: caught as TaskRejection };
          }
        }
        await Effect.runPromise(
          this.inbox.send(replyTo, {
            type: "request-response",
            correlationId,
            payload: { correlationId, response: reply },
          }),
        );
        return undefined;
      },
      catch: (cause): MessageHandlerError => new HandlerError({ cause }),
    });
  }

  // ─────────── diagnostics ───────────

  /**
   * NOT on the protocol — tests use it to assert in-flight counts;
   * production callers MUST NOT depend on this for control flow.
   */
  pendingCount(): number {
    let count = 0;
    for (const live of this.view.listSync()) {
      if (!this.isTerminal(live.record.status)) count++;
    }
    return count;
  }

  // ─────────── internals ───────────

  private isTerminal(status: TaskStatus): boolean {
    return isTerminalTaskStatus(status);
  }

  private snapshot(record: TaskRecord): TaskInfo {
    return {
      taskId: record.taskId,
      status: record.status,
      createdAt: record.createdAt,
      lastUpdatedAt: record.updatedAt,
      ttl: record.ttl,
      ...omitUndefined({
        statusMessage: record.statusMessage,
        pollInterval: record.pollInterval,
        failure: record.failure,
      }),
    };
  }

  private rejectionOf(
    taskId: string,
    status: "failed" | "cancelled" | "interrupted",
    failure: TaskFailure | undefined,
  ): TaskRejection {
    return {
      _tag: "TaskRejection",
      taskId,
      status,
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  // Durable write-through is the View's job now ({@link view}.write): cache the
  // LiveTask, fire-and-forget the projected record to the store off the
  // critical path (a store failure MUST NOT crash the harness — View swallows
  // it). TODO(#134-followup): a durable store (pg) wants a flush barrier +
  // typed write-failed surfacing; the in-memory default resolves synchronously
  // so there's nothing to await today.

  // ─────────── Status channel snapshot (ADR 87 / K8s watch-list) ───────────

  /**
   * The channel this harness snapshots — {@link ChannelSnapshotProvider}. The
   * session scans its bridges for this and, on `sub/subscribe`, prepends
   * {@link channelSnapshotPayload} as the opening frame a fresh `task-status`
   * subscriber receives before any live delta.
   */
  readonly snapshotChannel = TASK_STATUS_CHANNEL;

  /**
   * {@link ChannelSnapshotProvider} — the current task set as the channel's
   * opening frame, so a late/reconnecting subscriber renders the existing list
   * rather than only tasks that transition after it joined. Discriminated
   * (`kind: "snapshot"`) from the bare-`TaskInfo` live deltas. An observation:
   * reads the live projection, publishes nothing.
   */
  channelSnapshotPayload(): TaskStatusSnapshotFrame {
    return { kind: "snapshot", tasks: this.list() };
  }

  private publishStatus(live: LiveTask): void {
    live.eventBus.publish({ kind: "status", info: this.snapshot(live.record) });
  }

  private publishProgress(live: LiveTask, update: ProgressUpdate): void {
    live.eventBus.publish({
      kind: "progress",
      taskId: live.record.taskId,
      current: update.current,
      ...omitUndefined({ total: update.total, message: update.message }),
    });
  }

  /**
   * Substrate fan-in hook — runs synchronously on every event a task's
   * eventBus publishes. Translates each `TaskEvent` to its canonical
   * substrate channel envelope. UNCHANGED from the pre-ADR-68 impl — the
   * wire payloads are byte-identical.
   */
  private fanOutToSubstrate(event: TaskEvent): void {
    if (event.kind === "status") {
      void Effect.runPromise(this.publishOnChannel(TASK_STATUS_CHANNEL, event.info)).catch(
        () => undefined,
      );
      return;
    }
    void Effect.runPromise(
      this.publishOnChannel(TASK_PROGRESS_CHANNEL, {
        taskId: event.taskId,
        current: event.current,
        ...omitUndefined({ total: event.total, message: event.message }),
      }),
    ).catch(() => undefined);
  }

  private publishOnChannel(channel: string, payload: unknown): Effect.Effect<void, unknown, never> {
    return this.bus.append({
      id: ulid(),
      surface: "session",
      name: `session:channel:${channel}`,
      phase: "delta",
      timestamp: Date.now(),
      scope: this.parentScope ?? {},
      payload,
    } as Parameters<typeof this.bus.append>[0]);
  }

  private makeHandle<T>(live: LiveTask): TaskHandle<T> {
    const handle: TaskHandle<T> = {
      taskId: live.record.taskId,
      initialStatus: live.record.status,
      result: live.resultDeferred.promise as Promise<T>,
      info: () => this.snapshot(live.record),
      events: () => this.subscribeToTask(live),
      cancel: (reason?: string) => this.cancel(live.record.taskId, reason),
    };
    return handle;
  }

  /**
   * Subscribe to a task's event stream — synthesize the initial snapshot
   * (`Stream.make`) then live frames (`eventBus.subscribe()`), closing on
   * the first terminal status frame (`Stream.takeUntil`, inclusive).
   * Single-bus ordering preserved (no `Stream.merge` fairness drops).
   */
  private subscribeToTask(live: LiveTask): AsyncIterable<TaskEvent> {
    const initial: TaskEvent = { kind: "status", info: this.snapshot(live.record) };
    const stream = Stream.concat(Stream.make(initial), live.eventBus.subscribe()).pipe(
      Stream.takeUntil((event) => event.kind === "status" && this.isTerminal(event.info.status)),
    );
    return Stream.toAsyncIterable(stream);
  }

  /**
   * Hydration (ADR 68 orphan accounting). On construction, read this
   * harness's scope-filtered records from the store. Any still-`working`
   * record with no reattachable executor is marked `interrupted` (a lost
   * in-process fiber can't reattach — `executor.reattach` returns
   * `undefined`). Terminal records from a prior run are surfaced read-only
   * in the projection. For a fresh session the store is empty → no-op.
   */
  private async hydrateOrphans(): Promise<void> {
    const records = await this.store.list({ scope: this.scope }, this.storeCtx());
    for (const record of records) {
      if (this.view.hasSync(record.taskId)) continue; // this harness owns it live
      if (record.status !== "working" && record.status !== "input_required") {
        this.adoptHydrated(record); // terminal from a prior run
        continue;
      }
      // Dispatch reattach to the executor named on the record. An
      // in-process executor can't reattach; a record whose `executorKind`
      // isn't loaded in THIS app's registry resolves to `undefined`
      // (honest — the strategy that ran it isn't here) → interrupted.
      const reattached = this.executors
        .get(record.executorKind)
        ?.reattach?.(record, this.makeReportFor(record.taskId));
      if (reattached !== undefined) {
        const live = this.adoptHydrated(record);
        live.execution = reattached;
        continue;
      }
      const interrupted: TaskRecord = {
        ...record,
        status: "interrupted",
        failure: { kind: "aborted", reason: "interrupted" },
        updatedAt: Date.now(),
      };
      const live = this.adoptHydrated(interrupted);
      // The record was MUTATED (marked interrupted) — persist the mutation via
      // write-through. `adoptHydrated` only SEEDS the cache (adopting a store
      // record as-is); this branch changed it, so it must round-trip.
      this.view.write(live, this.storeCtx());
      this.publishStatus(live); // record-source-of-truth: every transition emits
    }
  }

  /** Report path bound to a taskId that will be adopted into the projection. */
  private makeReportFor(taskId: string): TaskReport {
    return (transition) => {
      const live = this.view.getSync(taskId);
      if (live) this.applyTransition(live, transition);
    };
  }

  /**
   * Bring a store record into the projection (hydration). Builds the live
   * companion with a pre-settled result deferred for terminal records so
   * `result(taskId)` resolves/rejects honestly.
   */
  private adoptHydrated(record: TaskRecord): LiveTask {
    const resultDeferred = makeDeferred<unknown>();
    if (record.status === "completed") {
      resultDeferred.resolve(record.result);
    } else if (record.status !== "working" && record.status !== "input_required") {
      resultDeferred.reject(
        this.rejectionOf(
          record.taskId,
          record.status as "failed" | "cancelled" | "interrupted",
          record.failure,
        ),
      );
    }
    // Avoid an unhandled-rejection warning for the pre-settled reject —
    // a real `result(taskId)` caller still observes the rejection.
    void resultDeferred.promise.catch(() => undefined);
    const live: LiveTask = {
      record,
      controller: new AbortController(),
      eventBus: createLocalPubSub<TaskEvent>({
        onPublish: (event) => this.fanOutToSubstrate(event),
      }),
      resultDeferred,
      execution: undefined,
      // A wake policy is runtime-local (never persisted) — a hydrated orphan
      // carries none, so an `interrupted`-on-hydration transition never wakes.
      wakeState: "none",
    };
    // Cache-only adopt: this record CAME FROM the store (hydration/resume), so
    // re-persisting it would be wrong. `seedSync` sets the cache without a
    // store write or a change emit. A branch that MUTATES the record (e.g.
    // marking it interrupted) follows this with `view.write` to round-trip.
    this.view.seedSync(live);
    return live;
  }
}

/**
 * The default `wake: true` send — a bounded-metadata user-role message that
 * names the task, its terminal status + duration, and points the model at the
 * `task_*` tools to fetch the actual output. **NO raw output.** Role
 * `"user"` so the send drives a model turn (an `"event"`-role message would
 * not reach the model); the `source: TASK_WAKE_SOURCE` metadata (stamped
 * authoritatively by the session too) attributes it as a system-generated
 * wake rather than a real user turn.
 */
function buildDefaultWakeSend(outcome: TaskWakeOutcome): SendInput {
  const summary =
    outcome.status === "completed"
      ? "completed successfully"
      : outcome.status === "failed"
        ? `failed${outcome.failure?.reason ? `: ${outcome.failure.reason}` : ""}`
        : outcome.status;
  const text =
    `Background task ${outcome.taskId} ${summary} after ${outcome.durationMs}ms.` +
    (outcome.statusMessage ? ` ${outcome.statusMessage}` : "") +
    " Use task_get or task_await to retrieve its result if you need it.";
  const metadata = { source: TASK_WAKE_SOURCE, taskId: outcome.taskId };
  return {
    messages: [{ role: "user", content: text, metadata }],
    metadata,
  };
}

// Reason-string helpers (reasonOf / causeValue) live in
// @agentick/utils/cause — used by the executor, not the harness.
//
// TODO(#134b/#134d): MCP wire codec for tasks — unchanged; the bus
// channels carry the same payloads. Inbound MCP `tasks/cancel` lands on
// the inbox via `TASKS_CANCEL_MESSAGE_TYPE`.
//
// #120-followup (LANDED): `input_required` is a live, produced state. A
// work fn opts in by wrapping any external-input pause in
// `TaskWorkContext.awaitingInput(promise, { message? })` — GENERIC over
// elicit / sampling / roots / any external await (tasks take NO
// elicitation dependency). It flips `working → input_required → working`
// through the SAME `report` seam as `onProgress` / `setStatusMessage`, so
// `applyTransition`'s non-terminal `t.status` branch persists + emits it
// with no special-casing; wired symmetrically in the in-process executor
// and the child-process worker (over IPC). A cancel while paused drives
// the record terminal and the `finally`'s `working` report is a
// post-terminal no-op (can't strand the task).
//
// ADR-68 Build B (LANDED): `ChildProcessTaskExecutor` implements the same
// `TaskExecutor` seam over IPC (serializable descriptor: `handlerRef` +
// `input`; reports status/progress/result back → parent → `report`). It's
// selected per-submit via `opts.executorKind` from the `executors`
// registry; hydration + cancel dispatch on `record.executorKind`. Its
// `TaskExecution` stashes the child's `taskId`; `cancel` sends an
// IPC-cancel + SIGKILL backstop and returns the exit-ack Promise;
// `reattach` re-adopts a still-live child WITHIN the app process (the
// app-scoped instance's map outlives the session).
//
// ADR-68 pg: `@agentick/tasks-store-postgres` conforms to `TaskStore` —
// durability across app-process restart + real `interrupted`-on-restart
// (a same-process no-op with the in-memory store). LANDED + proven.
//
// NOTE (not a TODO on this executor): cross-*restart* CHILD reattach is NOT
// achievable by "persist the pid + re-adopt by pid" — fork IPC is a
// spawn-time pipe a fresh process can't re-attach to, so a pid gives no
// channel to the child. A worker whose reports outlive its parent must
// report via a reconnectable transport (shared store / cluster bus); that is
// the DISTRIBUTED-executor tier (ADR-68 ambitious), not a fork-IPC follow-on.
// Across a restart the child-process executor's honest outcome is
// `interrupted`, and the worker self-terminates on IPC `disconnect`.
