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
 * / detached) and a `@agentick/tasks-postgres-next` durable store conform
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
import { BaseHarness, ulid } from "@agentick/runtime-next";
import { createLocalPubSub, type LocalPubSub } from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";
import type {
  ContentBlock,
  EventBus,
  EventScope,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ProgressUpdate,
  TaskCreationInput,
  TaskEvent,
  TaskExecution,
  TaskExecutor,
  TaskFailure,
  TaskHandle,
  TaskInfo,
  TaskRecord,
  TaskRejection,
  TaskReport,
  TaskStatus,
  TaskStore,
  TaskTransition,
  TaskWork,
  TaskWorkContext,
  TasksHarnessProtocol,
} from "@agentick/spec-next";
import { HandlerError, UnknownTaskError } from "@agentick/spec-next";

import { TASK_PROGRESS_CHANNEL, TASK_STATUS_CHANNEL } from "./channel.js";
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

export interface TasksHarnessOptions {
  /**
   * Scope stamped on every published task envelope AND on every
   * {@link TaskRecord} (the store's scope-filter key). Session-scoped
   * client subscriptions filter on `scope.sessionId`, so per-session
   * harnesses MUST pass `{ sessionId }`. Harnesses that share an
   * app-scoped {@link TaskStore} MUST pass a distinguishing scope so
   * hydration + `list` don't bleed across sessions.
   */
  readonly parentScope?: EventScope;
  /**
   * Durable backing for the task FSM (ADR 68). Defaults to a fresh
   * per-harness {@link InMemoryTaskStore}. The AppHarness constructs ONE
   * app-scoped store and injects it into every session's harness so
   * `detached` records survive session close.
   */
  readonly store?: TaskStore;
  /**
   * Execution strategy (ADR 68). Defaults to {@link InProcessTaskExecutor}
   * (the current fiber model). A child-process / worker executor conforms
   * to the same {@link TaskExecutor} seam.
   */
  readonly executor?: TaskExecutor;
}

// ============================================================================
// Harness
// ============================================================================

