/**
 * `runTaskWorker` — the child-process **IPC driver** for by-ref tasks
 * (ADR 68 Build B). The child-side bootstrap the adopter's worker module
 * calls after registering its handlers:
 *
 * ```ts
 * // worker.ts — the adopter's `workerModule`
 * import { registerTaskHandler, runTaskWorker } from "@agentick/tasks";
 *
 * registerTaskHandler("deploy", async (ctx, input) => {
 *   const p = ctx.progress.begin({ total: 1 });
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
import { reasonOf, ulid } from "@agentick/utils";
import type {
  Elicit,
  ProgressUpdate,
  TaskRecord,
  TaskTransition,
  TaskWorkContext,
  TaskWorkVerbs,
} from "@agentick/spec";
import { createProgressBegin, deserializeAgentickError } from "@agentick/spec";
import { deriveContext, type ContextFacets, type RunOperationFn } from "@agentick/runtime";

import { defaultTaskHandlerRegistry, type TaskHandlerRegistry } from "./handler-registry.js";
import { assertInteractive } from "./task-elicit.js";
import type {
  ParentToWorkerMessage,
  WireElicitError,
  WorkerToParentMessage,
} from "./child-protocol.js";

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

/** A child-issued elicit awaiting the parent's IPC reply, keyed by requestId. */
interface PendingElicit {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/**
 * Reconstruct the error a child-side `ctx.elicit` should reject with from
 * its {@link WireElicitError}. A tagged error round-trips through the
 * codec (exact class + domain fields — `ElicitationDeclined.reason` etc.);
 * an untagged throw becomes a bare `Error` carrying the message.
 */
function reviveElicitError(wire: WireElicitError): unknown {
  return "serialized" in wire ? deserializeAgentickError(wire.serialized) : new Error(wire.message);
}

/**
 * Build the child's `ctx.elicit` (ADR 69 T2b) — a generic marshaling
 * {@link Elicit} Proxy. The child has a SEPARATE inbox, so it CANNOT
 * nest-`ask` the parent session directly. Instead each sugar method call
 * `(…args)` marshals a serializable INTENT `{method, args}` to the parent
 * over IPC; the parent reconstructs the live-schema request via the
 * injected sugar and escalates through the existing T1/T2a chain. The
 * `input_required` flip flows over IPC via `awaitingInput` (origin-side
 * flip; the `interactive ⊥ detached` guard applies through it).
 *
 * The live schema NEVER crosses: an arg that isn't structured-cloneable
 * (a `StandardSchemaV1` carries a live `validate()` function — e.g. a raw
 * `form(schema)` call) fails LOUD before any IPC, rather than hanging.
 */
function buildIpcElicit(deps: {
  readonly record: TaskRecord;
  readonly awaitingInput: TaskWorkContext["awaitingInput"];
  readonly pending: Map<string, PendingElicit>;
}): Elicit {
  const { record, awaitingInput, pending } = deps;

  const ipcElicit = (method: string, args: readonly unknown[]): Promise<unknown> => {
    if (typeof process.send !== "function" || process.connected !== true) {
      // A worker run standalone (or after the parent dropped the channel)
      // has no one to escalate to — fail loud rather than hang forever.
      return Promise.reject(
        new Error(
          `task ${record.taskId}: cannot escalate ctx.elicit.${method} — no live IPC channel to the parent`,
        ),
      );
    }
    const requestId = ulid();
    return new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      void send({ t: "elicit-request", requestId, method, args });
    });
  };

  return new Proxy({} as Elicit, {
    get(_target, prop): unknown {
      // Capability probes: a fully-wired forked task CAN do form/url
      // (the sugar constructs the request; the parent's client answers) —
      // parity with the in-process `buildElicitSugar` (both report true).
      if (prop === "canDoForm" || prop === "canDoUrl") return () => true;
      if (typeof prop !== "string") return undefined;
      const method = prop;
      return (...args: unknown[]): Promise<unknown> => {
        assertElicitArgsCloneable(record, method, args);
        // The first sugar arg is always the human-readable message.
        const message = typeof args[0] === "string" ? args[0] : undefined;
        return awaitingInput(
          ipcElicit(method, args),
          message !== undefined ? { message } : undefined,
        ) as Promise<unknown>;
      };
    },
  });
}

/**
 * The live-schema boundary guard (ADR 69 T2b). A `StandardSchemaV1`'s
 * `validate()` is a function → not structured-cloneable → it cannot cross
 * fork IPC. `structuredClone` (the same algorithm as the executor's
 * `serialization: "advanced"`) is the honest pre-send probe; on failure we
 * throw a clear boundary error rather than let the IPC send drop the frame
 * and hang the caller.
 */
