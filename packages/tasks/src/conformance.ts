/**
 * Conformance suite for {@link TasksHarnessProtocol} — cross-impl
 * invariants every concrete implementation must honor.
 *
 * Adopters writing a custom `TasksHarness` (a clustered impl, a
 * persistence-backed impl, a fake for testing extension behavior)
 * run this suite against their impl to catch protocol-shape
 * regressions. The suite is intentionally minimal — it pins the
 * BEHAVIORS that other framework code depends on, not the wire
 * envelope shape (the wire envelope is an impl detail of the
 * reference `TasksHarness`; the protocol contract is the abstract
 * lifecycle FSM + handle methods).
 *
 *   1. Round-trip. `submit(work)` runs the work fn and resolves
 *      `result` with its return value.
 *   2. Failure. Work throws → `result` rejects with a typed
 *      `TaskRejection` of `status: "failed"`.
 *   3. Cancel. `cancel(taskId)` transitions the task to `cancelled`
 *      and aborts the AbortSignal in the work ctx; result rejects
 *      with `status: "cancelled"`.
 *   4. Idempotence. Double-cancel is a no-op; cancel of unknown id
 *      throws `UnknownTaskError`.
 *   5. Snapshot. `get(taskId)` returns the current `TaskInfo` for
 *      live tasks; `undefined` for unknown ids.
 *   6. Status. `status(taskId)` mirrors `get(taskId).status` and
 *      transitions through the FSM correctly.
 *   7. Events. `events(taskId)` yields an initial snapshot, then
 *      future progress + status events, and closes on terminal.
 *   8. Close. `close()` cancels every in-flight task with
 *      `reason: "harness_closed"`; idempotent.
 *
 * The wire-envelope shape conformance lives in the impl-specific
 * spec (`harness.spec.ts`) — only the reference impl publishes on
 * the `task-status` / `task-progress` channels with the exact
 * payload shape. Alternative impls (e.g., cluster-shimmed) may
 * encode differently while honoring the protocol's lifecycle
 * guarantees.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { TaskHandle, TasksHarnessProtocol } from "@agentick/spec";

// ============================================================================
// Factory + shell shapes
// ============================================================================

export interface TasksConformanceFactoryInput {
  readonly harnessId: string;
}

/**
 * Shell handed to the suite per-test. The factory owns its substrate
 * (whatever that means for the impl); the suite drives the protocol
 * surface only.
 */
export interface TasksConformanceShell {
  readonly harness: TasksHarnessProtocol;
  close(): Promise<void>;
}

export type TasksConformanceFactory = (
  input: TasksConformanceFactoryInput,
) => Promise<TasksConformanceShell>;

// ============================================================================
// Suite
// ============================================================================

