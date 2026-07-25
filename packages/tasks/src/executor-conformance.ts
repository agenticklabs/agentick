/**
 * Conformance suite for {@link TaskExecutor} strategies (ADR 68 Build B).
 *
 * The proof that the executor seam is honestly UNIFORM — the bundled
 * {@link InProcessTaskExecutor} (closure handlers) and
 * {@link ChildProcessTaskExecutor} (by-ref handlers over IPC) BOTH pass
 * the SAME behavioral suite, driven through a real {@link TasksHarness}.
 * A future sandbox / distributed-worker executor runs it too.
 *
 * The suite is parameterized by a `setup` that decouples it from the
 * closure-vs-by-ref distinction: the caller expresses each canonical
 * behavior (`echo` / `progress` / `thrower` / `slow`) as a `submit`
 * against the harness — a closure for the in-process executor, a
 * `handlerRef` for a by-ref executor — and the suite asserts the observed
 * lifecycle. Mirrors `runTaskStoreConformance` / `runTasksHarnessConformance`.
 *
 * ```ts
 * runTaskExecutorConformance({
 *   label: "in-process",
 *   setup: async () => {
 *     const bundle = await fakeTasks();
 *     return {
 *       harness: bundle.harness,
 *       close: bundle.close,
 *       submit: (kase, input) => bundle.harness.submit(closureFor(kase, input)),
 *     };
 *   },
 * });
 * ```
 */

import { describe, expect, it } from "vitest";

import { drainRejection } from "@agentick/utils/testing";
import type { TaskEvent, TaskHandle, TasksHarnessProtocol } from "@agentick/spec";

/** The four canonical behaviors every executor strategy must exhibit. */
export type TaskExecutorCase = "echo" | "progress" | "thrower" | "slow";

export interface TaskExecutorConformanceHarness {
  /** The harness the executor is registered on (for status / events reads). */
  readonly harness: TasksHarnessProtocol;
  /**
   * Submit a canonical case. `echo` returns its `input` as text; the
   * suite passes a probe string it later asserts on. `progress` emits ≥3
   * ordered progress updates then completes; `thrower` fails; `slow` runs
   * until cancelled (honoring the abort signal).
   */
  submit(kase: TaskExecutorCase, input?: unknown): TaskHandle;
  close(): Promise<void>;
}

export interface TaskExecutorConformanceOptions {
  /** Display label (`describe` heading). */
  readonly label: string;
  /** Fresh, isolated harness + submit adapter per test. */
  readonly setup: () => Promise<TaskExecutorConformanceHarness>;
  /**
   * Skip the whole suite (e.g. a by-ref executor whose worker loader is
   * unavailable in the test env). Registers as skipped, never runs setup.
   */
  readonly skip?: boolean;
}

async function collectEvents(handle: TaskHandle): Promise<readonly TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

export function runTaskExecutorConformance(opts: TaskExecutorConformanceOptions): void {
  const suite = opts.skip ? describe.skip : describe;

  suite(`TaskExecutor conformance — ${opts.label}`, () => {
    it("submit → completed; result round-trips the work's return value", async () => {
      const shell = await opts.setup();
      try {
        const handle = shell.submit("echo", "round-trip-payload");
        const result = await handle.result;
        expect(result).toEqual([{ type: "text", text: "round-trip-payload" }]);
        expect(shell.harness.status(handle.taskId)).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("progress reports arrive over the stream in order", async () => {
      const shell = await opts.setup();
      try {
        const handle = shell.submit("progress");
        const events = await collectEvents(handle);
        const progress = events.filter(
          (e): e is Extract<TaskEvent, { kind: "progress" }> => e.kind === "progress",
        );
        expect(progress.length).toBeGreaterThanOrEqual(3);
        // Monotonic non-decreasing `current` — ordered delivery, not raced.
        const currents = progress.map((p) => p.current);
        expect(currents).toEqual([...currents].sort((a, b) => a - b));
        await handle.result;
        expect(shell.harness.status(handle.taskId)).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("work throws → failed with a reason", async () => {
      const shell = await opts.setup();
      try {
        const handle = shell.submit("thrower");
        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "failed",
        });
        expect(shell.harness.status(handle.taskId)).toBe("failed");
        expect(shell.harness.get(handle.taskId)?.failure?.reason).toBeTruthy();
      } finally {
        await shell.close();
      }
    });

    it("cancel → cancelled + settled", async () => {
      const shell = await opts.setup();
      try {
        const handle = shell.submit("slow");
        // Drain at birth — a by-ref cancel awaits the child's exit, a gap
        // long enough for vitest to flag the late-attached rejection.
        const drained = drainRejection(handle.result);
        // Let the work register its abort listener / the child spin up.
        await new Promise((r) => setTimeout(r, 20));
        await shell.harness.cancel(handle.taskId, "conformance-cancel");
        expect(await drained).toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "cancelled",
        });
        expect(shell.harness.status(handle.taskId)).toBe("cancelled");
      } finally {
        await shell.close();
      }
    });
  });
}
