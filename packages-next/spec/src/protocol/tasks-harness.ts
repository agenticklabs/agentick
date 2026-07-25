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
import type { EventScope } from "../data/events.js";
import type { Elicit } from "./elicit-api.js";
import type { SendInput } from "./session-harness.js";

// ============================================================================
// FSM
// ============================================================================

/**
 * Task lifecycle states. Maps 1:1 onto MCP's task status enum so the
 * wire codec (Phase B) is a pass-through.
 *
 *   working          — task running.
 *   input_required   — task paused awaiting an out-of-band input
 *                      (elicit, sampling, roots, a webhook — anything
 *                      external). A work fn opts into this by wrapping
 *                      the pause in {@link TaskWorkContext.awaitingInput}:
 *                      the task flips `working → input_required` for the
 *                      duration of the awaited promise, then back to
 *                      `working` when it settles. Observers (the model
 *                      via `task_*`, a UI, an MCP client) read
 *                      it as "blocked on input, provide it" — distinct
 *                      from actively `working`.
 *   completed        — terminal; result available.
 *   failed           — terminal; `statusMessage` carries the error
 *                      summary, `failure` carries structured detail.
 *   cancelled        — terminal; caller-driven via `cancel()` OR
 *                      caused by `close()` / signal abort.
 *   interrupted      — terminal; ADR 68 orphan accounting. A `working`
 *                      record whose live executor is gone (harness
 *                      re-hydrated a store record with no reattachable
 *                      execution). Honest "we lost track of this," not
 *                      silently completed/failed. Has NO MCP-wire
 *                      representation (the MCP enum stops at `cancelled`)
 *                      — a codec crossing the wire lossy-maps it.
 */
export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  /**
   * Run `promise` in the `input_required` state: the task transitions
   * `working → input_required` (optionally with a `message` statusMessage) for the
   * duration of the pause, then back to `working` when it settles. Wrap ANY
   * external-input await — an elicitation, MCP sampling, a roots request, a webhook —
   * so observers (the model via `task_*`, a UI, an MCP client) can tell
   * "blocked on input, provide it" from "actively working". Restores `working` even
   * if `promise` rejects or the task is cancelled (via `finally`), so a throw can't
   * strand the task in `input_required`. Returns the resolved value (or rethrows).
   *
   * **Effect overload (real interruptibility).** Mirrors `submit`'s
   * Promise/Effect duality. When handed an `Effect<T, E, never>`, the
   * pause runs as a **real interruptible child fiber** bound to the
   * task's `signal`: a `cancel()` / ttl while paused natively
   * `Fiber.interrupt`s it, so `Effect.sleep`, `Effect.async` finalizers,
   * `Effect.onInterrupt`, and generator yields inside the pause actually
   * unwind — unlike the Promise overload, where the signal only flips a
   * flag the promise may ignore. Use the Effect overload whenever a pause
   * must hard-cancel (a long poll, a held resource, a nested request);
   * use the Promise overload for plain awaits happy to observe the
   * signal. Both overloads flip `working → input_required → working`
   * identically and both honor the `interactive ⊥ detached` guard.
   */
  awaitingInput<T>(promise: Promise<T>, opts?: { readonly message?: string }): Promise<T>;
  awaitingInput<T, E = unknown>(
    effect: Effect.Effect<T, E, never>,
    opts?: { readonly message?: string },
  ): Promise<T>;
  /**
   * Request input from the connected client while this task runs (ADR 69).
   * The same {@link Elicit} sugar surface a tool handler sees on
   * `ctx.elicit` (text / confirm / select / form / …) — but instead of
   * hitting a live per-tick elicitation, each call:
   *
   *   1. flips the task `working → input_required` (via {@link awaitingInput}),
   *   2. **escalates** the request up the ownership chain to the owning
   *      session and ultimately the client (nested `inbox.ask`), and
   *   3. resolves with the client's response, restoring `working`.
   *
   * **THROWS on a detached task.** A `detached: true` task has no
   * guaranteed live ancestor chain to reach the client, so `elicit` (and
   * `awaitingInput`) raise a typed `DetachedTaskCannotElicitError` rather
   * than hang against a dead inbox — `interactive ⊥ detached` (ADR 69).
   *
   * @see docs/proposals/v2/blueprint/69-request-escalation.md
   */
  readonly elicit: Elicit;
}

// ============================================================================
// Task-completion wake (TASK-WAKE seam)
// ============================================================================

