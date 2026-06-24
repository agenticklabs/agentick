/**
 * TasksHarness — substrate-level long-running tool primitive.
 *
 * Extends {@link BaseHarness} so every task participates in the
 * runtime's journaling + bus envelope contract. The harness owns:
 *
 *   - The in-process task registry (taskId → live record).
 *   - The Promise that drives each task's work function.
 *   - Per-task fan-out via a single `LocalPubSub<TaskEvent>`. All
 *     status transitions AND progress updates flow through this one
 *     bus, preserving CAUSAL ORDER across the two event kinds.
 *     `events(taskId)` synthesizes the initial snapshot at subscribe
 *     time (`Stream.concat(Stream.make(snapshot), bus.subscribe())`)
 *     then closes on the terminal status frame via
 *     `Stream.takeUntil`, materialized to `AsyncIterable<TaskEvent>`
 *     via `Stream.toAsyncIterable`.
 *
 *     (An earlier #162 attempt split state from events via
 *     `SubscriptionRef<TaskInfo>` + a progress-only `LocalPubSub`
 *     and merged them with `Stream.merge`. `Stream.merge`'s fair
 *     scheduling between sources DROPS events when both have items
 *     pending — the progress-then-terminal sequence is the textbook
 *     hit. Single-bus + synthesized snapshot is the correct
 *     primitive composition for this use case; we lose
 *     "replay-via-SubscriptionRef" but gain causal ordering, which
 *     adopters depend on.)
 *   - The bus channels (`task-status`, `task-progress`) that surface
 *     state transitions and progress updates to subscribers across
 *     the substrate.
 *   - The cluster-friendly inbox seam — `tasks-cancel`, `tasks-get`,
 *     `tasks-result` messages route here so cross-harness /
 *     cross-process callers drive task ops by address without
 *     holding an in-process reference.
 *
 * The MCP wire codec (Phase B) integrates by listening on the bus
 * channels and emitting `notifications/tasks/status` /
 * `notifications/progress` over the wire. Inbound MCP task ops
 * (`tasks/cancel`) land via the harness's inbox.
 *
 * **Two work runners — Promise-flavor and Effect-flavor.** Work
 * may return `Promise<T> | T` OR `Effect<T, E, never>`. The runner
 * branches on `Effect.isEffect(work(ctx))`:
 *
 *   - **Promise path.** Direct `workPromise.then().catch()` +
 *     `AbortController.abort()`. Honest because `Fiber.interrupt`
 *     doesn't propagate to a wrapped Promise — the underlying
 *     microtasks keep running until they observe the AbortSignal.
 *     Wrapping in `Effect.tryPromise` + `runFork` costs a
 *     `Cause`-unwrap layer for no cancellation benefit.
 *
 *   - **Effect path.** `Effect.runFork` + `Fiber` tracking; cancel
 *     calls `Fiber.interrupt` for real interruptibility — `Effect.sleep`,
 *     `Effect.async`, generator-based work, etc., all bail
 *     synchronously on interruption. Typed failure surfaces as
 *     `status: "failed"`; defect (`Effect.die`) likewise; interruption
 *     surfaces as `status: "cancelled"`.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 */

import { Cause, Effect, Fiber, Stream } from "effect";
import { BaseHarness, ulid } from "@agentick/runtime-next";
import { createLocalPubSub, type LocalPubSub } from "@agentick/pubsub-next";
import { causeValue, reasonOf } from "@agentick/utils-next";
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
  TaskFailure,
  TaskHandle,
  TaskInfo,
  TaskRejection,
  TaskStatus,
  TaskWorkContext,
  TasksHarnessProtocol,
  UnknownTaskError,
} from "@agentick/spec-next";

import { TASK_PROGRESS_CHANNEL, TASK_STATUS_CHANNEL } from "./channel.js";
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
// Internal record
// ============================================================================

