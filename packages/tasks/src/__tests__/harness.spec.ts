/**
 * TasksHarness — lifecycle, progress, cancel, events, close.
 */

import { Chunk, Effect, Ref, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ProtocolEvent, TaskEvent, TaskInfo, TaskRejection } from "@agentick/spec";
import type { LocalEventBus } from "@agentick/runtime";
import { drainRejection, waitForStable } from "@agentick/utils/testing";
import { stubStoreCtx } from "@agentick/store";

import { TASK_PROGRESS_CHANNEL_FQN, TASK_STATUS_CHANNEL_FQN } from "../channel.js";
import { InMemoryTaskStore } from "../store.js";
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

    await expect(handle.result).rejects.toMatchObject({
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
      onProgress({ progress: 1, total: 3 });
      onProgress({ progress: 2, total: 3, message: "halfway" });
      onProgress({ progress: 3, total: 3, message: "done" });
      return "complete";
    });

    await handle.result;
    const envs = await progressP;
    expect(envs).toHaveLength(3);
    const payloads = envs.map(
      (e) =>
        e.payload as {
          taskId: string;
          progress: number;
          total?: number;
          message?: string;
        },
    );
    expect(payloads[0]).toEqual({ taskId: handle.taskId, progress: 1, total: 3 });
    expect(payloads[1]).toEqual({
      taskId: handle.taskId,
      progress: 2,
      total: 3,
      message: "halfway",
    });
    expect(payloads[2]).toEqual({
      taskId: handle.taskId,
      progress: 3,
      total: 3,
      message: "done",
    });
  });

  it("ctx.progress.begin() publishes the SAME grammar on task-progress, keyed by task id", async () => {
    bundle = await fakeTasks();
    const progressP = takeProgressEnvelopes(bundle.bus, 3);

    const handle = bundle.harness.submit(async ({ progress }) => {
      // The task's own id is the token — the work body invents nothing, and the
      // frames are the same `{ progress, total?, message? }` a tool's
      // `ctx.progress.begin()` emits.
      const bar = progress.begin({ total: 2, message: "starting" });
      bar.advance(1, "first");
      bar.done();
      return "complete";
    });

    await handle.result;
    expect((await progressP).map((e) => e.payload)).toEqual([
      { taskId: handle.taskId, progress: 0, total: 2, message: "starting" },
      { taskId: handle.taskId, progress: 1, total: 2, message: "first" },
      { taskId: handle.taskId, progress: 2, total: 2 },
    ]);
  });

  it("an indeterminate task reporter never publishes total", async () => {
    bundle = await fakeTasks();
    const progressP = takeProgressEnvelopes(bundle.bus, 2);

    const handle = bundle.harness.submit(async ({ progress }) => {
      const spinner = progress.begin({ message: "scanning" });
      spinner.advance(3);
      return "complete";
    });

    await handle.result;
    expect((await progressP).map((e) => e.payload)).toEqual([
      { taskId: handle.taskId, progress: 0, message: "scanning" },
      { taskId: handle.taskId, progress: 3 },
    ]);
  });

  it("the reporter's last frame is the durable record's progress fold, same three fields", async () => {
    const store = new InMemoryTaskStore();
    bundle = await fakeTasks({ store });
    const handle = bundle.harness.submit(async ({ progress }) => {
      progress.begin({ total: 4 }).advance(2, "halfway");
      return "complete";
    });
    await handle.result;
    expect((await store.get(handle.taskId, stubStoreCtx()))?.progress).toEqual({
      progress: 2,
      total: 4,
      message: "halfway",
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

    await expect(handle.result).rejects.toMatchObject({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "cancelled",
    });
    const info = bundle.harness.get(handle.taskId);
    expect(info?.status).toBe("cancelled");
    expect(info?.failure?.kind).toBe("aborted");
    expect(info?.failure?.reason).toBe("user-aborted");
  });

  it("cancelling a detached task whose result is never awaited emits no unhandled rejection", async () => {
    bundle = await fakeTasks();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = bundle.harness.submit(
        async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
          });
          return "should-not-reach";
        },
        { detached: true },
      );

      await new Promise((r) => setTimeout(r, 0));
      await bundle.harness.cancel(handle.taskId, "conversation deleted");

      // "nothing more arrives" — the poll drains the queue so Node's
      // unhandled-rejection detector runs; a missing guard would land here.
      await waitForStable(
        () => unhandled.filter((r) => (r as { _tag?: unknown })?._tag === "TaskRejection").length,
      );

      expect(unhandled).toEqual([]);
      expect(bundle.harness.status(handle.taskId)).toBe("cancelled");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
      onProgress({ progress: 1 });
      onProgress({ progress: 2 });
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

  it("events() yields the event stream; .result resolves independently", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(async () => "done");
    // `.result` resolves independently of any iteration.
    const result = await handle.result;
    expect(result).toBe("done");

    // events() — post-terminal, yields the completed snapshot then closes.
    const kinds: string[] = [];
    for await (const ev of handle.events()) kinds.push(ev.kind);

    expect(kinds).toEqual(["status"]);
  });

  it("events() on unknown id throws UnknownTaskError", async () => {
    bundle = await fakeTasks();
    expect(() => bundle!.harness.events("task:nope")).toThrowError(
      expect.objectContaining({ _tag: "UnknownTaskError" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Effect-typed work — Fiber.interrupt, real interruptibility, Cause handling
// ---------------------------------------------------------------------------

describe("TasksHarness — Effect-typed work", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("submit accepts Effect work; Effect.succeed resolves handle.result", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(() => Effect.succeed("effect-value"));
    expect(await handle.result).toBe("effect-value");
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("Effect.fail with a typed error surfaces as TaskRejection { status: 'failed' }", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(() => Effect.fail({ _tag: "MyDomainError" }));
    await expect(handle.result).rejects.toMatchObject({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "failed",
      failure: { kind: "error", reason: "MyDomainError" },
    });
  });

  it("Effect.die (defect) surfaces as TaskRejection { status: 'failed' }", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(() => Effect.die(new Error("internal-defect")));
    await expect(handle.result).rejects.toMatchObject({
      status: "failed",
      failure: { kind: "error", reason: "internal-defect" },
    });
  });

  it("TaskFailure.cause preserves typed Effect.fail value verbatim (#165)", async () => {
    bundle = await fakeTasks();
    // Domain-shaped failure with structured payload — the kind adopters
    // pattern-match on `_tag` and read `detail` from.
    const domainErr = { _tag: "PaymentDeclined", amount: 4200, currency: "USD" };
    const handle = bundle.harness.submit(() => Effect.fail(domainErr));
    const rejection = await handle.result.catch((e: unknown) => e);
    // The typed Rejection's `failure.cause` IS the original value
    // (structural equality; identity-preserving by construction).
    expect((rejection as TaskRejection).failure?.cause).toEqual(domainErr);
    // Same value reachable via TaskInfo snapshot.
    const info = bundle.harness.get(handle.taskId);
    expect(info?.failure?.cause).toEqual(domainErr);
    // `reason` stays as the single-line summary (the _tag).
    expect(info?.failure?.reason).toBe("PaymentDeclined");
  });

  it("TaskFailure.cause preserves Effect.die defect verbatim (#165)", async () => {
    bundle = await fakeTasks();
    const defect = new Error("kaboom");
    const handle = bundle.harness.submit(() => Effect.die(defect));
    const info = await handle.result.catch(() => bundle!.harness.get(handle.taskId));
    expect((info as { failure?: { cause?: unknown } }).failure?.cause).toBe(defect);
  });

  it("Promise-path TaskFailure.cause preserves the rejected value (#165)", async () => {
    bundle = await fakeTasks();
    const thrown = { code: "ETIMEDOUT", detail: "upstream slow" };
    const handle = bundle.harness.submit(async () => {
      throw thrown;
    });
    const rejection = await handle.result.catch((e: unknown) => e);
    expect((rejection as TaskRejection).failure?.cause).toBe(thrown);
  });

  it("cancel interrupts a sleeping Effect — finishes in well under the sleep duration", async () => {
    bundle = await fakeTasks();
    // 60-second sleep — without Fiber.interrupt this test would time out.
    const handle = bundle.harness.submit(() =>
      Effect.sleep("60 seconds").pipe(Effect.as("should-never-resolve")),
    );
    await new Promise((r) => setTimeout(r, 5));
    const cancelStart = Date.now();
    await bundle.harness.cancel(handle.taskId, "interrupt-me");
    await expect(handle.result).rejects.toMatchObject({
      status: "cancelled",
      failure: { kind: "aborted", reason: "interrupt-me" },
    });
    const elapsed = Date.now() - cancelStart;
    expect(elapsed).toBeLessThan(500);
  });

  it("Effect work running concurrent loops bails on interrupt (no zombie compute)", async () => {
    bundle = await fakeTasks();
    const counter = Effect.runSync(Ref.make(0));
    // Tight Effect.gen loop that yields each iteration so the runtime
    // gets a chance to observe an incoming interrupt. Without
    // Fiber.interrupt, this loop would run forever; with it, the
    // counter freezes shortly after cancel.
    const handle = bundle.harness.submit(() =>
      Effect.gen(function* () {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          yield* Ref.update(counter, (n) => n + 1);
          yield* Effect.sleep("1 millis");
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 25));
    await bundle.harness.cancel(handle.taskId);
    await expect(handle.result).rejects.toMatchObject({ status: "cancelled" });
    const atCancel = Effect.runSync(Ref.get(counter));
    await new Promise((r) => setTimeout(r, 50));
    const afterCancel = Effect.runSync(Ref.get(counter));
    // No further increments after interrupt observed.
    expect(afterCancel).toBe(atCancel);
  });

  it("Effect work emits progress via onProgress (imperative side-effect from within Effect)", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit((ctx) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => ctx.onProgress({ progress: 1, total: 3 }));
        yield* Effect.sync(() => ctx.onProgress({ progress: 2, total: 3 }));
        yield* Effect.sync(() => ctx.onProgress({ progress: 3, total: 3 }));
        return "done";
      }),
    );
    expect(await handle.result).toBe("done");
    // Snapshot list of progress events on the bus.
    // (We only verify here that the path runs end-to-end without
    // crashing; bus-envelope conformance is covered above.)
    expect(bundle.harness.status(handle.taskId)).toBe("completed");
  });

  it("await cancel() waits for the fiber's finalizers to complete (settled cancel)", async () => {
    bundle = await fakeTasks();
    const finalizerCalls = Effect.runSync(Ref.make(0));
    // `acquireUseRelease` registers a release effect that runs on
    // interrupt OR normal completion. We assert that by the time
    // `await cancel()` returns, the release has bumped the counter —
    // i.e., the harness did not return until the fiber was fully
    // detached. The release intentionally takes 20ms to run, so
    // fire-and-forget cancel would observe 0 immediately after cancel.
    const handle = bundle.harness.submit(() =>
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.sleep("60 seconds"),
        () =>
          Ref.update(finalizerCalls, (n) => n + 1).pipe(Effect.zipRight(Effect.sleep("20 millis"))),
      ),
    );
    // Pre-drain the rejection so vitest doesn't flag an "unhandled
    // rejection" during the awaited Fiber.interrupt window. The
    // drained promise is held separately; `handle.result` remains the
    // original rejected promise for the matcher below.
    const drained = drainRejection(handle.result);
    await new Promise((r) => setTimeout(r, 10));
    await bundle.harness.cancel(handle.taskId);
    expect(Effect.runSync(Ref.get(finalizerCalls))).toBe(1);
    expect(await drained).toMatchObject({ status: "cancelled" });
  });

  it("internal Effect.interrupt (not via cancel()) surfaces as TaskRejection { status: 'cancelled' }", async () => {
    bundle = await fakeTasks();
    // The work fn self-interrupts — no external cancel() involved.
    // Exercises the `Cause.isInterruptedOnly` branch in
    // `runEffectWork`, distinct from the cancel-driven path.
    const handle = bundle.harness.submit(() =>
      Effect.gen(function* () {
        yield* Effect.interrupt;
        return "unreachable";
      }),
    );
    await expect(handle.result).rejects.toMatchObject({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "cancelled",
      failure: { kind: "aborted", reason: "interrupted" },
    });
  });

  it("synchronous throw INSIDE the Effect work factory still fails the task (not the call site)", async () => {
    bundle = await fakeTasks();
    const handle = bundle.harness.submit(() => {
      // Author bug: throws before returning an Effect.
      throw new Error("factory-bug");
    });
    await expect(handle.result).rejects.toMatchObject({
      status: "failed",
      failure: { kind: "error", reason: "factory-bug" },
    });
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

describe("TasksHarness — ttl reaper (ADR 68)", () => {
  it("a still-working task whose ttl elapses is failed with kind:timeout; result rejects", async () => {
    const bundle = await fakeTasks({ sessionId: "s-ttl" });
    try {
      const handle = bundle.harness.submit(
        () => new Promise<never>(() => {}), // never completes on its own
        { ttl: 30 },
      );
      const rejection = (await drainRejection(handle.result)) as TaskRejection;
      expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
      expect(rejection.failure).toMatchObject({ kind: "timeout" });
      expect(bundle.harness.status(handle.taskId)).toBe("failed");
    } finally {
      await bundle.close();
    }
  });

  it("a task that completes before its ttl is unaffected (reaper cleared on settle)", async () => {
    const bundle = await fakeTasks({ sessionId: "s-ttl-ok" });
    try {
      const handle = bundle.harness.submit(async () => [{ type: "text", text: "done" }], {
        ttl: 10_000,
      });
      expect(await handle.result).toEqual([{ type: "text", text: "done" }]);
      expect(bundle.harness.status(handle.taskId)).toBe("completed");
    } finally {
      await bundle.close();
    }
  });
});

describe("TasksHarness — channel snapshot (ADR 87 / ChannelSnapshotProvider)", () => {
  it("snapshotChannel is task-status; channelSnapshotPayload reflects the current task set", async () => {
    const bundle = await fakeTasks({ sessionId: "s-snap" });
    try {
      expect(bundle.harness.snapshotChannel).toBe("task-status");

      // No tasks yet → an empty snapshot (seed for a subscriber that joins early).
      expect(bundle.harness.channelSnapshotPayload()).toEqual({ kind: "snapshot", tasks: [] });

      const a = bundle.harness.submit(async () => "a");
      const b = bundle.harness.submit(() => new Promise<never>(() => {})); // stays working
      void b.result.catch(() => undefined); // cancelled on close() — swallow the rejection
      await a.result;

      const snap = bundle.harness.channelSnapshotPayload();
      expect(snap.kind).toBe("snapshot");
      const byId = Object.fromEntries(snap.tasks.map((t) => [t.taskId, t.status]));
      expect(byId[a.taskId]).toBe("completed");
      expect(byId[b.taskId]).toBe("working");
    } finally {
      await bundle.close();
    }
  });
});
