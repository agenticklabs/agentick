/**
 * TasksHarness — lifecycle, progress, cancel, events, close.
 */

import { Chunk, Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolEvent, TaskEvent, TaskInfo, TaskRejection } from "@agentick/spec-next";
import type { LocalEventBus } from "@agentick/runtime-next";

import { TASK_PROGRESS_CHANNEL_FQN, TASK_STATUS_CHANNEL_FQN } from "../channel.js";
import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvelopeWithMetadata = ProtocolEvent;

function takeStatusEnvelopes(
  bus: LocalEventBus,
  n: number,
): Promise<readonly EnvelopeWithMetadata[]> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: TASK_STATUS_CHANNEL_FQN },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        n,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c)));
}

function takeProgressEnvelopes(
  bus: LocalEventBus,
  n: number,
): Promise<readonly EnvelopeWithMetadata[]> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: TASK_PROGRESS_CHANNEL_FQN },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        n,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c)));
}

// ---------------------------------------------------------------------------
// Lifecycle — working → completed
// ---------------------------------------------------------------------------

describe("TasksHarness — submit + complete", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("submit() returns a TaskHandle with status 'working'; resolves on completion", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => "result-payload");
    expect(handle.taskId).toMatch(/^task:/);
    expect(handle.initialStatus).toBe("working");

    const result = await handle.result;
    expect(result).toBe("result-payload");
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("get() returns a TaskInfo snapshot with the current status", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => 42);
    const before = bundle.harness.get(handle.taskId);
    expect(before).toBeDefined();
    expect(before?.status).toBe("working");
    expect(before?.taskId).toBe(handle.taskId);

    await handle.result;
    const after = bundle.harness.get(handle.taskId);
    expect(after?.status).toBe("completed");
    expect(after!.lastUpdatedAt).toBeGreaterThanOrEqual(before!.lastUpdatedAt);
  });

  it("status() returns undefined for unknown task ids", async () => {
    bundle = await fakeTasks();
    expect(bundle.harness.status("task:does-not-exist")).toBeUndefined();
  });

  it("result() by id resolves the same value as the handle's .result", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => ({ payload: "x" }));
    const viaId = await bundle.harness.result<{ payload: string }>(handle.taskId);
    const viaHandle = await handle.result;
    expect(viaId).toEqual(viaHandle);
  });

  it("submit propagates a typed TaskRejection on work failure", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => {
      throw new Error("kaboom");
    });

    await expect(handle.result).rejects.toMatchObject<Partial<TaskRejection>>({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "failed",
    });
    const info = bundle.harness.get(handle.taskId);
    expect(info?.status).toBe("failed");
    expect(info?.failure?.kind).toBe("error");
    expect(info?.failure?.reason).toBe("kaboom");
  });
});

// ---------------------------------------------------------------------------
// Progress + status — bus envelopes
// ---------------------------------------------------------------------------

