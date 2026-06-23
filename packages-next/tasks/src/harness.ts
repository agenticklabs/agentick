/**
 * TasksHarness — substrate-level long-running tool primitive.
 *
 * Extends {@link BaseHarness} so every task participates in the
 * runtime's journaling + bus envelope contract. The harness owns:
 *
 *   - The in-process task registry (taskId → live record).
 *   - The Promise that drives each task's work function.
 *   - A per-task `Queue<TaskEvent>` for each active subscriber —
 *     fan-out is "publish iterates the set and offers to each
 *     queue"; subscribers consume via `Queue.take`.
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
 * **Why Promise-flavor work runner, not `Effect.runFork`:** user
 * work is `(ctx) => Promise<T> | T`. Wrapping in `Effect.tryPromise`
 * + `Effect.runFork` would give us a fiber handle, but
 * `Fiber.interrupt` doesn't actually interrupt a Promise — the
 * underlying microtasks keep running until they observe the
 * AbortSignal. The shape costs us a `Cause`-unwrap layer for no
 * real cancellation benefit. Direct `workPromise.then().catch()` +
 * `AbortController.abort()` is the honest implementation. When
 * we add an Effect-typed work overload (`(ctx) => Effect<T, E,
 * never>`), THAT path runs as a fiber with real interruptibility.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 */

