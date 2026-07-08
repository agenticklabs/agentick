/**
 * `ChildProcessTaskExecutor` — the second bundled {@link TaskExecutor}
 * strategy (ADR 68 Build B): run a task in a forked Node child for
 * **execution isolation** (CPU-heavy / crash-risky work off the main
 * event loop, independently killable) and — because the {@link TaskStore}
 * is app-scoped — survival of the spawning session's close.
 *
 * **By-ref (`byRef = true`).** A closure can't cross a process boundary,
 * so this executor IGNORES the `work` closure and instead hands the child
 * a **serializable descriptor** — the {@link TaskRecord} (already
 * serializable by construction; `handlerRef` + `input` live on it). The
 * child ({@link import("./worker.js").runTaskWorker}) resolves
 * `handlerRef` from its handler registry, runs it, and reports
 * status / progress / result back over IPC → parent → the uniform
 * `report` seam. The harness validates that a by-ref submit carries a
 * `handlerRef` before ever forking (`TaskHandlerRefRequiredError`).
 *
 * **App-scoped instance.** The harness / app inject ONE instance shared
 * across sessions; its `children` map outlives any single session, so a
 * `detached` child survives `harness.close()` and can be
 * {@link reattach}ed WITHIN the app process. Cross-app-restart reattach
 * needs a durable store + a pid on `record.executorState` —
 * TODO(ADR-68 pg).
 *
 * **The adopter owns the loader.** `forkOptions` is passed straight to
 * `fork` — the executor hardcodes NO `execArgv` / loader. A TS worker
 * under `tsx` passes `{ execArgv: ["--import", "tsx"] }`; a built worker
 * passes nothing. That's the adopter's build concern, not ours.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md §"Executor 2"
 */

import { fork, type ChildProcess, type ForkOptions } from "node:child_process";

import { omitUndefined } from "@agentick/utils-next";
import type {
  TaskExecution,
  TaskExecutor,
  TaskRecord,
  TaskReport,
  TaskStatus,
  TaskWork,
} from "@agentick/spec-next";

import type { ParentToWorkerMessage, WorkerToParentMessage } from "./child-protocol.js";

/** Default grace period between a cooperative `cancel` and the SIGKILL backstop. */
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface ChildProcessTaskExecutorOptions {
  /**
   * Absolute path to the adopter's worker entrypoint — a module that
   * registers its handlers (`registerTaskHandler(...)`) then calls
   * `runTaskWorker()`. `fork`ed once per submit.
   */
  readonly workerModule: string;
  /**
   * Merged over the executor's defaults (`{ serialization: "advanced" }`)
   * and passed to `fork` — the ADOPTER controls `execArgv` / loaders for
   * their build (the executor hardcodes no loader). Example for a TS worker
   * under `tsx`: `{ execArgv: ["--import", "tsx"] }`. Fork does NOT set
   * `silent` — a chatty worker's stdout/stderr flow to the parent; pass
   * `{ silent: true }` to isolate them. Override `serialization: "json"`
   * only if you specifically need JSON-wire semantics.
   */
  readonly forkOptions?: ForkOptions;
  /**
   * ms between the cooperative `{ t: "cancel" }` and the `SIGKILL`
   * backstop for a child that ignores it. Default {@link
   * DEFAULT_KILL_GRACE_MS}.
   */
  readonly killGracePeriodMs?: number;
}

/** The per-task child handle (executor-private; opaque to the harness). */
interface ChildHandle {
  readonly taskId: string;
  readonly child: ChildProcess;
  /** Current report sink — reassigned on {@link ChildProcessTaskExecutor.reattach}. */
  report: TaskReport;
  /** A terminal transition was reported (or the child exited) — stop reporting. */
  settled: boolean;
  /** Resolves on the child's `exit` — the settled-cancel / teardown barrier. */
  readonly exited: Promise<void>;
  /** In-flight cancel dedupe — a harness cancel triggers cancel via BOTH the
   * abort listener AND `executor.cancel`; both share this one teardown. */
  cancelling?: Promise<void>;
}

