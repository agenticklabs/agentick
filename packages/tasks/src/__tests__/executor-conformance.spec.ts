/**
 * `runTaskExecutorConformance` driven against BOTH bundled executor
 * strategies (ADR 68 Build B) — the proof the seam is honestly uniform:
 *
 *   - `InProcessTaskExecutor` — closure handlers (the default).
 *   - `ChildProcessTaskExecutor` — by-ref handlers over a REAL forked
 *     child (the `tsx` fixture worker), round-tripping over IPC.
 *
 * Same behavioral suite, two strategies, both green.
 */

import { fileURLToPath } from "node:url";

import type { ContentBlock, TaskHandle } from "@agentick/spec";

import { runTaskExecutorConformance, type TaskExecutorCase } from "../executor-conformance.js";
import { ChildProcessTaskExecutor } from "../child-executor.js";
import { fakeTasks } from "../testing/fake-tasks.js";

const WORKER_MODULE = fileURLToPath(new URL("./fixtures/task-worker.ts", import.meta.url));

// ── In-process (closure handlers) ────────────────────────────────────
runTaskExecutorConformance({
  label: "in-process",
  setup: async () => {
    const bundle = await fakeTasks();
    return {
      harness: bundle.harness,
      close: bundle.close,
      submit: (kase: TaskExecutorCase, input?: unknown): TaskHandle => {
        switch (kase) {
          case "echo":
            return bundle.harness.submit(async () => [
              { type: "text", text: String(input) } as ContentBlock,
            ]);
          case "progress":
            return bundle.harness.submit(async ({ onProgress }) => {
              // Yield first so the suite's event subscription attaches
              // before emission (in-process work would otherwise emit
              // synchronously during submit, before anyone subscribed).
              await new Promise((r) => setTimeout(r, 25));
              onProgress({ current: 1, total: 3 });
              onProgress({ current: 2, total: 3 });
              onProgress({ current: 3, total: 3 });
              return [{ type: "text", text: "progress-done" } as ContentBlock];
            });
          case "thrower":
            return bundle.harness.submit(async () => {
              throw new Error("in-process-boom");
            });
          case "slow":
            return bundle.harness.submit(
              async ({ signal }) =>
                new Promise<readonly ContentBlock[]>((_resolve, reject) => {
                  if (signal.aborted) {
                    reject(new Error("aborted"));
                    return;
                  }
                  signal.addEventListener("abort", () => reject(new Error("aborted")));
                }),
            );
        }
      },
    };
  },
});

// ── Child-process (by-ref handlers over IPC) ─────────────────────────
runTaskExecutorConformance({
  label: "child-process",
  setup: async () => {
    const executor = new ChildProcessTaskExecutor({
      workerModule: WORKER_MODULE,
      forkOptions: { execArgv: ["--import", "tsx"] },
      killGracePeriodMs: 1_000,
    });
    const bundle = await fakeTasks({ executors: [executor] });
    return {
      harness: bundle.harness,
      close: bundle.close,
      // Each canonical case is a registered handler ref in the fixture.
      submit: (kase: TaskExecutorCase, input?: unknown): TaskHandle =>
        bundle.harness.submit({ executorKind: "child-process", handlerRef: kase, input }),
    };
  },
});
