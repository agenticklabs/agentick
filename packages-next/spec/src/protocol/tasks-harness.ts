/**
 * TasksHarnessProtocol — substrate-level "long-running tool" primitive.
 *
 * Generalizes the `ExecutionHandle` shape (`.result` + `.events()` +
 * `.cancel()`) into a managed registry. Every long-running operation
 * — a slow shell command, an MCP server's `task: {ttl}` invocation, a
 * deploy step, a multi-minute LLM completion — registers with this
 * harness so that:
 *
 *   - The framework can journal task lifecycle deterministically.
 *   - Adopter UIs subscribe to live progress via the harness's bus
 *     channel without each tool inventing its own envelope shape.
 *   - Cancellation is cluster-routable via the harness's inbox
 *     address (`tasks-cancel` message type).
 *   - MCP wire encoding (Phase B) maps task FSM states to MCP's
 *     `working | input_required | completed | failed | cancelled`
 *     vocabulary one-to-one.
 *
 * Per ADR-23 §OQ23.15: substrate-aware Tasks bridge so local and
 * MCP-wire invocations of a `taskSupport: required` tool return the
 * same handle shape. MCP wire encoding happens at the boundary.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §Tasks
 */

import type { Effect } from "effect";

import type { ContentBlock } from "../data/content-blocks.js";

// ============================================================================
// FSM
// ============================================================================

/**
 * Task lifecycle states. Maps 1:1 onto MCP's task status enum so the
 * wire codec (Phase B) is a pass-through.
 *
 *   working          — task running.
 *   input_required   — task paused awaiting an out-of-band input
 *                      (elicit, sampling, roots). Phase A declares
 *                      the state but doesn't auto-transition; tools
 *                      that pause on elicits stay `working` until
 *                      Phase B's auto-pause integration ships.
 *   completed        — terminal; result available.
 *   failed           — terminal; `statusMessage` carries the error
 *                      summary, `failure` carries structured detail.
 *   cancelled        — terminal; caller-driven via `cancel()` OR
 *                      caused by `close()` / signal abort.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

// ============================================================================
// Shapes
// ============================================================================

/**
 * Caller-facing task descriptor. Snapshot of a task's state at a
 * point in time — mutates as the task progresses, but
 * {@link TasksHarnessProtocol.get} returns a frozen snapshot per
 * call.
 */
export interface TaskInfo {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** ms-epoch creation time. */
  readonly createdAt: number;
  /** ms-epoch last status / progress mutation. */
  readonly lastUpdatedAt: number;
  /**
   * Time-to-live (ms) from creation. `null` = no expiry (the
   * MCP-aligned semantic; servers without TTL convention use null).
   */
  readonly ttl: number | null;
  /** Human-readable summary; surfaces on UIs that don't render progress. */
  readonly statusMessage?: string;
  /**
   * Hint to polling clients: minimum interval between `tasks/get`
   * calls. Optional — pushers ignore.
   */
  readonly pollInterval?: number;
  /**
   * Failure detail (only present when `status === "failed"`).
   * Distinct from `statusMessage` because UIs sometimes show only
   * the summary while structured dispatch keys off `failure.kind`.
   */
  readonly failure?: TaskFailure;
}

export interface TaskFailure {
  readonly kind: "error" | "timeout" | "aborted";
  /**
   * Single-line summary suitable for UI / logs. Derived from `cause`
   * when present (typed E's `_tag`, Error.message, etc.) — see
   * `reasonOf` / `reasonOfCause` in `@agentick/utils-next`. Adopters
   * branching on structured failure should read `cause` instead.
   */
  readonly reason?: string;
  /**
   * Original failure value, preserved verbatim. For Effect-typed work:
   * the typed `E` extracted via `Cause.failureOption(cause)`, or the
   * defect from `Cause.defects(cause)` for `Effect.die`. For Promise-
   * typed work: the value passed to `Promise.reject` (or thrown).
   *
   * `unknown` because the harness doesn't know what shape the adopter's
   * failure type is. Adopters branching on structured failures (e.g.,
   * `if (info.failure?.cause && "_tag" in info.failure.cause && ...)`)
   * reach through here. UIs that only need a human-readable line use
   * `reason`.
   *
   * **Wire boundary:** `cause` does NOT round-trip over the MCP wire
   * (MCP's `Task` schema has no structured-cause field). Cross-system
   * tasks lossy-encode to the `reason` string. Adopters relying on
   * structured cause should plan for this asymmetry at the codec
   * boundary.
   */
  readonly cause?: unknown;
}