function assertElicitArgsCloneable(
  record: TaskRecord,
  method: string,
  args: readonly unknown[],
): void {
  try {
    structuredClone(args);
  } catch {
    throw new Error(
      `task ${record.taskId}: a live-schema elicit ('${method}') can't cross the child-process boundary — ` +
        `its arguments aren't structured-cloneable (a StandardSchemaV1 carries a live validate() function). ` +
        `Use a sugar method (text/confirm/select/number/boolean) or run the task in-process.`,
    );
  }
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
  // In-flight child→parent elicits (ADR 69 T2b), correlated by requestId.
  // The parent's `elicit-response` / `elicit-error` settle the pending
  // Promise `buildIpcElicit` registered here.
  const pendingElicits = new Map<string, PendingElicit>();

  process.on("message", (message: ParentToWorkerMessage) => {
    if (message == null || typeof message !== "object") return;
    if (message.t === "cancel") {
      controller?.abort(message.reason ?? "cancelled");
      return;
    }
    if (message.t === "elicit-response") {
      const entry = pendingElicits.get(message.requestId);
      if (entry !== undefined) {
        pendingElicits.delete(message.requestId);
        entry.resolve(message.result);
      }
      return;
    }
    if (message.t === "elicit-error") {
      const entry = pendingElicits.get(message.requestId);
      if (entry !== undefined) {
        pendingElicits.delete(message.requestId);
        entry.reject(reviveElicitError(message.error));
      }
      return;
    }
    if (message.t === "start") {
      if (started) return; // one fork = one task
      started = true;
      void runOnce(
        registry,
        message.record,
        (c) => {
          controller = c;
        },
        pendingElicits,
      );
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
  pendingElicits: Map<string, PendingElicit>,
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

  // Same `working → input_required → working` flip as the in-process
  // executor, sent over IPC → parent → `report` → store + bus. The
  // parent's `applyTransition` ignores post-terminal reports, so a cancel
  // while paused wins and the `finally`'s `working` report is a no-op
  // there. A detached task cannot pause on client input
  // (`interactive ⊥ detached`, ADR 69). Hoisted out of the ctx literal so
  // `ctx.elicit` (ADR 69 T2b) composes its IPC bridge over it.
  const awaitingInput = ((
    input: Promise<unknown> | Effect.Effect<unknown, unknown, never>,
    opts?: { readonly message?: string },
  ) => {
    assertInteractive(record);
    void send({
      t: "transition",
      transition: {
        status: "input_required",
        ...(opts?.message !== undefined ? { statusMessage: opts.message } : {}),
      },
    });
    const restore = () => void send({ t: "transition", transition: { status: "working" } });
    // Effect overload — a real interruptible child fiber bound to the
    // worker's controller signal (aborted on cancel over IPC), mirroring
    // the in-process executor (ADR 69 T2a).
    if (Effect.isEffect(input)) {
      return Effect.runPromise(input as Effect.Effect<unknown, unknown, never>, {
        signal: controller.signal,
      }).finally(restore);
    }
    return Promise.resolve(input).finally(restore);
  }) as TaskWorkContext["awaitingInput"];

  const onProgress = (update: ProgressUpdate): void => {
    void send({ t: "transition", transition: { progress: update } });
  };
  const verbs: TaskWorkVerbs = {
    signal: controller.signal,
    // Progress / status-message updates funnel into the SAME transition
    // seam as the in-process executor — one field per report. Both progress
    // doors (`progress.begin()` and the raw `onProgress`) share that seam.
    progress: createProgressBegin(onProgress),
    onProgress,
    setStatusMessage: (message) => {
      void send({ t: "transition", transition: { statusMessage: message } });
    },
    awaitingInput,
    // Cross-process elicit escalation (ADR 69 T2b). A forked child has a
    // SEPARATE inbox, so `ctx.elicit` can't nest-`ask` the parent session
    // directly — this Proxy marshals each sugar call over IPC; the parent
    // (ChildProcessTaskExecutor) reconstructs the live-schema request and
    // escalates through the SAME T1/T2a chain (interception + lineage
    // apply for free). The `input_required` flip flows over IPC via
    // `awaitingInput`, which also enforces the `interactive ⊥ detached`
    // guard — a detached task's `ctx.elicit` throws before any IPC.
    elicit: buildIpcElicit({ record, awaitingInput, pending: pendingElicits }),
  };
  // ADR 91 §2 — compose the verbs over a trunk+facets ctx. A forked worker
  // has NO harness operation runner and cannot reach the parent's live
  // facets across the process boundary, so the facets are DEGRADED but
  // honestly typed: trunk from `record.scope` (carries the owning
  // `sessionId`), `log` dropped, `trace`/`metrics` collapse to the off-path
  // singletons, and `run`/`runner` THROW (no ladder in a bare child) rather
  // than silently no-op. The task still reads `ctx.sessionId`.
  // TODO(phase-3): bridge worker `ctx.log` frames back over IPC to the parent
  // bus so a worker task's logs correlate to its session.
  const workerFacets: ContextFacets = {
    log: () => {},
    namespace: "agentick",
    surface: "tasks",
    scope: record.scope,
    runOperation: (() => {
      throw new Error("ctx.run is unavailable in a worker task (no operation runner in the child)");
    }) as RunOperationFn,
  };
  const ctx: TaskWorkContext = deriveContext(record.scope, workerFacets, verbs);

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