/**
 * Bounded completion metadata handed to a {@link TaskWakePolicy} callback
 * and carried on the synthesized wake send. **Deliberately bounded** — it
 * carries the task's identity + terminal outcome, NEVER the raw result
 * blocks. A wake nudges the model to react ("your background task finished");
 * the model retrieves the actual output on its own via `task_get` /
 * `task_await` if it needs it. Dumping the raw output into the wake
 * would defeat the point (it would be an uncontrolled context injection) and
 * is not offered.
 */
export interface TaskWakeOutcome {
  readonly taskId: string;
  /** Terminal state — `completed` | `failed` | `interrupted` (never `working` / `input_required`). */
  readonly status: TaskStatus;
  /** Wall-clock ms from `createdAt` to the terminal transition. */
  readonly durationMs: number;
  /** Human-readable summary, if the task set one. */
  readonly statusMessage?: string;
  /** Structured failure detail (present when `status === "failed"`). */
  readonly failure?: TaskFailure;
}

/**
 * Per-task wake policy (TASK-WAKE seam) — the seam-over-setting knob for
 * "wake the session when this backgrounded task finishes while nothing is
 * observing it." A backgrounded (Pattern B) task that reaches a terminal
 * state UNOBSERVED synthesizes **exactly one** follow-up send into its owning
 * session (a real, journaled execution), waking the model to react.
 *
 *   - `true`  — the framework synthesizes a default bounded-metadata wake
 *               (a user-role message naming the task, its terminal status,
 *               and duration; NO raw output).
 *   - a callback `(outcome) => SendInput | null` — the adopter SHAPES the
 *               wake (custom message / props / maxTicks / model override) or
 *               SUPPRESSES it entirely by returning `null`. The callback runs
 *               ONLY when the completion is actually going to wake (unobserved
 *               + not during harness close), i.e. it is never invoked for a
 *               wake that was consumed by an in-band read.
 *   - `false` / omitted — no wake (today's behavior).
 *
 * **Consume-on-observe.** The wake is CONSUMED (never fires) if the completion
 * is seen in-band first — the model called `task_await` (a
 * `result(taskId)` read) or `task_get` / `status(taskId)` and saw the
 * terminal state, or the task was explicitly cancelled. Exactly-once holds
 * between the in-band and out-of-band paths.
 *
 * **Runtime-local.** A wake policy is process-local runtime state; it is NOT
 * persisted on the {@link TaskRecord} and does NOT survive snapshot/hydration.
 * A detached task that outlives its process and is later rehydrated does not
 * wake — its completion remains observable via the durable task store.
 */
export type TaskWakePolicy = boolean | ((outcome: TaskWakeOutcome) => SendInput | null);

export interface TaskCreationInput {
  /** TTL (ms) from creation. Omitted = no expiry. */
  readonly ttl?: number;
  /** Hint for polling clients (ms). */
  readonly pollInterval?: number;
  /** Optional human-readable initial status. */
  readonly statusMessage?: string;
  /**
   * ADR 68 lifetime opt-out. `false` (default) — the task is aborted on
   * the spawning session's `close()` (today's behavior). `true` — NOT
   * aborted on close; the executor + durable record persist
   * independently (the session can stop and it continues, as long as the
   * app process is alive with the in-memory store; across app restart
   * needs a durable store).
   */
  readonly detached?: boolean;
  /**
   * Submit input persisted on the {@link TaskRecord} for audit / replay,
   * and the payload a by-ref executor (child / worker) resolves work
   * with. Ignored by the in-process executor (it runs the closure).
   */
  readonly input?: unknown;
  /**
   * Reference a registered handler for an out-of-process executor —
   * child / worker tasks require a referenceable handler, not an inline
   * closure (closures can't cross the process boundary). Unused by the
   * in-process default.
   */
  readonly handlerRef?: string;
  /**
   * Which registered {@link import("./tasks-store.js").TaskExecutor} runs
   * this task (ADR 68 Build B). Omitted → `"in-process"` (the bundled
   * default). A by-ref executor (e.g. `"child-process"`) additionally
   * requires {@link handlerRef} — the closure can't cross the process
   * boundary, so the far side resolves the work from its handler
   * registry. Selection is per-submit; the harness dispatches on
   * `record.executorKind` at hydration / reattach.
   */
  readonly executorKind?: string;
  /**
   * Originating-session scope stamped on the {@link TaskRecord} — the
   * task's owner, and the address escalation ({@link Elicit}) routes from.
   * Omitted → the harness's own `parentScope` (a per-session harness's
   * `{ sessionId }`). Pass it when ONE app-scoped `TasksHarness` serves
   * MANY sessions: the record is the source of truth (ADR 68), so a task's
   * `ctx.elicit` escalates to `record.scope.sessionId`, not the harness's
   * scope — each session's tasks reach their own client.
   */
  readonly scope?: EventScope;
  /**
   * Task-completion wake policy (TASK-WAKE seam). When set (and not consumed
   * by an in-band read), an unobserved terminal transition synthesizes
   * exactly one follow-up send into the task's owning session. See
   * {@link TaskWakePolicy}. Omitted → the harness's `defaultWake` (if any),
   * else no wake.
   */
  readonly wake?: TaskWakePolicy;
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
  /**
   * Live event stream — `for await (const ev of handle.events())`.
   * Tears down on terminal status or harness close.
   */
  events(): AsyncIterable<TaskEvent>;
  /** Caller-driven cancel. No-op if already terminal. */
  cancel(reason?: string): Promise<void>;
}