interface TaskRecord {
  readonly taskId: string;
  status: TaskStatus;
  readonly createdAt: number;
  lastUpdatedAt: number;
  readonly ttl: number | null;
  readonly pollInterval: number | undefined;
  statusMessage: string | undefined;
  failure: TaskFailure | undefined;
  /**
   * Drives cancellation for promise-typed work. `signal` is surfaced
   * on {@link TaskWorkContext.signal} so work fns can bail out early.
   * Also aborted on cancel of an Effect-typed task as defence in
   * depth (so any embedded Promise-flavor side-effects in the Effect
   * still see the abort).
   */
  readonly controller: AbortController;
  /**
   * Only set on the Effect-flavor work path. `cancel()` calls
   * `Fiber.interrupt(fiber)` for real interruptibility — `Effect.sleep`,
   * `Effect.async` registered cleanup, etc., all bail synchronously.
   * `undefined` on the Promise/sync path (where the AbortController
   * is the only signal).
   */
  fiber: Fiber.RuntimeFiber<unknown, unknown> | undefined;
  /**
   * Single fan-out channel — all task events (status transitions +
   * progress updates) flow through this one bus. One queue per
   * subscriber means causal order is preserved across event kinds.
   * `subscribeToTask` synthesizes the initial snapshot via
   * `Stream.concat(Stream.make(snapshot), bus.subscribe())` so late
   * subscribers see the current state before live events.
   */
  readonly eventBus: LocalPubSub<TaskEvent>;
  /**
   * Resolves with the work's return value on `completed`. Rejects
   * with a `TaskRejection` on `failed` / `cancelled`. Hand-rolled
   * Promise deferred — direct equivalent to `Promise.withResolvers()`
   * (ES2024; not yet in our TS lib target).
   */
  readonly resultDeferred: {
    readonly promise: Promise<unknown>;
    resolve(value: unknown): void;
    reject(reason: TaskRejection): void;
  };
}

function makeDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
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
   * Scope stamped on every published task envelope. Session-scoped
   * client subscriptions filter on `scope.sessionId`, so per-session
   * harnesses MUST pass `{ sessionId }` here. Construction sites in
   * production (`AppHarness.createSession`, `withTasks`) thread the
   * owning session's id through.
   */
  readonly parentScope?: EventScope;
}

// ============================================================================
// Harness
// ============================================================================

export class TasksHarness extends BaseHarness<"tasks"> implements TasksHarnessProtocol {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly parentScope: EventScope | undefined;

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
    const controller = new AbortController();
    const resultDeferred = makeDeferred<unknown>();

    const record: TaskRecord = {
      taskId,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttl: opts.ttl ?? null,
      pollInterval: opts.pollInterval,
      statusMessage: opts.statusMessage,
      failure: undefined,
      controller,
      fiber: undefined,
      // Fan-out + substrate fan-in in one primitive. The onPublish
      // hook translates each TaskEvent into the appropriate substrate
      // channel envelope; harness owns the translation, pubsub-next
      // stays agnostic. Errors in onPublish are isolated by the bus
      // — a substrate emit failure CANNOT block in-process subscribers.
      eventBus: createLocalPubSub<TaskEvent>({
        onPublish: (event) => this.fanOutToSubstrate(event),
      }),
      resultDeferred,
    };
    this.tasks.set(taskId, record);

    // Initial status fan-out (bus + per-subscriber queues).
    this.publishStatus(record);

    const ctx: TaskWorkContext = {
      signal: controller.signal,
      onProgress: (update: ProgressUpdate) => {
        if (this.isTerminal(record.status)) return;
        record.lastUpdatedAt = Date.now();
        this.publishProgress(record, update);
      },
      setStatusMessage: (message: string) => {
        if (this.isTerminal(record.status)) return;
        record.statusMessage = message;
        record.lastUpdatedAt = Date.now();
        this.publishStatus(record);
      },
    };

    // Invoke work SYNCHRONOUSLY so its body runs (registering signal
    // listeners, etc.) before submit() returns. If we deferred with
    // `Promise.resolve().then(() => work(...))`, a synchronous
    // `cancel()` or `close()` called immediately after submit would
    // abort the signal BEFORE the work has had a chance to register
    // its `signal.addEventListener("abort", ...)` — and AbortSignal
    // listeners do NOT fire when attached post-abort.
    let ret: Promise<T> | T | Effect.Effect<T, unknown, never>;
    try {
      ret = work(ctx);
    } catch (syncThrow) {
      this.finishAsFailed(record, syncThrow);
      return this.makeHandle<T>(record);
    }

    if (Effect.isEffect(ret)) {
      this.runEffectWork<T>(record, ret as Effect.Effect<T, unknown, never>);
    } else {
      const workPromise: Promise<T> = ret instanceof Promise ? ret : Promise.resolve(ret);
      this.runPromiseWork<T>(record, workPromise);
    }