export class TasksHarness extends BaseHarness<"tasks"> implements TasksHarnessProtocol {
  /** In-process projection of the store, scoped to this harness's tasks. */
  private readonly live = new Map<string, LiveTask>();
  private readonly parentScope: EventScope | undefined;
  /** `parentScope ?? {}` — stamped on records + used as the store filter. */
  private readonly scope: EventScope;
  private readonly store: TaskStore;
  private readonly executor: TaskExecutor;

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
    super("tasks", scopeId, journal, bus, inbox);
    this.parentScope = options.parentScope;
    this.scope = options.parentScope ?? {};
    this.store = options.store ?? new InMemoryTaskStore();
    this.executor = options.executor ?? new InProcessTaskExecutor();
    // Hydration reads the store AFTER inbox registration. `ready` is a
    // readonly BaseHarness field (can't reassign), so this is a sibling
    // barrier. TODO(#134-followup): fold into `ready` if BaseHarness gains
    // a post-construction async hook.
    this.hydrated = this.ready.then(() => this.hydrateOrphans());
  }

  // ─────────── submit ───────────

  submit<T = readonly ContentBlock[]>(
    work: (ctx: TaskWorkContext) => Promise<T> | T,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;
  submit<T = readonly ContentBlock[], E = unknown>(
    work: (ctx: TaskWorkContext) => Effect.Effect<T, E, never>,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;
  submit<T = readonly ContentBlock[]>(
    work: (ctx: TaskWorkContext) => Promise<T> | T | Effect.Effect<T, unknown, never>,
    opts: TaskCreationInput = {},
  ): TaskHandle<T> {
    const taskId = `task:${ulid()}`;
    const now = Date.now();
    const record: TaskRecord = {
      taskId,
      status: "working",
      scope: this.scope,
      executorKind: this.executor.kind,
      detached: opts.detached ?? false,
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
    };
    this.live.set(taskId, live);

    // Durable-write + live-emit the initial `working` snapshot BEFORE the
    // executor starts (so subscribers see `working` first).
    this.persist(record);
    this.publishStatus(live);

    // Start the executor. It invokes `work` synchronously (so signal
    // listeners register before submit returns) and drives `report`.
    const execution = this.executor.start(
      record,
      work as TaskWork,
      this.makeReport(live),
      live.controller.signal,
    );
    // Sync-completing work (e.g. `Effect.succeed`) may have already driven
    // the record terminal during `start` — don't stash a dead handle.
    live.execution = this.isTerminal(live.record.status) ? undefined : execution;

    return this.makeHandle<T>(live);
  }

  /** The ONE uniform transition path from an executor back to the harness. */
  private makeReport(live: LiveTask): TaskReport {
    return (transition) => this.applyTransition(live, transition);
  }

  /**
   * Apply an executor-reported transition: mutate the projection record,
   * persist to the store, emit the matching bus event, and settle the
   * result deferred on a terminal. Post-terminal reports are ignored —
   * this is what preserves "caller cancel wins the race" against a work
   * fn that resolves/rejects after cancel.
   */
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
      this.persist(live.record);
      this.publishProgress(live, p);
      return;
    }

    // Status-message-only — the `setStatusMessage` seam. Still `working`.
    if (t.statusMessage !== undefined && t.status === undefined) {
      live.record = { ...record, updatedAt: now, statusMessage: t.statusMessage };
      this.persist(live.record);
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
      this.persist(live.record);
      this.publishStatus(live);
      if (this.isTerminal(live.record.status)) this.settle(live);
    }
  }

  /** Resolve / reject the result deferred from the (now terminal) record. */
  private settle(live: LiveTask): void {
    const { record, resultDeferred } = live;
    if (record.status === "completed") {
      resultDeferred.resolve(record.result);
      return;
    }
    resultDeferred.reject(
      this.rejectionOf(
        record.taskId,
        record.status as "failed" | "cancelled" | "interrupted",
        record.failure,
      ),
    );
  }

  // ─────────── lookups (served from the projection — the store read-model) ───────────

  get(taskId: string): TaskInfo | undefined {
    const live = this.live.get(taskId);
    return live ? this.snapshot(live.record) : undefined;
  }

  list(): readonly TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const live of this.live.values()) out.push(this.snapshot(live.record));
    return out;
  }

  status(taskId: string): TaskStatus | undefined {
    return this.live.get(taskId)?.record.status;
  }

  async result<T = readonly ContentBlock[]>(taskId: string): Promise<T> {
    const live = this.live.get(taskId);
    if (!live) {
      throw new UnknownTaskError({ taskId });
    }
    return (await live.resultDeferred.promise) as T;
  }

  // ─────────── cancel ───────────

  async cancel(taskId: string, reason?: string): Promise<void> {
    const live = this.live.get(taskId);
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
    this.applyTransition(live, { status: "cancelled", failure: { kind: "aborted", reason } });
    live.controller.abort(reason);
    if (live.execution !== undefined) {
      const execution = live.execution;
      live.execution = undefined;
      await this.executor.cancel(execution, reason);
    }
  }

  // ─────────── events ───────────

  events(taskId: string): AsyncIterable<TaskEvent> {
    const live = this.live.get(taskId);
    if (!live) {
      throw new UnknownTaskError({ taskId });
    }
    return this.subscribeToTask(live);
  }

  // ─────────── close ───────────

  override async close(): Promise<void> {
    // Abort non-detached in-flight tasks BEFORE the inbox teardown so
    // subscribers see the terminal state through the normal failure path.
    // DETACHED tasks are left running + persisted (ADR 68) — the shared
    // app-scoped store keeps their records; their executor keeps running.
    const pending: Array<Promise<void>> = [];
    for (const live of this.live.values()) {
      if (this.isTerminal(live.record.status)) continue;
      if (live.record.detached) continue;
      pending.push(this.cancelInternal(live, "harness_closed"));
    }
    await Promise.all(pending);
    // Drain event buses — EXCEPT those of still-running detached tasks,
    // which keep emitting after this harness closes.
    for (const live of this.live.values()) {
      if (live.record.detached && !this.isTerminal(live.record.status)) continue;
      await live.eventBus.close();
    }
    await super.close();
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
        const live = this.live.get(taskId);
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
        const live = this.live.get(taskId);
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
    for (const live of this.live.values()) {
      if (!this.isTerminal(live.record.status)) count++;
    }
    return count;
  }

  // ─────────── internals ───────────

  private isTerminal(status: TaskStatus): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    );
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

  /**
   * Fire-and-forget durable write. Reads are served from the synchronous
   * projection (updated by the caller before this runs), so the store
   * write is off the critical path. Errors are swallowed — a store write
   * failure MUST NOT crash the harness. TODO(#134-followup): a durable
   * store (pg) wants a flush barrier + typed write-failed surfacing;
   * the in-memory default resolves synchronously so there's nothing to
   * await today.
   */
  private persist(record: TaskRecord): void {
    void this.store.put(record).catch(() => undefined);
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
    return {
      taskId: live.record.taskId,
      initialStatus: live.record.status,
      result: live.resultDeferred.promise as Promise<T>,
      info: () => this.snapshot(live.record),
      events: () => this.subscribeToTask(live),
      cancel: (reason?: string) => this.cancel(live.record.taskId, reason),
    };
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
    const records = await this.store.list({ scope: this.scope });
    for (const record of records) {
      if (this.live.has(record.taskId)) continue; // this harness owns it live
      if (record.status !== "working" && record.status !== "input_required") {
        this.adoptHydrated(record); // terminal from a prior run
        continue;
      }
      // Try to reattach; an in-process executor can't → interrupted.
      const reattached = this.executor.reattach?.(record, this.makeReportFor(record.taskId));
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
      this.persist(interrupted);
      const live = this.adoptHydrated(interrupted);
      this.publishStatus(live); // record-source-of-truth: every transition emits
    }
  }

  /** Report path bound to a taskId that will be adopted into the projection. */
  private makeReportFor(taskId: string): TaskReport {
    return (transition) => {
      const live = this.live.get(taskId);
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
    };
    this.live.set(record.taskId, live);
    return live;
  }
}

// Reason-string helpers (reasonOf / causeValue) live in
// @agentick/utils-next/cause — used by the executor, not the harness.
//
// TODO(#134b/#134d): MCP wire codec for tasks — unchanged; the bus
// channels carry the same payloads. Inbound MCP `tasks/cancel` lands on
// the inbox via `TASKS_CANCEL_MESSAGE_TYPE`.
//
// TODO(#120-followup): auto-transition to `input_required` when a task's
// work fn pauses on an elicit/sampling/roots request.
//
// TODO(ADR-68 Build B): the child-process executor implements the same
// `TaskExecutor` seam over IPC (serializable descriptor: `handlerRef` +
// `input`; reports status/progress/result back → parent → `report`). Its
// `TaskExecution` stashes the child handle; `cancel` sends a kill/IPC-
// cancel and returns the exit-ack Promise. `reattach` (with a durable
// store) re-adopts a still-live child by `executorState`.
//
// TODO(ADR-68 pg): `@agentick/tasks-postgres-next` conforms to `TaskStore`
// — durability across app-process restart + real `interrupted`-on-restart
// exercise (hydration is a same-process no-op with the in-memory store).
