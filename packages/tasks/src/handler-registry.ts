/**
 * `TaskHandlerRegistry` — the transport-agnostic **resolve-work-by-ref**
 * layer for by-ref {@link TaskExecutor}s (ADR 68 Build B).
 *
 * A by-ref executor (child-process now; a distributed queue worker
 * later) can't accept an inline closure — a closure doesn't cross a
 * process / node boundary. Instead the submit carries a `handlerRef`
 * string; the far side resolves it to the actual work function through
 * THIS registry. The authoring surface —
 * {@link registerTaskHandler} — is where the input/result generics earn
 * their keep (the bare `TaskExecutor` port is non-generic; the `define`
 * energy belongs at the handler layer, not the store / executor ports).
 *
 * **Deliberately transport-independent.** This module knows nothing
 * about `child_process`, IPC, or `process.on("message")`. The
 * child-process transport ({@link import("./worker.js").runTaskWorker})
 * is built ON TOP of this registry and supplies its own driver. A future
 * distributed executor reuses the SAME registry + the SAME
 * `(ctx, input) => …` handler contract and supplies its own driver (a
 * `boss.work(...)` loop, a queue consumer, …) in place of
 * `runTaskWorker`. Do not bake IPC assumptions in here.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md §"Executor 2"
 */

import type { Effect } from "effect";
import type { ContentBlock, TaskWorkContext } from "@agentick/spec";

/**
 * A by-ref task handler — the work run on the far side of a by-ref
 * executor, resolved from a {@link TaskHandlerRegistry} by its ref.
 *
 * Symmetric with the in-process `TaskWork` closure but with an explicit
 * `input` parameter: a by-ref executor hands the handler the persisted
 * `record.input` (the `TaskWorkContext` has no input slot). Promise /
 * sync OR Effect-flavored — the driver runs an Effect via
 * `Effect.runPromise`, matching the in-process executor's Effect path.
 */
export type TaskHandlerWork<I = unknown, O = readonly ContentBlock[]> = (
  ctx: TaskWorkContext,
  input: I,
) => Promise<O> | O | Effect.Effect<O, unknown, never>;

/**
 * A map of `handlerRef` → work, populated at module load on the far side
 * (the adopter's worker module registers its handlers, then hands the
 * registry to its driver). Plain in-memory map — a registry instance per
 * worker process is the norm; the module-level default
 * ({@link registerTaskHandler}) covers the common single-registry case.
 */
export class TaskHandlerRegistry {
  private readonly handlers = new Map<string, TaskHandlerWork>();

  /** Register `work` under `ref`. A later register of the same ref replaces. */
  register<I = unknown, O = readonly ContentBlock[]>(
    ref: string,
    work: TaskHandlerWork<I, O>,
  ): void {
    this.handlers.set(ref, work as TaskHandlerWork);
  }

  /** Resolve a ref to its work, or `undefined` when unregistered. */
  get(ref: string): TaskHandlerWork | undefined {
    return this.handlers.get(ref);
  }

  /** Is `ref` registered? */
  has(ref: string): boolean {
    return this.handlers.has(ref);
  }

  /** Registered refs — diagnostics / "no handler for ref" error context. */
  refs(): readonly string[] {
    return [...this.handlers.keys()];
  }
}

/**
 * The process-wide default registry. A worker module that just calls
 * `registerTaskHandler(...)` at top level then `runTaskWorker()` uses
 * this one implicitly — the common single-registry case. Pass an
 * explicit {@link TaskHandlerRegistry} to `runTaskWorker` (or a future
 * driver) when you need isolated registries.
 */
const DEFAULT_REGISTRY = new TaskHandlerRegistry();

/**
 * Register a by-ref task handler on the process-wide default registry.
 * The authoring surface for child / worker tasks — the `I` / `O`
 * generics thread the input + result types the non-generic
 * `TaskExecutor` port can't.
 *
 * ```ts
 * registerTaskHandler<{ target: string }, readonly ContentBlock[]>(
 *   "deploy",
 *   async (ctx, input) => {
 *     ctx.onProgress({ current: 0, total: 1, message: `deploying ${input.target}` });
 *     await deploy(input.target, ctx.signal);
 *     return [{ type: "text", text: "deployed" }];
 *   },
 * );
 * ```
 */
export function registerTaskHandler<I = unknown, O = readonly ContentBlock[]>(
  ref: string,
  work: TaskHandlerWork<I, O>,
): void {
  DEFAULT_REGISTRY.register(ref, work);
}

/** The process-wide default registry `registerTaskHandler` writes to. */
export function defaultTaskHandlerRegistry(): TaskHandlerRegistry {
  return DEFAULT_REGISTRY;
}