export function runTasksHarnessConformance(factory: TasksConformanceFactory): void {
  describe("TasksHarnessProtocol — round-trip", () => {
    it("submit(work) runs the work fn; result resolves with its return value", async () => {
      const shell = await factory({ harnessId: "conformance-roundtrip-1" });
      try {
        const handle = shell.harness.submit(async () => "the-return-value");
        const value = await handle.result;
        expect(value).toBe("the-return-value");
        expect(shell.harness.status(handle.taskId)).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("submit accepts a synchronous work fn", async () => {
      const shell = await factory({ harnessId: "conformance-sync-1" });
      try {
        const handle = shell.harness.submit(() => "sync-value");
        expect(await handle.result).toBe("sync-value");
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — failure", () => {
    it("work throws → result rejects with TaskRejection { status: 'failed' }", async () => {
      const shell = await factory({ harnessId: "conformance-fail-1" });
      try {
        const handle = shell.harness.submit(async () => {
          throw new Error("kaboom");
        });
        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "failed",
        });
        expect(shell.harness.status(handle.taskId)).toBe("failed");
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — cancel", () => {
    it("cancel(taskId) transitions to 'cancelled'; result rejects accordingly", async () => {
      const shell = await factory({ harnessId: "conformance-cancel-1" });
      try {
        const handle = shell.harness.submit(async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
          return "should-not-reach";
        });

        await new Promise((r) => setTimeout(r, 0));
        await shell.harness.cancel(handle.taskId, "user-aborted");

        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "cancelled",
        });
        expect(shell.harness.status(handle.taskId)).toBe("cancelled");
      } finally {
        await shell.close();
      }
    });

    it("cancel(taskId) on a completed task is a no-op (idempotent)", async () => {
      const shell = await factory({ harnessId: "conformance-cancel-idempotent-1" });
      try {
        const handle = shell.harness.submit(async () => "done");
        await handle.result;
        await expect(shell.harness.cancel(handle.taskId)).resolves.toBeUndefined();
        expect(shell.harness.status(handle.taskId)).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("cancel on unknown id throws UnknownTaskError", async () => {
      const shell = await factory({ harnessId: "conformance-cancel-unknown-1" });
      try {
        await expect(shell.harness.cancel("task:does-not-exist")).rejects.toMatchObject({
          _tag: "UnknownTaskError",
          taskId: "task:does-not-exist",
        });
      } finally {
        await shell.close();
      }
    });

    it("handle.cancel() is equivalent to harness.cancel(taskId)", async () => {
      const shell = await factory({ harnessId: "conformance-cancel-via-handle-1" });
      try {
        const handle: TaskHandle<string> = shell.harness.submit(async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
          return "x";
        });
        await new Promise((r) => setTimeout(r, 0));
        await handle.cancel("via-handle");
        await expect(handle.result).rejects.toMatchObject({ status: "cancelled" });
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — snapshot", () => {
    it("get(taskId) returns a TaskInfo while the task is live", async () => {
      const shell = await factory({ harnessId: "conformance-get-1" });
      try {
        const handle = shell.harness.submit(async () => 42);
        const info = shell.harness.get(handle.taskId);
        expect(info).toBeDefined();
        expect(info?.taskId).toBe(handle.taskId);
        expect(info?.status).toBe("working");
        await handle.result;
        expect(shell.harness.get(handle.taskId)?.status).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("get / status / events return undefined / throw for unknown ids", async () => {
      const shell = await factory({ harnessId: "conformance-unknown-1" });
      try {
        expect(shell.harness.get("task:nope")).toBeUndefined();
        expect(shell.harness.status("task:nope")).toBeUndefined();
        expect(() => shell.harness.events("task:nope")).toThrowError(
          expect.objectContaining({ _tag: "UnknownTaskError" }),
        );
      } finally {
        await shell.close();
      }
    });

    it("list() returns a snapshot of every known task scoped to this harness", async () => {
      const shell = await factory({ harnessId: "conformance-list-1" });
      try {
        expect(shell.harness.list()).toEqual([]);
        const a = shell.harness.submit(async () => "a");
        const b = shell.harness.submit(async () => "b");
        const listed = shell.harness.list();
        expect(listed).toHaveLength(2);
        const ids = listed.map((t) => t.taskId).sort();
        expect(ids).toEqual([a.taskId, b.taskId].sort());
        await Promise.all([a.result, b.result]);
        const after = shell.harness.list();
        expect(after.map((t) => t.status).sort()).toEqual(["completed", "completed"]);
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — events()", () => {
    it("yields an initial status snapshot, then closes when terminal arrives", async () => {
      const shell = await factory({ harnessId: "conformance-events-1" });
      try {
        const handle = shell.harness.submit(async () => "x");
        await handle.result;

        const events: Array<{ kind: string }> = [];
        for await (const event of handle.events()) {
          events.push(event);
        }
        // At least the initial snapshot (or the terminal snapshot,
        // depending on whether the impl yields both — protocol
        // permits either).
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.some((e) => e.kind === "status")).toBe(true);
      } finally {
        await shell.close();
      }
    });

    it("yields progress events emitted during work", async () => {
      const shell = await factory({ harnessId: "conformance-events-progress-1" });
      try {
        let started = false;
        const handle = shell.harness.submit(async ({ onProgress }) => {
          while (!started) await new Promise((r) => setTimeout(r, 5));
          onProgress({ current: 1, total: 3 });
          onProgress({ current: 2, total: 3 });
          onProgress({ current: 3, total: 3 });
          return "complete";
        });

        const iter = handle.events()[Symbol.asyncIterator]();
        // Pull initial snapshot, then signal the work to proceed.
        const initial = await iter.next();
        expect(initial.done).toBe(false);
        started = true;

        const collected: Array<{ kind: string }> = [initial.value];
        for (let i = 0; i < 10; i++) {
          const next = await iter.next();
          if (next.done) break;
          collected.push(next.value);
        }
        await handle.result;

        const progress = collected.filter((e) => e.kind === "progress");
        expect(progress.length).toBeGreaterThanOrEqual(3);
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — Effect-typed work", () => {
    it("submit accepts Effect work; resolves on Effect.succeed", async () => {
      const shell = await factory({ harnessId: "conformance-effect-succeed-1" });
      try {
        const handle = shell.harness.submit(() => Effect.succeed("effect-value"));
        expect(await handle.result).toBe("effect-value");
        expect(shell.harness.status(handle.taskId)).toBe("completed");
      } finally {
        await shell.close();
      }
    });

    it("Effect.fail surfaces as TaskRejection { status: 'failed' }", async () => {
      const shell = await factory({ harnessId: "conformance-effect-fail-1" });
      try {
        const handle = shell.harness.submit(() => Effect.fail("typed-failure"));
        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "failed",
          failure: { kind: "error", reason: "typed-failure" },
        });
      } finally {
        await shell.close();
      }
    });

    it("Effect.die (defect) surfaces as TaskRejection { status: 'failed' }", async () => {
      const shell = await factory({ harnessId: "conformance-effect-die-1" });
      try {
        const handle = shell.harness.submit(() => Effect.die(new Error("boom-defect")));
        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          taskId: handle.taskId,
          status: "failed",
          failure: { kind: "error", reason: "boom-defect" },
        });
      } finally {
        await shell.close();
      }
    });

    it("cancel interrupts a sleeping Effect — work bails synchronously, not after the sleep", async () => {
      const shell = await factory({ harnessId: "conformance-effect-interrupt-1" });
      try {
        // 60-second sleep — if `Fiber.interrupt` weren't wired, this
        // test would time out.
        const handle = shell.harness.submit(() => Effect.sleep("60 seconds").pipe(Effect.as("x")));
        // Give the fiber a tick to actually schedule the sleep.
        await new Promise((r) => setTimeout(r, 5));
        const cancelStart = Date.now();
        await shell.harness.cancel(handle.taskId, "test-interrupt");
        await expect(handle.result).rejects.toMatchObject({
          _tag: "TaskRejection",
          status: "cancelled",
        });
        const elapsed = Date.now() - cancelStart;
        expect(elapsed).toBeLessThan(2000);
      } finally {
        await shell.close();
      }
    });
  });

  describe("TasksHarnessProtocol — close cascade", () => {
    it("close() cancels every in-flight task with reason 'harness_closed'", async () => {
      const shell = await factory({ harnessId: "conformance-close-1" });
      const handle = shell.harness.submit(async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return "x";
      });

      await shell.close();

      await expect(handle.result).rejects.toMatchObject({
        _tag: "TaskRejection",
        status: "cancelled",
      });
      expect(shell.harness.get(handle.taskId)?.failure?.reason).toBe("harness_closed");
    });
  });
}