    return this.makeHandle<T>(record);
  }

  private runPromiseWork<T>(record: TaskRecord, workPromise: Promise<T>): void {
    void workPromise
      .then((value) => {
        if (record.status === "cancelled") {
          // Caller-driven cancel raced the work's resolution. Honor
          // cancelled terminal; the rejection was already wired by
          // the cancel path.
          return;
        }
        this.transition(record, "completed");
        record.resultDeferred.resolve(value);
      })
      .catch((cause: unknown) => {
        if (record.controller.signal.aborted && record.status === "cancelled") {
          // Cancel already set status + rejected the deferred via
          // the cancel path. No-op.
          return;
        }
        this.finishAsFailed(record, cause);
      });
  }

  private runEffectWork<T>(record: TaskRecord, effect: Effect.Effect<T, unknown, never>): void {
    // Pure-Effect runner — no Promise bridge. `matchCauseEffect` runs
    // onSuccess / onFailure INSIDE the forked program, so the
    // imperative side-effects (transition / resolve / finishAs*)
    // live in `Effect.sync` blocks instead of a `.then` callback.
    //
    // Race semantics preserved from the prior impl: if `cancel()`
    // already set `status === "cancelled"`, the handler short-
    // circuits without overriding the cancel state. External
    // `Fiber.interrupt` (from cancelInternal) AND internal
    // `Effect.interrupt` both surface as interrupt-only causes;
    // `Cause.isInterruptedOnly` distinguishes them from typed
    // failures + defects.
    const program = effect.pipe(
      Effect.matchCauseEffect({
        onSuccess: (value) =>
          Effect.sync(() => {
            record.fiber = undefined;
            if (record.status === "cancelled") return;
            this.transition(record, "completed");
            record.resultDeferred.resolve(value);
          }),
        onFailure: (cause) =>
          Effect.sync(() => {
            record.fiber = undefined;
            if (record.status === "cancelled") return;
            if (Cause.isInterruptedOnly(cause)) {
              this.finishAsCancelled(record, "interrupted");
              return;
            }
            // Extract the originating value from the Cause so
            // `failure.cause` carries the typed E (Effect.fail) or the
            // defect (Effect.die) verbatim. `finishAsFailed` derives
            // `failure.reason` from this same value via `reasonOf`.
            // Falls back to the Cause itself for empty / exotic shapes
            // so adopters still get _something_ inspectable.
            this.finishAsFailed(record, causeValue(cause) ?? cause);
          }),
      }),
    );
    const fiber = Effect.runFork(program);
    // For sync-completing work (e.g. `Effect.succeed(x)`), the
    // handler above may have already run before `runFork` returns —
    // setting `record.fiber = undefined` and transitioning to
    // terminal. Only stash the fiber handle if work is still live;
    // otherwise we'd hold a dead handle on a terminal record.
    if (!this.isTerminal(record.status)) {
      record.fiber = fiber;
    }
  }

  private finishAsFailed(record: TaskRecord, cause: unknown): void {
    if (this.isTerminal(record.status)) return;
    // Preserve the original failure value on `cause` so adopters
    // branching on structured E (`_tag` discrimination, error payloads,
    // etc.) keep access to the full shape. `reason` stays as the
    // single-line summary derived via `reasonOf`.
    const failure: TaskFailure = {
      kind: "error",
      reason: reasonOf(cause),
      cause,
    };
    record.failure = failure;
    this.transition(record, "failed");
    record.resultDeferred.reject(this.rejectionOf(record, "failed", failure));
  }

  private finishAsCancelled(record: TaskRecord, reason: string): void {
    if (this.isTerminal(record.status)) return;
    const failure: TaskFailure = { kind: "aborted", reason };
    record.failure = failure;
    this.transition(record, "cancelled");
    record.resultDeferred.reject(this.rejectionOf(record, "cancelled", failure));
  }

  // ─────────── lookups ───────────

  get(taskId: string): TaskInfo | undefined {
    const record = this.tasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
  }

  list(): readonly TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const record of this.tasks.values()) {
      out.push(this.snapshot(record));
    }
    return out;
  }

  status(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  async result<T = readonly ContentBlock[]>(taskId: string): Promise<T> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw { _tag: "UnknownTaskError", taskId } satisfies UnknownTaskError;
    }
    return (await record.resultDeferred.promise) as T;
  }

  // ─────────── cancel ───────────

  async cancel(taskId: string, reason?: string): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw { _tag: "UnknownTaskError", taskId } satisfies UnknownTaskError;
    }
    if (this.isTerminal(record.status)) return; // idempotent
    await this.cancelInternal(record, reason ?? "cancelled");
  }

  /**
   * Internal cancel — used by `cancel()` (single id, throws on
   * unknown) and `close()` (cascade, skips terminals at the call
   * site). Sets failure + status, rejects the deferred, aborts the
   * AbortController so promise-typed work fns watching the signal
   * bail out.
   */
  private async cancelInternal(record: TaskRecord, reason: string): Promise<void> {
    record.failure = { kind: "aborted", reason };
    this.transition(record, "cancelled");
    record.resultDeferred.reject(this.rejectionOf(record, "cancelled", record.failure));
    record.controller.abort(reason);
    if (record.fiber !== undefined) {
      // Effect path — Fiber.interrupt propagates through Effect.sleep,
      // Effect.async finalizers, Effect.gen yields, etc. We AWAIT it:
      // when `await cancel(taskId)` returns, the fiber's finalizers
      // have run and the runtime has fully detached. This makes
      // `close()` deterministic (no background fiber cleanup leaking
      // past the harness shutdown) and gives single-task cancel the
      // same "settled" guarantee. `.catch` is defensive — Fiber.interrupt
      // is total in practice but we never want a finalizer defect to
      // wedge the cancel call.
      const fiber = record.fiber;
      record.fiber = undefined;
      await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
    }
  }

  // ─────────── events ───────────

  events(taskId: string): AsyncIterable<TaskEvent> {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw { _tag: "UnknownTaskError", taskId } satisfies UnknownTaskError;
    }
    return this.subscribeToTask(record);
  }

  // ─────────── close ───────────

  override async close(): Promise<void> {
    // Cancel every in-flight task BEFORE the inbox subscription is
    // torn down so subscribers see the terminal state through the
    // normal failure path. The cancel cascade transitions records to
    // "cancelled" which propagates via SubscriptionRef.changes —
    // events() subscribers see the terminal frame and their streams
    // close via Stream.takeUntil.
    const pending: Array<Promise<void>> = [];
    for (const record of this.tasks.values()) {
      if (this.isTerminal(record.status)) continue;
      pending.push(this.cancelInternal(record, "harness_closed"));
    }
    await Promise.all(pending);
    // Drain + shut down each task's event bus. The cancel cascade
    // above already published terminal status frames, so subscriber
    // streams should already be closing via Stream.takeUntil; the
    // bus.close() backs up the cleanup deterministically.
    for (const record of this.tasks.values()) {
      await record.eventBus.close();
    }
    await super.close();
  }

  // ─────────── inbox ───────────

  /**
   * Inbox dispatch:
   *
   *   - `request-response`  → auto-intercepted by `BaseHarness`. Not
   *                            seen here.
   *   - `tasks-cancel`      → cancel-by-id; no reply. Idempotent on
   *                            unknown / terminal ids.
   *   - `tasks-get`         → snapshot lookup; reply via
   *                            `request-response`.
   *   - `tasks-result`      → await terminal; reply via
   *                            `request-response` with
   *                            `TasksResultReply`.
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
        return Effect.fail({
          _tag: "HandlerError",
          cause: `Unknown tasks message type: ${String(msg.type)}`,
        });
    }
  }

  private handleCancelInbox(
    msg: MessageEnvelope<TasksCancelInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        if (msg.payload === undefined) return undefined;
        const { taskId, reason } = msg.payload;
        const record = this.tasks.get(taskId);
        if (!record || this.isTerminal(record.status)) return undefined;
        await this.cancelInternal(record, reason ?? "remote_cancel");
        return undefined;
      },
      catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
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
      catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
    });
  }

  private handleResultInbox(
    msg: MessageEnvelope<TasksResultInboxPayload>,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.tryPromise<unknown, MessageHandlerError>({
      try: async () => {
        if (msg.payload === undefined) return undefined;
        const { taskId, replyTo, correlationId } = msg.payload;
        const record = this.tasks.get(taskId);
        let reply: TasksResultReply<unknown>;
        if (!record) {
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
            const value = await record.resultDeferred.promise;
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
      catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
    });
  }

  // ─────────── diagnostics ───────────

  /**
   * NOT on the protocol — tests use it to assert in-flight counts;
   * production callers MUST NOT depend on this for control flow.
   */
  pendingCount(): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (!this.isTerminal(record.status)) count++;
    }
    return count;
  }

  // ─────────── internals ───────────

  private isTerminal(status: TaskStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private transition(record: TaskRecord, next: TaskStatus): void {
    if (this.isTerminal(record.status)) return;
    record.status = next;
    record.lastUpdatedAt = Date.now();
    // Update the SubscriptionRef — every active subscriber sees the
    // new TaskInfo on their .changes stream. Terminal frames trigger
    // Stream.takeUntil in subscribeToTask, ending the merged stream
    // cleanly without a manual close-and-race-the-pending-event
    // dance. The progress bus stays open until harness.close()
    // drains it (no terminal-cascade shutdown needed — Stream.merge
    // closes its sources when the consumed stream ends).
    this.publishStatus(record);
  }

  private snapshot(record: TaskRecord): TaskInfo {
    return {
      taskId: record.taskId,
      status: record.status,
      createdAt: record.createdAt,
      lastUpdatedAt: record.lastUpdatedAt,
      ttl: record.ttl,
      ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
      ...(record.pollInterval !== undefined ? { pollInterval: record.pollInterval } : {}),
      ...(record.failure !== undefined ? { failure: record.failure } : {}),
    };
  }

  private rejectionOf(
    record: TaskRecord,
    status: "failed" | "cancelled",
    failure: TaskFailure | undefined,
  ): TaskRejection {
    return {
      _tag: "TaskRejection",
      taskId: record.taskId,
      status,
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  private publishStatus(record: TaskRecord): void {
    // Single call site — eventBus.publish fans out to in-process
    // subscribers AND, via the onPublish hook wired at bus
    // construction, into the substrate's protocol bus.
    record.eventBus.publish({ kind: "status", info: this.snapshot(record) });
  }

  private publishProgress(record: TaskRecord, update: ProgressUpdate): void {
    record.eventBus.publish({
      kind: "progress",
      taskId: record.taskId,
      current: update.current,
      ...(update.total !== undefined ? { total: update.total } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
    });
  }

  /**
   * Substrate fan-in hook — runs synchronously on every event the
   * task's eventBus publishes. Translates each `TaskEvent` to its
   * canonical substrate channel envelope and emits via
   * `publishOnChannel`. Errors are swallowed by the bus's onPublish
   * isolation; logged here for diagnostic visibility.
   *
   * Centralizing the translation here means a single call site for
   * "publish a task event" (`record.eventBus.publish(...)`) handles
   * both in-process fan-out AND substrate journaling. The bus stays
   * agnostic about substrate shape; the harness owns the codec.
   */
  private fanOutToSubstrate(event: TaskEvent): void {
    if (event.kind === "status") {
      void Effect.runPromise(this.publishOnChannel(TASK_STATUS_CHANNEL, event.info)).catch(
        () => undefined,
      );
      return;
    }
    // progress event
    void Effect.runPromise(
      this.publishOnChannel(TASK_PROGRESS_CHANNEL, {
        taskId: event.taskId,
        current: event.current,
        ...(event.total !== undefined ? { total: event.total } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
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

  private makeHandle<T>(record: TaskRecord): TaskHandle<T> {
    return {
      taskId: record.taskId,
      initialStatus: record.status,
      result: record.resultDeferred.promise as Promise<T>,
      info: () => this.snapshot(record),
      events: () => this.subscribeToTask(record),
      cancel: (reason?: string) => this.cancel(record.taskId, reason),
    };
  }

  /**
   * Subscribe to a task's event stream.
   *
   *   - Initial frame: `Stream.make` synthesizes a `status` event
   *     from the current `TaskInfo` snapshot at subscribe time.
   *     Subscribers attaching after terminal still see the terminal
   *     snapshot before the stream closes.
   *   - Live frames: `record.eventBus.subscribe()` streams every
   *     `TaskEvent` published after subscription. The bus is a
   *     single channel so status and progress events preserve
   *     causal order (no Stream.merge fairness-induced drops).
   *   - Termination: `Stream.takeUntil` (inclusive — emits the
   *     matching item then closes) on the first terminal status
   *     frame ends the stream.
   */
  private subscribeToTask(record: TaskRecord): AsyncIterable<TaskEvent> {
    const initial: TaskEvent = { kind: "status", info: this.snapshot(record) };
    const stream = Stream.concat(Stream.make(initial), record.eventBus.subscribe()).pipe(
      Stream.takeUntil((event) => event.kind === "status" && this.isTerminal(event.info.status)),
    );
    return Stream.toAsyncIterable(stream);
  }
}

// Reason-string helpers (reasonOf / reasonOfCause) live in
// @agentick/utils-next/cause — single canonical impl shared by every
// harness. See packages-next/utils/src/cause.ts.

// TODO(#134b/#134d): MCP wire codec for tasks. The bus channels
// (`task-status`, `task-progress`) already carry payloads in the
// shape MCP's `notifications/tasks/status` + `notifications/progress`
// expect; the codec layer in `@agentick/mcp-next` translates 1:1.
// Inbound MCP `tasks/cancel` lands on this harness's inbox via the
// existing `TASKS_CANCEL_MESSAGE_TYPE` handler. Tracked under MCP
// follow-ups.
//
// TODO(#120-followup): auto-transition to `input_required` when a
// task's work fn pauses on an elicit/sampling/roots request. The
// FSM state is declared in spec; the transition isn't wired —
// today, work fns calling `bridges.elicitation.elicit(...)` stay
// `working` for the elicit's duration. Phase B integration (when
// elicitations route through a task-aware harness ctx).