/**
 * Progress update emitted by the task's work function via the
 * `onProgress` callback. The harness materializes this into a
 * `TaskEvent` of kind `"progress"` on the task's event stream.
 */
export interface ProgressUpdate {
  /** Absolute progress (units defined by the task). */
  readonly current: number;
  /** Total work, if known. Omitted = indeterminate progress. */
  readonly total?: number;
  /** Optional UI-friendly status string. */
  readonly message?: string;
}

/**
 * Discriminated event yielded by {@link TasksHarnessProtocol.events}.
 *   status   — state transition (working → completed, etc.).
 *   progress — work-in-progress update.
 */
export type TaskEvent =
  | { readonly kind: "status"; readonly info: TaskInfo }
  | {
      readonly kind: "progress";
      readonly taskId: string;
      readonly current: number;
      readonly total?: number;
      readonly message?: string;
    };

// ============================================================================
// Submission input
// ============================================================================

/**
 * Hook surface the harness hands to the work function on
 * {@link TasksHarnessProtocol.submit}. `signal` aborts when the task
 * is cancelled or the harness is closed; `onProgress` fans
 * {@link ProgressUpdate} events to subscribers.
 */
export interface TaskWorkContext {
  readonly signal: AbortSignal;
  onProgress(update: ProgressUpdate): void;
  /**
   * Update the task's `statusMessage` without emitting a progress
   * event. Use for "phase changed" notices that don't have a
   * numeric current/total.
   */
  setStatusMessage(message: string): void;
}

export interface TaskCreationInput {
  /** TTL (ms) from creation. Omitted = no expiry. */
  readonly ttl?: number;
  /** Hint for polling clients (ms). */
  readonly pollInterval?: number;
  /** Optional human-readable initial status. */
  readonly statusMessage?: string;
}

// ============================================================================
// Handle
// ============================================================================

/**
 * Caller-facing handle returned by
 * {@link TasksHarnessProtocol.submit}. Same shape regardless of
 * whether the task originated locally or arrived over the MCP wire —
 * that's the "substrate-aware Tasks bridge" guarantee from ADR-23.
 *
 * `T` defaults to the canonical tool-handler return shape
 * (`readonly ContentBlock[]`) so the common "tool returns a task"
 * pattern types cleanly without type params.
 */
export interface TaskHandle<T = readonly ContentBlock[]> {
  readonly taskId: string;
  /** Status at handle construction; live state via `info()` or `events()`. */
  readonly initialStatus: TaskStatus;
  /**
   * Resolves on `completed` with the work function's return value.
   * Rejects with a typed {@link TaskRejection} on `failed` /
   * `cancelled` — callers `await` and `try/catch`, or chain via
   * `.result.then(...)` and handle the typed rejection.
   */
  readonly result: Promise<T>;
  /** Live snapshot. */
  info(): TaskInfo;
  /** Live event stream. Tears down on terminal status or harness close. */
  events(): AsyncIterable<TaskEvent>;
  /** Caller-driven cancel. No-op if already terminal. */
  cancel(reason?: string): Promise<void>;
}

/**
 * Tagged rejection shape thrown by {@link TaskHandle.result} on
 * non-completed terminal states.
 */
export interface TaskRejection {
  readonly _tag: "TaskRejection";
  readonly taskId: string;
  readonly status: "failed" | "cancelled";
  readonly failure?: TaskFailure;
}

// ============================================================================
// Developer-misuse error
// ============================================================================

/**
 * Thrown when a caller looks up or cancels a `taskId` the harness
 * doesn't know about. Distinct from `TaskRejection` because this is
 * developer misuse (typo, stale id, wrong harness) — not a semantic
 * task outcome.
 */