/**
 * Structural type guard for a {@link TaskHandle}. Distinguishes a
 * Pattern B return from inline `ContentBlock[]` / `Promise` / `Effect`
 * results without an `instanceof` check (handles may originate from
 * any TasksHarness implementation, including remote MCP proxies).
 *
 * Used by the tool-executor's task-mode resolver and by the
 * mcp-next/server tasks projection (#171d.3) to detect Pattern B
 * handler returns and route them to the MCP task wire.
 */
export function isTaskHandle(value: unknown): value is TaskHandle<readonly ContentBlock[]> {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<TaskHandle<readonly ContentBlock[]>>;
  return (
    typeof v.taskId === "string" &&
    typeof v.initialStatus === "string" &&
    typeof (v as { result?: unknown }).result === "object" &&
    typeof v.cancel === "function"
  );
}

/**
 * Tagged rejection shape thrown by {@link TaskHandle.result} on
 * non-completed terminal states.
 */
export interface TaskRejection {
  readonly _tag: "TaskRejection";
  readonly taskId: string;
  readonly status: "failed" | "cancelled" | "interrupted";
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
  /**
   * By-ref submit (ADR 68 Build B) — no closure. A by-ref executor
   * (`executorKind: "child-process"`, …) resolves `handlerRef` from its
   * own handler registry on the far side; the closure overloads can't be
   * used because a closure doesn't cross a process / node boundary. Both
   * `handlerRef` and `executorKind` are mandatory in this form.
   */
  submit<T = readonly ContentBlock[]>(
    opts: TaskCreationInput & { readonly handlerRef: string; readonly executorKind: string },
  ): TaskHandle<T>;

  /** Snapshot. Returns `undefined` for unknown / expired task ids. */
  get(taskId: string): TaskInfo | undefined;

  /**
   * Snapshot every known task's {@link TaskInfo}. Scoped to this
   * harness — i.e., per-session when constructed via `withTasks()`.
   * The returned array is a frozen snapshot; mutations on records
   * after this call don't appear in the returned shape.
   *
   * Used by the model-facing `task_list` tool (auto-
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

/**
 * Adopter-facing alias for the tasks protocol. Use `Tasks` in public
 * APIs and `withX` slot signatures; reserve `TasksHarnessProtocol` for
 * internal/framework code that wants to speak in spec-vocabulary. The
 * two are structurally identical — `Tasks` is the noun-form chosen
 * for ergonomics per ADR 42 (the `Harness`-word stays out of adopter
 * surfaces).
 *
 * NOTE: per ADR 42 §"What this ADR does NOT decide", `withTasks` does
 * NOT accept the full slot trichotomy — the per-session
 * `TasksHarness` is owned by the parent `AppHarness` (single-
 * construction-site #159), not by `withTasks`. The alias exists for
 * downstream consumers that DO take a `Tasks` instance directly
 * (e.g., adapters wiring into `bridges.tasks` outside the standard
 * extension path).
 */
export type Tasks = TasksHarnessProtocol;

/**
 * Structural type guard for a `Tasks` instance. Returns `true` for
 * objects exposing the live `TasksHarnessProtocol` method surface
 * (`submit`, `list`, `events`, `close`).
 */
export function isTasksInstance(v: unknown): v is Tasks {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.submit === "function" &&
    typeof obj.list === "function" &&
    typeof obj.events === "function" &&
    typeof obj.close === "function"
  );
}