/** Child-process execution handle — carries the `taskId` for map lookup on cancel. */
interface ChildProcessExecution extends TaskExecution {
  readonly kind: "child-process";
  readonly taskId: string;
}

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export class ChildProcessTaskExecutor implements TaskExecutor {
  readonly kind = "child-process";
  readonly byRef = true;

  private readonly workerModule: string;
  private readonly forkOptions: ForkOptions;
  private readonly killGracePeriodMs: number;
  /** App-scoped live children — outlives sessions (detached-survives-close). */
  private readonly children = new Map<string, ChildHandle>();

  constructor(options: ChildProcessTaskExecutorOptions) {
    this.workerModule = options.workerModule;
    this.forkOptions = options.forkOptions ?? {};
    this.killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
  }

  start(
    record: TaskRecord,
    _work: TaskWork,
    report: TaskReport,
    signal: AbortSignal,
  ): TaskExecution {
    // `serialization: "advanced"` (V8 structured clone) as the DEFAULT, not
    // fork's `"json"` default: task `input` + result are commonly
    // `ContentBlock[]` (image/binary blocks, `Date`s, `Map`s) — JSON would
    // silently mangle those. Structured clone round-trips them faithfully.
    // The adopter can still override via `forkOptions.serialization`.
    const child = fork(this.workerModule, [], { serialization: "advanced", ...this.forkOptions });

    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const handle: ChildHandle = { taskId: record.taskId, child, report, settled: false, exited };
    this.children.set(record.taskId, handle);

    child.on("message", (message: WorkerToParentMessage) => {
      if (message == null || message.t !== "transition") return;
      if (handle.settled) return;
      const transition = message.transition;
      if (transition.status !== undefined && isTerminalStatus(transition.status)) {
        handle.settled = true;
      }
      handle.report(transition);
    });

    child.on("exit", (code, sig) => {
      this.children.delete(record.taskId);
      if (!handle.settled) {
        // Died mid-work with no terminal transition → surface as failed,
        // honestly (crash / OOM / unexpected exit).
        handle.settled = true;
        handle.report({
          status: "failed",
          failure: {
            kind: "error",
            reason: `worker exited (code ${code ?? "null"}${sig ? `, signal ${sig}` : ""})`,
          },
        });
      }
      resolveExit();
    });

    const execution: ChildProcessExecution = { kind: this.kind, taskId: record.taskId };

    // Register the abort listener SYNCHRONOUSLY (the seam's contract) so a
    // harness-side abort (cancel / non-detached close) also tears the
    // child down. AbortSignal listeners don't fire if attached post-abort.
    if (signal.aborted) {
      void this.teardown(handle, abortReason(signal));
    } else {
      signal.addEventListener("abort", () => void this.teardown(handle, abortReason(signal)), {
        once: true,
      });
    }

    // Hand the child its serializable descriptor. `record` has no live
    // handles (ADR 68) → structured-clone-trivial over IPC.
    this.send(child, { t: "start", record });

    return execution;
  }

  reattach(record: TaskRecord, report: TaskReport): TaskExecution | undefined {
    const handle = this.children.get(record.taskId);
    if (handle === undefined || handle.settled || handle.child.connected !== true) {
      // No live child in THIS process → harness marks it `interrupted`.
      // Cross-app-restart reattach (by pid on record.executorState) needs
      // a durable store. TODO(ADR-68 pg).
      return undefined;
    }
    handle.report = report; // re-wire the sink; the message handler reads it live
    const execution: ChildProcessExecution = { kind: this.kind, taskId: record.taskId };
    return execution;
  }

  cancel(execution: TaskExecution, reason?: string): Promise<void> {
    const handle = this.children.get((execution as ChildProcessExecution).taskId);
    if (handle === undefined) return Promise.resolve(); // already exited
    return this.teardown(handle, reason);
  }

  /**
   * Cooperative-then-forced teardown: send `{ t: "cancel" }` (the child
   * aborts its local signal so signal-honoring work cleans up), then
   * `SIGKILL` after the grace period as a backstop for a child that
   * ignores it. Returns the exit-ack Promise so the harness's
   * `await executor.cancel()` preserves settled-cancel semantics (parity
   * with the in-process Effect interrupt path). Idempotent — a harness
   * cancel fires this via both the abort listener and `executor.cancel`.
   */
  private teardown(handle: ChildHandle, reason?: string): Promise<void> {
    if (handle.cancelling !== undefined) return handle.cancelling;
    if (handle.child.connected === true) {
      this.send(handle.child, { t: "cancel", ...omitUndefined({ reason }) });
    }
    const killTimer = setTimeout(() => {
      if (handle.child.killed !== true) handle.child.kill("SIGKILL");
    }, this.killGracePeriodMs);
    // Don't let the backstop timer keep the parent event loop alive.
    killTimer.unref?.();
    const done = handle.exited.then(() => {
      clearTimeout(killTimer);
    });
    handle.cancelling = done;
    return done;
  }

  private send(child: ChildProcess, message: ParentToWorkerMessage): void {
    // Best-effort — a send after the channel closed (child already exited)
    // is not fatal; the exit handler has already reported terminal state.
    if (child.connected !== true) return;
    child.send(message, (_err) => undefined);
  }

  /**
   * Live child count — diagnostics only (tests assert a SIGKILL'd child
   * actually left the map). NOT a control-flow surface. Mirrors
   * `TasksHarness.pendingCount`.
   */
  activeChildCount(): number {
    return this.children.size;
  }
}

/** Human-readable abort reason from a signal (string reason or fallback). */
function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return "cancelled";
}
