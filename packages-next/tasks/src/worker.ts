/**
 * `runTaskWorker` — the child-process **IPC driver** for by-ref tasks
 * (ADR 68 Build B). The child-side bootstrap the adopter's worker module
 * calls after registering its handlers:
 *
 * ```ts
 * // worker.ts — the adopter's `workerModule`
 * import { registerTaskHandler, runTaskWorker } from "@agentick/tasks-next";
 *
 * registerTaskHandler("deploy", async (ctx, input) => {
 *   ctx.onProgress({ current: 0, total: 1 });
 *   await deploy(input, ctx.signal);
 *   return [{ type: "text", text: "deployed" }];
 * });
 *
 * runTaskWorker(); // drives process.on("message"); one task per fork
 * ```
 *
 * **This is the transport.** It sits ON TOP of the transport-agnostic
 * {@link TaskHandlerRegistry} — resolve-work-by-ref is the reusable
 * piece; `process.on("message")` is the child-process-IPC driver bolted
 * onto it. A future distributed executor reuses the same registry with
 * its own driver (a queue consumer loop) in place of this function.
 *
 * **One fork = one task.** The {@link ChildProcessTaskExecutor} forks a
 * fresh child per submit, so the worker services exactly one `start`,
 * reports its terminal transition, and exits. This keeps the child a
 * clean isolation boundary (crash-risky / CPU-heavy work can't corrupt a
 * sibling task) and makes cleanup trivial (exit = done).
 *
 * **Flush discipline (load-bearing).** `process.send` is async over IPC;
 * a naive `process.send(terminal); process.exit(0)` can drop the last
 * message and leave the parent's `result()` hung forever. Every send
 * here awaits the send callback (the OS accepted the frame) BEFORE the
 * next step, and the terminal send is awaited before `process.exit`.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md §"Executor 2"
 */

import { Effect } from "effect";
import { reasonOf } from "@agentick/utils-next";
import type { TaskRecord, TaskTransition, TaskWorkContext } from "@agentick/spec-next";

import { defaultTaskHandlerRegistry, type TaskHandlerRegistry } from "./handler-registry.js";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "./child-protocol.js";

/**
 * Send a {@link WorkerToParentMessage} and resolve once the IPC channel
 * has accepted the frame (the send callback fired). Awaiting this before
 * `process.exit` is the flush discipline that keeps terminal transitions
 * from being dropped. Resolves immediately when there's no IPC channel
 * (worker run standalone) so a mis-run worker doesn't hang.
 */
function send(message: WorkerToParentMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof process.send !== "function" || process.connected !== true) {
      resolve();
      return;
    }
    // The 3-arg send callback fires when the frame is flushed to the OS.
    process.send(message, (_err) => resolve());
  });
}

/**
 * Bootstrap a by-ref task worker: register `process.on("message")`, and
 * on the first `start`, reconstruct a {@link TaskWorkContext}, resolve
 * `record.handlerRef` from `registry`, run it, and report the terminal
 * transition over IPC before exiting.
 *
 * @param registry Handler source. Defaults to the process-wide registry
 *   {@link registerTaskHandler} writes to.
 */
export function runTaskWorker(registry: TaskHandlerRegistry = defaultTaskHandlerRegistry()): void {
  // Local abort controller — a parent `{ t: "cancel" }` aborts it, so
  // signal-honoring handlers clean up. Assigned when `start` arrives.
  let controller: AbortController | undefined;
  let started = false;

  process.on("message", (message: ParentToWorkerMessage) => {
    if (message == null || typeof message !== "object") return;
    if (message.t === "cancel") {
      controller?.abort(message.reason ?? "cancelled");
      return;
    }
    if (message.t === "start") {
      if (started) return; // one fork = one task
      started = true;
      void runOnce(registry, message.record, (c) => {
        controller = c;
      });
    }
  });

  // Parent gone → self-terminate; do NOT run headless. A forked worker
  // CANNOT re-attach to a new parent over fork IPC (the channel is a
  // spawn-time pipe inherited via NODE_CHANNEL_FD — not reconnectable by a
  // fresh process). So if the IPC channel disconnects (the app process died
  // / closed it) we abort in-flight work and exit rather than run orphaned
  // and unobservable; the parent honestly reconciles the durable record to
  // `interrupted` on restart. True cross-restart reattach requires a
  // reconnectable transport (worker reports via the shared store / cluster
  // bus) — the distributed-executor tier, NOT this fork-IPC driver.
  process.on("disconnect", () => {
    controller?.abort("parent_disconnected");
    process.exit(1);
  });
}

/**
 * Service exactly one task: resolve the handler, run it, report a single
 * terminal transition, and exit. Progress / status-message updates fan
 * out mid-flight via the ctx callbacks.
 */
async function runOnce(
  registry: TaskHandlerRegistry,
  record: TaskRecord,
  bindController: (controller: AbortController) => void,
): Promise<void> {
  const ref = record.handlerRef;
  const work = ref !== undefined ? registry.get(ref) : undefined;
  if (work === undefined) {
    await send({
      t: "transition",
      transition: {
        status: "failed",
        failure: {
          kind: "error",
          reason: `no handler for ref ${String(ref)} (registered: ${registry.refs().join(", ") || "none"})`,
        },
      },
    });
    process.exit(0);
    return;
  }

  const controller = new AbortController();
  bindController(controller);

  const ctx: TaskWorkContext = {
    signal: controller.signal,
    // Progress / status-message updates funnel into the SAME transition
    // seam as the in-process executor — one field per report.
    onProgress: (update) => {
      void send({ t: "transition", transition: { progress: update } });
    },
    setStatusMessage: (message) => {
      void send({ t: "transition", transition: { statusMessage: message } });
    },
  };

  let terminal: TaskTransition;
  try {
    const ret = work(ctx, record.input);
    const result = Effect.isEffect(ret)
      ? await Effect.runPromise(ret as Effect.Effect<unknown, unknown, never>)
      : await ret;
    // A handler that resolves AFTER observing an abort still settles as
    // cancelled — the caller's cancel wins, matching the in-process
    // "cancel wins the race" semantics (the parent already applied the
    // cancelled transition; this is a post-terminal no-op there).
    terminal = controller.signal.aborted
      ? {
          status: "cancelled",
          failure: { kind: "aborted", reason: abortReason(controller.signal) },
        }
      : { status: "completed", result };
  } catch (thrown) {
    terminal = controller.signal.aborted
      ? {
          status: "cancelled",
          failure: { kind: "aborted", reason: abortReason(controller.signal) },
        }
      : { status: "failed", failure: { kind: "error", reason: reasonOf(thrown) } };
  }

  // Flush the terminal transition BEFORE exit — a dropped terminal frame
  // hangs the parent's `result()` forever.
  await send({ t: "transition", transition: terminal });
  process.exit(0);
}

/** Human-readable abort reason from a signal (string reason or fallback). */
function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  return typeof reason === "string" ? reason : reasonOf(reason ?? "cancelled");
}