describe("TasksHarness — bus envelopes", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("publishes status envelopes on task-status channel for transitions", async () => {
    bundle = await fakeTasks();
    // Two envelopes expected: initial 'working' at submit, then
    // 'completed' at resolution.
    const envsP = takeStatusEnvelopes(bundle.bus, 2);
    const handle = bundle.harness.submit(async () => "ok");
    await handle.result;
    const envs = await envsP;

    expect(envs).toHaveLength(2);
    const first = envs[0]!.payload as TaskInfo;
    const second = envs[1]!.payload as TaskInfo;
    expect(first.taskId).toBe(handle.taskId);
    expect(first.status).toBe("working");
    expect(second.status).toBe("completed");
  });

  it("publishes progress envelopes on task-progress channel", async () => {
    bundle = await fakeTasks();
    const progressP = takeProgressEnvelopes(bundle.bus, 3);

    const handle = bundle.harness.submit(async ({ onProgress }) => {
      onProgress({ current: 1, total: 3 });
      onProgress({ current: 2, total: 3, message: "halfway" });
      onProgress({ current: 3, total: 3, message: "done" });
      return "complete";
    });

    await handle.result;
    const envs = await progressP;
    expect(envs).toHaveLength(3);
    const payloads = envs.map(
      (e) =>
        e.payload as {
          taskId: string;
          current: number;
          total?: number;
          message?: string;
        },
    );
    expect(payloads[0]).toEqual({ taskId: handle.taskId, current: 1, total: 3 });
    expect(payloads[1]).toEqual({
      taskId: handle.taskId,
      current: 2,
      total: 3,
      message: "halfway",
    });
    expect(payloads[2]).toEqual({
      taskId: handle.taskId,
      current: 3,
      total: 3,
      message: "done",
    });
  });

  it("session-scoped subscriptions filter on scope.sessionId", async () => {
    bundle = await fakeTasks({ sessionId: "session-abc" });
    const envP = takeStatusEnvelopes(bundle.bus, 1);
    bundle.harness.submit(async () => "x");
    const env = (await envP)[0]!;
    expect(env.scope?.sessionId).toBe("session-abc");
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe("TasksHarness — cancel", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("cancel() aborts the work signal; result rejects with status: 'cancelled'", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
      });
      return "should-not-reach";
    });

    // Allow submit to register before cancel
    await new Promise((r) => setTimeout(r, 0));
    await bundle.harness.cancel(handle.taskId, "user-aborted");

    await expect(handle.result).rejects.toMatchObject<Partial<TaskRejection>>({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "cancelled",
    });
    const info = bundle.harness.get(handle.taskId);
    expect(info?.status).toBe("cancelled");
    expect(info?.failure?.kind).toBe("aborted");
    expect(info?.failure?.reason).toBe("user-aborted");
  });

  it("cancel() on a completed task is a no-op (idempotent)", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => "done");
    await handle.result;
    await expect(bundle.harness.cancel(handle.taskId)).resolves.toBeUndefined();
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("cancel() on unknown id throws UnknownTaskError", async () => {
    bundle = await fakeTasks();
    await expect(bundle.harness.cancel("task:nope")).rejects.toMatchObject({
      _tag: "UnknownTaskError",
      taskId: "task:nope",
    });
  });

  it("handle.cancel() is equivalent to harness.cancel(taskId)", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "x";
    });
    await new Promise((r) => setTimeout(r, 0));
    await handle.cancel("via-handle");
    await expect(handle.result).rejects.toMatchObject({ status: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// Close — cancel-all-pending semantics
// ---------------------------------------------------------------------------

describe("TasksHarness — close", () => {
  it("close() cancels every in-flight task with reason 'harness_closed'", async () => {
    const bundle = await fakeTasks();
    const handles = [
      bundle.harness.submit(async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return "x";
      }),
      bundle.harness.submit(async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return "y";
      }),
    ];
    expect(bundle.harness.pendingCount()).toBe(2);

    await bundle.close();

    for (const h of handles) {
      await expect(h.result).rejects.toMatchObject({
        status: "cancelled",
      });
      const info = bundle.harness.get(h.taskId);
      expect(info?.failure?.reason).toBe("harness_closed");
    }
  });

  it("close() is idempotent", async () => {
    const bundle = await fakeTasks();
    await bundle.close();
    await expect(bundle.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event stream (.events())
// ---------------------------------------------------------------------------

describe("TasksHarness — events()", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("yields the initial status snapshot, then progress + status transitions", async () => {
    bundle = await fakeTasks();
    let started = false;
    const events: TaskEvent[] = [];

    const handle = bundle.harness.submit(async ({ onProgress }) => {
      // Wait for the consumer to subscribe before emitting progress
      while (!started) await new Promise((r) => setTimeout(r, 5));
      onProgress({ current: 1 });
      onProgress({ current: 2 });
      return "done";
    });

    const iter = handle.events()[Symbol.asyncIterator]();
    // Take the initial snapshot, then start emitting.
    const first = await iter.next();
    started = true;
    events.push(first.value);

    for (let i = 0; i < 4; i++) {
      const next = await iter.next();
      if (next.done) break;
      events.push(next.value);
    }

    await handle.result;

    // Expected sequence: initial status (working) + 2 progress + 1
    // terminal status (completed). Order: status, progress, progress, status.
    expect(events[0]).toMatchObject({ kind: "status" });
    expect((events[0] as { info: TaskInfo }).info.status).toBe("working");

    const progressEvents = events.filter((e) => e.kind === "progress");
    expect(progressEvents).toHaveLength(2);

    const lastStatus = [...events].reverse().find((e) => e.kind === "status") as
      | { info: TaskInfo }
      | undefined;
    expect(lastStatus?.info.status).toBe("completed");
  });

  it("events() on a completed task yields the snapshot and closes", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => "ok");
    await handle.result;

    const events: TaskEvent[] = [];
    for await (const event of handle.events()) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      info: { status: "completed" },
    });
  });

  it("events() on unknown id throws UnknownTaskError", async () => {
    bundle = await fakeTasks();
    expect(() => bundle!.harness.events("task:nope")).toThrowError(
      expect.objectContaining({ _tag: "UnknownTaskError" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity + address
// ---------------------------------------------------------------------------

describe("TasksHarness — identity + address", () => {
  it("id matches the constructor scopeId; address is `tasks:${scopeId}`", async () => {
    const bundle = await fakeTasks({ harnessId: "specific-tasks-id" });
    try {
      expect(bundle.harness.id).toBe("specific-tasks-id");
      expect(bundle.harness.address).toBe("tasks:specific-tasks-id");
    } finally {
      await bundle.close();
    }
  });
});