/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/remaining.js`. */
export { UnknownTaskError } from "../errors/remaining.js";

// ============================================================================
// Protocol
// ============================================================================

/**
 * TasksHarnessProtocol — per-session task registry.
 *
 * Concrete impls (`TasksHarness` in `@agentick/tasks-next`) extend
 * `BaseHarness<"tasks">` and inherit the cluster-friendly substrate
 * machinery (bus + journal + inbox + request-response correlation).
 * Adopter impls (stubs, fakes, future cluster-shimmed variants)
 * implement this protocol directly.
 */
export interface TasksHarnessProtocol {
  readonly id: string;
  /**
   * Cluster-portable inbox address — `${surface}:${scopeId}`.
   * `tasks-cancel` / `tasks-progress` inbox messages route here
   * (Phase B for MCP wire integration).
   */
  readonly address: string;
  /**
   * Resolves once the harness has finished async construction (inbox
   * registration). Callers MUST `await ready` before issuing
   * `submit()` to guarantee the registry is wired.
   */
  readonly ready: Promise<void>;

  /**
   * Register a work function as a managed task. Returns immediately
   * with a {@link TaskHandle}; the work runs concurrently.
   *
   * Work is invoked with a {@link TaskWorkContext} carrying:
   *   - `signal` — aborts on `cancel()` or harness close.
   *   - `onProgress(update)` — emits a progress event.
   *   - `setStatusMessage(msg)` — updates the task's status string.
   *
   * Work return → task transitions to `completed`; `result` resolves
   * with the return value.
   * Work throw → task transitions to `failed`; `result` rejects with
   * a {@link TaskRejection}.
   * `signal.aborted` → task transitions to `cancelled`; `result`
   * rejects with a `TaskRejection` of status `"cancelled"`.
   *
   * **Effect-typed work.** Work may return an `Effect<T, E, never>`.
   * On the Effect path the harness uses `Effect.runFork` and tracks
   * the resulting `Fiber`; `cancel()` calls `Fiber.interrupt` so
   * `Effect.sleep`, `Effect.async`, generator-based work, etc., are
   * actually interruptible — unlike the Promise path, where the
   * `AbortSignal` only flips a flag and underlying microtasks keep
   * running until they observe it. Use the Effect overload whenever
   * you want hard interruptibility guarantees on cancel; use the
   * Promise overload for plain async work that's happy to observe the
   * signal.
   *
   * The Effect's success value resolves `handle.result`. A typed
   * failure (`Effect.fail`) resolves to a `TaskRejection` of status
   * `"failed"`; a defect (`Effect.die`) likewise. Interruption (via
   * the cancel path OR an internal `Effect.interrupt`) transitions to
   * `cancelled`.
   */
  submit<T = readonly ContentBlock[]>(
    work: (ctx: TaskWorkContext) => Promise<T> | T,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;
  submit<T = readonly ContentBlock[], E = unknown>(
    work: (ctx: TaskWorkContext) => Effect.Effect<T, E, never>,
    opts?: TaskCreationInput,
  ): TaskHandle<T>;

  /** Snapshot. Returns `undefined` for unknown / expired task ids. */
  get(taskId: string): TaskInfo | undefined;

  /**
   * Snapshot every known task's {@link TaskInfo}. Scoped to this
   * harness — i.e., per-session when constructed via `withTasks()`.
   * The returned array is a frozen snapshot; mutations on records
   * after this call don't appear in the returned shape.
   *
   * Used by the model-facing `session_tasks_list` tool (auto-
   * registered by `withTasks()`) and by adopter code that wants to
   * surface in-flight work in a UI.
   */
  list(): readonly TaskInfo[];

  /**
   * Await a task's terminal state by id. Equivalent to
   * `submit(...).result` for the originator; useful for code paths
   * that received the id second-hand (cross-process, cross-tick).
   *
   * Throws {@link UnknownTaskError} synchronously when the id isn't
   * registered.
   */
  result<T = readonly ContentBlock[]>(taskId: string): Promise<T>;

  /**
   * Cancel by id. No-op if already terminal. Throws
   * {@link UnknownTaskError} for unknown ids.
   */
  cancel(taskId: string, reason?: string): Promise<void>;

  /** Snapshot status. `undefined` for unknown ids. */
  status(taskId: string): TaskStatus | undefined;

  /**
   * Live event stream for a task. Yields existing state + future
   * transitions, then closes on terminal status. Throws
   * {@link UnknownTaskError} for unknown ids.
   */
  events(taskId: string): AsyncIterable<TaskEvent>;

  /**
   * Cancel every in-flight task with reason `"harness_closed"` and
   * terminate the harness. Idempotent.
   */
  close(): Promise<void>;
}
