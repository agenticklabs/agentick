/**
 * Persistent-task substrate (ADR 68) — the durable **record** the task
 * FSM lives in, the CRUD **store** port that persists it, and the
 * pluggable **executor** seam that runs the work and reports transitions.
 *
 * The pivot (ADR 68): today a task IS an in-process fiber and the record
 * is a view. Inverted here — the task is a persisted {@link TaskRecord}
 * state machine in a {@link TaskStore}; **how it runs** is a swappable
 * {@link TaskExecutor} strategy behind the record; the `TasksHarness`
 * orchestrates. On `submit` the harness writes a `working` record and
 * starts an executor; the executor **reports transitions** ({@link
 * TaskTransition}) back through one uniform `report` callback; the harness
 * turns each transition into a `store.put` PLUS the existing
 * `tasks-status` / `tasks-progress` bus emit. **The bus stays the LIVE
 * plane; the store is the DURABLE plane.**
 *
 * Build this seam once and the ideal (detached, resumable) and ambitious
 * (distributed) tiers are added executor strategies + a durable store, not
 * rewrites. The bundled default store ({@link
 * import("@agentick/tasks-next").InMemoryTaskStore}) and executor
 * (in-process) ship now; `@agentick/tasks-store-postgres-next` and the
 * child-process executor conform to the SAME ports later.
 *
 * Port homes: the store/executor **types** live in spec-next (the
 * cross-package contract — the harness consumes it, adapter packages
 * implement it, only spec-next is a shared dep). The bundled in-memory
 * store and the `runTaskStoreConformance` suite live in
 * `@agentick/tasks-next` (mirrors `TimelineStore` / the timeline
 * store-conformance home; spec-next stays vitest-free).
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

import type { Effect } from "effect";

import type { ContentBlock } from "../data/content-blocks.js";
import type { EventScope } from "../data/events.js";
import type { CollectionStore } from "./store.js";
import type { ProgressUpdate, TaskFailure, TaskStatus, TaskWorkContext } from "./tasks-harness.js";
import type { Elicit, ElicitFn } from "./elicit-api.js";

// ============================================================================
// TaskRecord — the durable source of truth
// ============================================================================

/**
 * The task's durable state — a serializable snapshot of the FSM at a
 * point in time. Every transition upserts a new record via
 * {@link TaskStore.put}; the harness keeps a synchronous projection of
 * these for the `TaskInfo` reads its protocol exposes.
 *
 * Serialization-aware by construction: no live handles (AbortController,
 * Fiber, Promise) live here — those stay in the harness's in-process
 * live-task map. This is what lets a child-process / worker executor
 * hand the record across a process boundary (`handlerRef` + `input`
 * resolve the work on the far side; `executorState` is the reattach
 * handle).
 */
