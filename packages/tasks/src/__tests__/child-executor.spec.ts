/**
 * `ChildProcessTaskExecutor` — REAL fork + IPC round-trip (ADR 68 Build
 * B). Every test here ACTUALLY forks a child (`tsx`-loaded TS fixture
 * worker) and round-trips over IPC — no fakes for the process boundary.
 * The parent side is driven through a real `TasksHarness` (via
 * `fakeTasks`) so we exercise the whole seam: submit → fork → report →
 * store.put + bus emit → handle.result.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { drainRejection, waitFor } from "@agentick/utils/testing";
import type { TaskRecord, TaskStatus } from "@agentick/spec";
import { InMemoryTaskStore } from "../store.js";
import { ChildProcessTaskExecutor } from "../child-executor.js";
import type { WorkerToParentMessage } from "../child-protocol.js";
import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

const WORKER_MODULE = fileURLToPath(new URL("./fixtures/task-worker.ts", import.meta.url));
const FORK_OPTIONS = { execArgv: ["--import", "tsx"] };

function childExecutor(killGracePeriodMs = 1_000): ChildProcessTaskExecutor {
  return new ChildProcessTaskExecutor({
    workerModule: WORKER_MODULE,
    forkOptions: FORK_OPTIONS,
    killGracePeriodMs,
  });
}

describe("ChildProcessTaskExecutor — fork + IPC round-trip", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("echo round-trips a result over IPC", async () => {
    bundle = await fakeTasks({ executors: [childExecutor()] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "echo",
      input: "hello-child",
    });
    expect(handle.initialStatus).toBe("working");
    const result = await handle.result;
    expect(result).toEqual([{ type: "text", text: "hello-child" }]);
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("round-trips a Date / Map / typed-array intact (structured-clone default)", async () => {
    // Proves the executor's `serialization: "advanced"` default: a value
    // JSON would mangle survives BOTH directions (input → child, result →
    // parent) with instances intact. The README's structured-clone claim.
    bundle = await fakeTasks({ executors: [childExecutor()] });
    const input = {
      when: new Date("2026-07-08T00:00:00.000Z"),
      tags: new Map<string, number>([["a", 1]]),
      bytes: new Uint8Array([1, 2, 3]),
    };
    const handle = bundle.harness.submit<typeof input>({
      executorKind: "child-process",
      handlerRef: "roundtrip",
      input,
    });
    const result = await handle.result;
    expect(result.when).toBeInstanceOf(Date);
    expect(result.when.toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(result.tags).toBeInstanceOf(Map);
    expect(result.tags.get("a")).toBe(1);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it("progress events arrive over IPC in order", async () => {
    bundle = await fakeTasks({ executors: [childExecutor()] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "progress",
    });

    const progress: number[] = [];
    for await (const event of handle.events()) {
      if (event.kind === "progress") progress.push(event.current);
    }
    await handle.result;
    expect(progress).toEqual([1, 2, 3]);
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("a throwing handler surfaces as failed with a reason", async () => {
    bundle = await fakeTasks({ executors: [childExecutor()] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "thrower",
    });
    await expect(handle.result).rejects.toMatchObject({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "failed",
    });
    expect(bundle.harness.get(handle.taskId)?.failure?.reason).toContain("worker-boom");
  });

  it("cancel tears down the child (graceful) — result rejects, child exits", async () => {
    const executor = childExecutor(1_000);
    bundle = await fakeTasks({ executors: [executor] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "slow",
    });
    const drained = drainRejection(handle.result);
    // Let the child spin up + register its abort listener.
    await waitFor(() => executor.activeChildCount() === 1);
    await bundle.harness.cancel(handle.taskId, "test-cancel");
    expect(await drained).toMatchObject({ _tag: "TaskRejection", status: "cancelled" });
    expect(bundle.harness.status(handle.taskId)).toBe("cancelled");
    // The child actually left (cooperative cancel exited it).
    await waitFor(() => executor.activeChildCount() === 0);
  });

  it("SIGKILL backstop: a child that ignores cancel is force-killed and exits", async () => {
    const executor = childExecutor(200); // short grace → fast SIGKILL
    bundle = await fakeTasks({ executors: [executor] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "hang", // never observes the signal
    });
    const drained = drainRejection(handle.result);
    await waitFor(() => executor.activeChildCount() === 1);
    await bundle.harness.cancel(handle.taskId, "force");
    expect(await drained).toMatchObject({ status: "cancelled" });
    // Cooperative cancel can't stop it; the SIGKILL backstop does.
    await waitFor(() => executor.activeChildCount() === 0, { timeoutMs: 3_000 });
  });

  it("missing handlerRef on a by-ref submit throws at submit (before forking)", async () => {
    const executor = childExecutor();
    bundle = await fakeTasks({ executors: [executor] });
    // Bypass the typed by-ref overload to hit the runtime guard.
    expect(() =>
      (bundle!.harness.submit as (opts: unknown) => unknown)({ executorKind: "child-process" }),
    ).toThrowError(
      expect.objectContaining({ _tag: "TaskHandlerRefRequiredError", kind: "child-process" }),
    );
    // Nothing was forked.
    expect(executor.activeChildCount()).toBe(0);
  });
});

describe("ChildProcessTaskExecutor — registry + lifetime", () => {
  it("unknown executorKind throws UnknownTaskExecutorError", async () => {
    const bundle = await fakeTasks(); // in-process default only
    try {
      expect(() =>
        (bundle.harness.submit as (opts: unknown) => unknown)({
          executorKind: "nonexistent",
          handlerRef: "echo",
        }),
      ).toThrowError(
        expect.objectContaining({ _tag: "UnknownTaskExecutorError", kind: "nonexistent" }),
      );
    } finally {
      await bundle.close();
    }
  });

  it("the registry merges the provided child executor over the in-process default", async () => {
    const executor = childExecutor();
    const bundle = await fakeTasks({ executors: [executor] });
    try {
      // Default in-process still resolvable (closure path).
      const inProc = bundle.harness.submit(async () => [{ type: "text", text: "in-proc" }]);
      expect(await inProc.result).toEqual([{ type: "text", text: "in-proc" }]);
      // Provided child-process resolvable (by-ref path).
      const child = bundle.harness.submit({
        executorKind: "child-process",
        handlerRef: "echo",
        input: "child",
      });
      expect(await child.result).toEqual([{ type: "text", text: "child" }]);
    } finally {
      await bundle.close();
    }
  });

  it("a detached child survives harness.close(); a fresh harness reattaches + cancels it", async () => {
    // Shared app-scoped store + executor (the AppHarness pattern).
    const store = new InMemoryTaskStore();
    const executor = childExecutor(1_000);

    const first = await fakeTasks({ store, executors: [executor], sessionId: "s-detach" });
    const handle = first.harness.submit({
      executorKind: "child-process",
      handlerRef: "slow",
      detached: true,
    });
    await waitFor(() => executor.activeChildCount() === 1);

    // Closing the spawning harness must NOT kill the detached child.
    await first.close();
    expect(executor.activeChildCount()).toBe(1);
    expect(handle.taskId).toMatch(/^task:/);

    // A fresh harness sharing the store + executor reattaches the still-
    // live child on hydration (child-process reattach within the process).
    const second = await fakeTasks({ store, executors: [executor], sessionId: "s-detach" });
    try {
      await second.harness.hydrated;
      expect(second.harness.status(handle.taskId)).toBe("working"); // reattached, not interrupted
      await second.harness.cancel(handle.taskId, "cleanup");
      expect(second.harness.status(handle.taskId)).toBe("cancelled");
      await waitFor(() => executor.activeChildCount() === 0);
    } finally {
      await second.close();
    }
  });

  it("a non-detached child is killed on harness.close()", async () => {
    const executor = childExecutor(1_000);
    const bundle = await fakeTasks({ executors: [executor] });
    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "slow", // NOT detached
    });
    const drained = drainRejection(handle.result);
    await waitFor(() => executor.activeChildCount() === 1);
    await bundle.close();
    // close() cancels non-detached in-flight tasks → child torn down.
    await waitFor(() => executor.activeChildCount() === 0);
    expect(await drained).toMatchObject({ status: "cancelled" });
  });
});

describe("runTaskWorker — input_required over IPC (message-triggered release)", () => {
  // A by-ref child that pauses on `ctx.awaitingInput` must flip
  // `input_required → working → completed` over IPC — symmetric with the
  // in-process executor. Fork the fixture DIRECTLY and read the raw
  // WorkerToParentMessage transitions (observing the wire itself). The
  // pause is released by a custom `{ t: "release-input" }` message — a
  // deterministic, deferred-triggered release, NOT a timer race.
  it("flips input_required (with statusMessage) → working → completed", async () => {
    const child = fork(WORKER_MODULE, [], { ...FORK_OPTIONS, silent: true });
    const now = 1_700_000_000_000;
    const record: TaskRecord = {
      taskId: "task:awaits-input",
      status: "working",
      scope: {},
      executorKind: "child-process",
      detached: false,
      handlerRef: "awaits-input",
      ttl: null,
      createdAt: now,
      updatedAt: now,
    };

    const transitions: Extract<WorkerToParentMessage, { t: "transition" }>["transition"][] = [];
    let onInputRequired!: () => void;
    const sawInputRequired = new Promise<void>((resolve) => {
      onInputRequired = resolve;
    });
    let onCompleted!: () => void;
    const sawCompleted = new Promise<void>((resolve) => {
      onCompleted = resolve;
    });
    child.on("message", (message: WorkerToParentMessage) => {
      if (message == null || message.t !== "transition") return;
      transitions.push(message.transition);
      if (message.transition.status === "input_required") onInputRequired();
      if (message.transition.status === "completed") onCompleted();
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    child.send({ t: "start", record });

    // The child paused in input_required — deterministic (the release
    // message hasn't been sent). Only THEN release it.
    await sawInputRequired;
    child.send({ t: "release-input" });
    await sawCompleted;
    expect(await exited).toBe(0);

    // The worker emits ONLY its own transitions (the parent harness writes
    // the initial `working`), so: input_required → working → completed.
    const statuses = transitions
      .map((t) => t.status)
      .filter((s): s is TaskStatus => s !== undefined);
    expect(statuses).toEqual(["input_required", "working", "completed"]);
    const inputReq = transitions.find((t) => t.status === "input_required");
    expect(inputReq?.statusMessage).toBe("need input");
  });
});

describe("runTaskWorker — orphan self-termination on parent disconnect", () => {
  // A forked worker CANNOT re-attach to a new parent over fork IPC, so rather
  // than run headless/orphaned when the parent (app) dies, it self-terminates
  // on the IPC `disconnect`. Fork the fixture DIRECTLY (bypassing the executor)
  // and drop the channel to simulate parent death mid-work.
  it("a worker running a hang handler exits when the parent disconnects", async () => {
    const child = fork(WORKER_MODULE, [], { ...FORK_OPTIONS, silent: true });
    const now = 1_700_000_000_000;
    const record: TaskRecord = {
      taskId: "task:orphan",
      status: "working",
      scope: {},
      executorKind: "child-process",
      detached: true,
      handlerRef: "hang", // ignores the signal, never resolves on its own
      ttl: null,
      createdAt: now,
      updatedAt: now,
    };

    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    // Wait for the channel to be live, hand it the task, then sever the pipe.
    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    child.send({ t: "start", record });
    // Give the worker a beat to begin the (never-resolving) hang handler,
    // then simulate parent death by dropping the IPC channel.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    child.disconnect();

    const code = await exited;
    expect(code).toBe(1); // self-terminated via the disconnect handler
  });
});