import { Effect, Queue } from "effect";
import { BaseHarness, ulid } from "@agentick/runtime-next";
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
   */
  readonly controller: AbortController;
  /**
   * Per-subscriber Queues of `TaskEvent`. Set, not single-queue,
   * because multiple consumers can call `events(taskId)`
   * concurrently. Publish iterates and offers to each.
   */
  readonly subscribers: Set<Queue.Queue<TaskEvent>>;
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
      subscribers: new Set(),
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
    let workPromise: Promise<T>;
    try {
      const ret = work(ctx);
      workPromise = ret instanceof Promise ? ret : Promise.resolve(ret);
    } catch (syncThrow) {
      workPromise = Promise.reject(syncThrow);
    }

    void workPromise
      .then((value) => {
        if (record.status === "cancelled") {
          // Caller-driven cancel raced the work's resolution. Honor
          // cancelled terminal; the rejection was already wired by
          // the cancel path.
          return;
        }
        this.transition(record, "completed");
        resultDeferred.resolve(value);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted && record.status === "cancelled") {
          // Cancel already set status + rejected the deferred via
          // the cancel path. No-op.
          return;
        }
        const failure: TaskFailure = {
          kind: "error",
          reason: errorReason(cause),
        };
        record.failure = failure;
        this.transition(record, "failed");
        resultDeferred.reject(this.rejectionOf(record, "failed", failure));
      });

    return this.makeHandle<T>(record);
  }

  // ─────────── lookups ───────────

  get(taskId: string): TaskInfo | undefined {
    const record = this.tasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
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
    // normal failure path.
    const pending: Array<Promise<void>> = [];
    for (const record of this.tasks.values()) {
      if (this.isTerminal(record.status)) continue;
      pending.push(this.cancelInternal(record, "harness_closed"));
    }
    await Promise.all(pending);
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
    this.publishStatus(record);
    // NOTE on subscriber-queue cleanup: we intentionally do NOT
    // shut down subscriber queues here. `Queue.shutdown` discards
    // pending items, which would race the consumer's pull of the
    // terminal event we just published. Consumer iterators detect
    // terminal status in their `next()` body (sets a local `closed`
    // flag) and close on the FOLLOWING pull; the iterator's
    // `return()` (auto-called by `for await ... break` and friends)
    // drains and shuts down the queue. Queues whose consumer never
    // returns linger until `harness.close()` cleans them up.
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
    const info = this.snapshot(record);
    void Effect.runPromise(this.publishOnChannel(TASK_STATUS_CHANNEL, info)).catch(() => {
      // Substrate emit failures are not actionable here.
    });
    const event: TaskEvent = { kind: "status", info };
    this.fanoutToSubscribers(record, event);
  }

  private publishProgress(record: TaskRecord, update: ProgressUpdate): void {
    const payload = {
      taskId: record.taskId,
      current: update.current,
      ...(update.total !== undefined ? { total: update.total } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
    };
    void Effect.runPromise(this.publishOnChannel(TASK_PROGRESS_CHANNEL, payload)).catch(() => {});
    const event: TaskEvent = {
      kind: "progress",
      taskId: record.taskId,
      current: update.current,
      ...(update.total !== undefined ? { total: update.total } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
    };
    this.fanoutToSubscribers(record, event);
  }

  private fanoutToSubscribers(record: TaskRecord, event: TaskEvent): void {
    for (const q of record.subscribers) {
      Effect.runSync(Queue.offer(q, event));
    }
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
   * Subscribe to a task's event stream — initial snapshot, then
   * future events from a per-subscriber `Queue<TaskEvent>`. The
   * iterator's `return()` shuts down the queue and removes it from
   * the task's subscriber set; terminal status (`completed` /
   * `failed` / `cancelled`) shuts down every subscriber queue
   * centrally in `transition()` so consumers see a clean close.
   */
  private subscribeToTask(record: TaskRecord): AsyncIterable<TaskEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const initial: TaskEvent = { kind: "status", info: this.snapshot(record) };
        let yieldedInitial = false;
        let q: Queue.Queue<TaskEvent> | undefined;
        let closed = false;

        const ensureQueue = (): void => {
          if (q !== undefined || closed) return;
          if (this.isTerminal(record.status)) {
            // Pre-terminal subscribe — yield the initial snapshot
            // then close on next pull.
            closed = true;
            return;
          }
          q = Effect.runSync(Queue.unbounded<TaskEvent>());
          record.subscribers.add(q);
        };

        return {
          next: async (): Promise<IteratorResult<TaskEvent>> => {
            if (!yieldedInitial) {
              yieldedInitial = true;
              ensureQueue();
              return { value: initial, done: false };
            }
            if (closed) return { value: undefined, done: true };
            if (q === undefined) {
              closed = true;
              return { value: undefined, done: true };
            }
            try {
              const event = await Effect.runPromise(Queue.take(q));
              if (event.kind === "status" && this.isTerminal(event.info.status)) {
                // Terminal frame — yield it; next pull closes.
                closed = true;
              }
              return { value: event, done: false };
            } catch {
              // Queue shut down (terminal status cascade or
              // explicit return()). Treat as iterator end.
              closed = true;
              return { value: undefined, done: true };
            }
          },
          return: async (): Promise<IteratorResult<TaskEvent>> => {
            closed = true;
            if (q !== undefined) {
              record.subscribers.delete(q);
              await Effect.runPromise(Queue.shutdown(q));
              q = undefined;
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

// ============================================================================
// Error reason — minimal, mirrors ElicitationHarness's stringifyReason
// ============================================================================

function errorReason(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return String((cause as { _tag: string })._tag);
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// TODO(#155): the per-subscriber Queue + custom AsyncIterator dance
// in `subscribeToTask` reinvents most of `Stream.toAsyncIterable`.
// Adopting Effect's Stream API directly is the cleanup target —
// blocked on resolving the `Scope.Scope` service requirement that
// `Stream.fromQueue` / `Stream.toAsyncIterable` impose. When that
// lands, the iterator body shrinks to a 5-line `Stream.fromQueue`
// + `Stream.toAsyncIterable` pipeline. Tracked under #155
// (Effect-native internals refactor).
//
// TODO(#155): tool-handler return-type detection. When a tool
// handler's return is a `TaskHandle`, the ToolExecutor should
// register the task with this harness AND `await handle.result`
// transparently (Path A: model-transparent). The integration lives
// in `@agentick/tool-executor-next`, not here. Once #155 ships and
// the executor wires this, JSX `<Tool>` consumers gain task-shaped
// returns by changing one handler return statement.
//
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