export interface TaskRecord {
  readonly taskId: string;
  /** FSM state — includes `"interrupted"` (orphan accounting, ADR 68). */
  readonly status: TaskStatus;
  /** Owner coordinates — session / execution / principal. Scope-filtered by the store. */
  readonly scope: EventScope;
  /** Which executor strategy runs this task (`"in-process"`, `"child-process"`, …). */
  readonly executorKind: string;
  /** `true` = survives the spawning session's `close()` (not aborted). */
  readonly detached: boolean;
  /** Submit input — audit / replay, and the payload a by-ref executor resolves work with. */
  readonly input?: unknown;
  /** For executors that resolve work by reference (child / worker) — not an inline closure. */
  readonly handlerRef?: string;
  /**
   * The work's return value on `completed`. Typed `unknown` (not
   * `ContentBlock[]`) because `submit<T>` is generic — the common
   * tool-return case is `ContentBlock[]`, but the durable record must
   * faithfully carry whatever `T` the work resolved with. In-process,
   * the live handle's Promise is the real result carrier; this field is
   * the serializable projection for audit / cross-process reattach.
   */
  readonly result?: unknown;
  /** Structured failure on `failed` / `cancelled` / `interrupted`. */
  readonly failure?: TaskFailure;
  /** Latest progress fold (ADR 68 field name; the wire keeps `current`). */
  readonly progress?: {
    readonly progress: number;
    readonly total?: number;
    readonly message?: string;
  };
  /** Reattach handle for out-of-process executors (child pid, microvmId, …). */
  readonly executorState?: unknown;
  // ─── TaskInfo-reconstructing fields (so a hydrated record rebuilds the snapshot) ───
  /** TTL (ms) from creation. `null` = no expiry (MCP-aligned). */
  readonly ttl: number | null;
  /** Polling-client hint (ms). */
  readonly pollInterval?: number;
  /** Human-readable status summary. */
  readonly statusMessage?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ============================================================================
// TaskStore — CRUD port (mirrors TimelineStore)
// ============================================================================

/** Scope + status filter for {@link TaskStore.list}. */
export interface TaskStoreQuery {
  /** Match records whose `scope` contains every provided dimension. */
  readonly scope?: Partial<EventScope>;
  /** Match a single status or any of a set. */
  readonly status?: TaskStatus | readonly TaskStatus[];
}

/**
 * Adopter-pluggable durable backing for the task FSM — a CRUD port keyed
 * by `taskId`, queryable by scope / status. Upsert-on-every-transition;
 * NO `subscribe` (liveness is the bus, ADR 68). Swappable +
 * conformance-parameterized (`runTaskStoreConformance(factory)` in
 * `@agentick/tasks-next`), exactly like the timeline stores.
 *
 * Bundled default: `InMemoryTaskStore` (`@agentick/tasks-next`). A
 * `@agentick/tasks-store-postgres-next` conforms to this SAME protocol later.
 *
 * A `CollectionStore<TaskRecord, TaskStoreQuery, number>` (the collection
 * archetype, data-layer plan §2.1) — the prune argument is the ms-epoch
 * cutoff. The method declarations below narrow the archetype's contract to the
 * task-specific shape (parameter names, and `delete` → `Promise<void>`); they
 * MUST stay assignable to {@link CollectionStore} so any generic
 * collection-store tooling accepts a `TaskStore`.
 */
export interface TaskStore extends CollectionStore<TaskRecord, TaskStoreQuery, number> {
  /** Upsert — called on every transition. Later `put`s of the same `taskId` replace. */
  put(record: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  /** By scope / status. Omitting the query returns every record. */
  list(query?: TaskStoreQuery): Promise<readonly TaskRecord[]>;
  delete(taskId: string): Promise<void>;
  /** Optional GC of terminal records older than `before` (ms-epoch `updatedAt`). */
  prune?(before: number): Promise<void>;
  /** Self-identifying backend label for observability (e.g. `"memory"`, `"postgres"`). */
  readonly backend: string;
}

// ============================================================================
// TaskExecutor — the pluggable execution strategy seam
// ============================================================================

/**
 * The work function a task runs. Promise / sync OR Effect-flavored —
 * identical to the `TasksHarness.submit` overloads. The in-process
 * executor invokes this closure directly; a by-ref executor (child /
 * worker) ignores it and resolves `record.handlerRef` on the far side.
 */
export type TaskWork<T = readonly ContentBlock[], E = unknown> = (
  ctx: TaskWorkContext,
) => Promise<T> | T | Effect.Effect<T, E, never>;

/**
 * The report shape — ONE uniform reporting path from an executor back to
 * the harness. The harness turns each transition into a `store.put` + a
 * bus emit; this is what keeps executors interchangeable. Serializable by
 * construction so a child-process executor sends transitions over IPC.
 *
 * Single-purpose in practice — the in-process executor emits one field
 * per report (a progress update, a status-message change, or a terminal
 * status with its result/failure) — but the shape permits combinations.
 */
export interface TaskTransition {
  readonly status?: TaskStatus;
  readonly progress?: ProgressUpdate;
  /** Status-message-only update (the `setStatusMessage` seam) — no progress event. */
  readonly statusMessage?: string;
  /** Present on a `completed` transition — the work's return value. */
  readonly result?: unknown;
  /** Present on a `failed` / `cancelled` transition. */
  readonly failure?: TaskFailure;
}

/** The one uniform callback an executor drives to report transitions. */
export type TaskReport = (transition: TaskTransition) => void;

/**
 * Builds the {@link Elicit} sugar surface over a raw {@link ElicitFn}
 * (ADR 69). Injected into the executor's ctx-build so the tasks package
 * can hang `ctx.elicit` on a task WITHOUT depending on
 * `@agentick/elicitation-next` — the sugar (schema construction, throw-
 * on-decline, `try*` variants) lives in the elicitation package and is
 * passed in. `buildElicitSugar` from `@agentick/elicitation-next` has
 * exactly this shape.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */
export type TaskElicitFactory = (elicit: ElicitFn) => Elicit;

/**
 * Optional per-task escalation wiring (ADR 69) handed to
 * {@link TaskExecutor.start} alongside `report`. Both are undefined for a
 * bare tasks harness with no escalation configured (the ctx's `elicit`
 * then throws a clear "not configured" error on use); a session-wired
 * harness supplies both so `ctx.elicit` escalates to the client.
 *
 *   - `escalate` — the raw {@link ElicitFn} that performs the up-chain
 *     `inbox.ask` (built by the harness from its inbox + owning session).
 *   - `buildElicit` — the {@link TaskElicitFactory} that wraps the
 *     `awaitingInput`-composed escalate into the full `Elicit` sugar.
 */
export interface TaskExecutorHooks {
  readonly escalate?: ElicitFn;
  readonly buildElicit?: TaskElicitFactory;
}

/**
 * Opaque per-task execution handle an executor returns from {@link
 * TaskExecutor.start} and receives back at {@link TaskExecutor.cancel}.
 * The harness treats it as opaque — each executor defines its own
 * concrete shape (the in-process executor stashes the Effect `Fiber`; a
 * child-process executor stashes the child handle / pid).
 */
export interface TaskExecution {
  /** Matches the owning executor's `kind` — lets the harness sanity-check. */
  readonly kind: string;
}

/**
 * The swappable execution strategy behind a record (ADR 68). In-process
 * fiber now; child-process / sandbox / distributed-worker later — each is
 * a new implementation of THIS seam, not a harness rewrite.
 */
export interface TaskExecutor {
  /** Strategy label stamped on `record.executorKind`. */
  readonly kind: string;
  /**
   * `true` = this executor resolves the work **by reference**
   * (`record.handlerRef` → a registered handler on the far side) and
   * IGNORES the `work` closure handed to {@link start} (a closure can't
   * cross a process / node boundary). The bundled in-process executor
   * leaves this falsy — it runs the closure directly. The harness reads
   * this flag to validate generically: a submit routed to a by-ref
   * executor MUST carry a `handlerRef`, else it throws
   * `TaskHandlerRefRequiredError` before starting.
   */
  readonly byRef?: boolean;
  /**
   * Begin executing `work` (or, for a by-ref executor, resolve
   * `record.handlerRef`). MUST invoke the work synchronously enough that
   * the work body has registered its `signal` listeners before returning
   * — a synchronous `cancel()` right after `submit` relies on it. Drive
   * `report` for every transition; observe `signal` for cancellation.
   *
   * `hooks` (optional, ADR 69) carries the escalation wiring the executor
   * composes into `ctx.elicit`. Omitted for executors / call sites with
   * no escalation configured — the ctx's `elicit` then throws on use.
   */
  start(
    record: TaskRecord,
    work: TaskWork,
    report: TaskReport,
    signal: AbortSignal,
    hooks?: TaskExecutorHooks,
  ): TaskExecution;
  /**
   * Re-attach to an already-running execution described by `record`
   * (durable-store restart, child still alive). Returns `undefined` when
   * the strategy cannot reattach (a lost in-process fiber) — the harness
   * then marks the orphaned `working` record `interrupted`.
   */
  reattach?(record: TaskRecord, report: TaskReport): TaskExecution | undefined;
  /**
   * Executor-specific cancellation trigger (Effect `Fiber.interrupt`,
   * child kill/IPC-cancel, …). The harness ALSO aborts the universal
   * `AbortSignal` for Promise-flavor work. Returns a Promise when the
   * strategy can guarantee settlement (interruptible executions await
   * finalizers) so `harness.cancel()` preserves settled-cancel semantics;
   * returns `void` for fire-and-forget signal-only cancellation.
   */
  cancel(execution: TaskExecution, reason?: string): void | Promise<void>;
}
