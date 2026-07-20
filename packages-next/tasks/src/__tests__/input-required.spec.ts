/**
 * `input_required` transition (#120-followup, ADR 68).
 *
 * A task's work fn opts into the paused-on-external-input state by wrapping
 * the await in `ctx.awaitingInput(promise, { message? })`. The task flips
 * `working → input_required → working` through the SAME `report` seam as
 * `onProgress` / `setStatusMessage` — no `TaskTransition` widening, no
 * special-casing in `applyTransition`. Proven here end-to-end on the
 * in-process executor:
 *
 *   - the status timeline (working → input_required → working → completed);
 *   - the durable store record reflects `input_required` WHILE paused;
 *   - the bus emits a status event for the paused state;
 *   - a cancel WHILE paused lands terminal `cancelled` — the `finally`'s
 *     `working` report is a post-terminal no-op, not a strand.
 */

import { Chunk, Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalEventBus } from "@agentick/runtime-next";
import type { ProtocolEvent, TaskInfo } from "@agentick/spec-next";
import { drainRejection, waitFor } from "@agentick/utils-next/testing";
import { stubStoreCtx } from "@agentick/store-next";

import { TASK_STATUS_CHANNEL_FQN } from "../channel.js";
import { InMemoryTaskStore } from "../store.js";
import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function takeStatusEnvelopes(bus: LocalEventBus, n: number): Promise<readonly ProtocolEvent[]> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: TASK_STATUS_CHANNEL_FQN },
        }) as Stream.Stream<ProtocolEvent, unknown, never>,
        n,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c)));
}

describe("TasksHarness — input_required (awaitingInput)", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("flips working → input_required → working → completed; store + bus reflect the paused state", async () => {
    const store = new InMemoryTaskStore();
    bundle = await fakeTasks({ store });
    const gate = makeDeferred<string>();

    // 4 status envelopes: working (submit), input_required (awaitingInput),
    // working (finally-restore), completed (return).
    const envsP = takeStatusEnvelopes(bundle.bus, 4);

    const handle = bundle.harness.submit(async (ctx) => {
      const provided = await ctx.awaitingInput(gate.promise, { message: "need input" });
      return [{ type: "text", text: provided }];
    });

    // The work fn called awaitingInput synchronously during start() → the
    // task is paused BEFORE submit returned.
    expect(bundle.harness.status(handle.taskId)).toBe("input_required");
    expect(bundle.harness.get(handle.taskId)?.statusMessage).toBe("need input");

    // The durable record reflects the paused state (the store put landed).
    await waitFor(
      async () => (await store.get(handle.taskId, stubStoreCtx()))?.status === "input_required",
    );
    expect((await store.get(handle.taskId, stubStoreCtx()))?.statusMessage).toBe("need input");

    // Provide the input → back to working, then completes.
    gate.resolve("hello");
    const result = await handle.result;
    expect(result).toEqual([{ type: "text", text: "hello" }]);
    expect(bundle.harness.status(handle.taskId)).toBe("completed");

    const infos = (await envsP).map((e) => e.payload as TaskInfo);
    expect(infos.map((i) => i.status)).toEqual([
      "working",
      "input_required",
      "working",
      "completed",
    ]);
    // The bus status event for the paused state carries the statusMessage.
    expect(infos[1]!.status).toBe("input_required");
    expect(infos[1]!.statusMessage).toBe("need input");
  });

  it("cancel WHILE input_required lands terminal cancelled; the finally's working report is a no-op", async () => {
    bundle = await fakeTasks();
    const gate = makeDeferred<string>();
    let workReturned = false;

    const handle = bundle.harness.submit(async (ctx) => {
      const provided = await ctx.awaitingInput(gate.promise, { message: "need input" });
      workReturned = true;
      return [{ type: "text", text: provided }];
    });
    expect(bundle.harness.status(handle.taskId)).toBe("input_required");

    // Cancel the paused task — the caller's `cancelled` transition wins.
    const rejected = drainRejection(handle.result);
    await bundle.harness.cancel(handle.taskId, "user-abort");
    expect(bundle.harness.status(handle.taskId)).toBe("cancelled");
    expect(await rejected).toMatchObject({ _tag: "TaskRejection", status: "cancelled" });

    // Releasing the gate now fires the awaitingInput `finally` (report
    // working) AND the work's completed report — both POST-TERMINAL, so
    // `applyTransition` ignores them. The task must NOT revert.
    gate.resolve("late");
    await waitFor(() => workReturned); // the work fn ran to completion after cancel
    expect(bundle.harness.status(handle.taskId)).toBe("cancelled");
    expect(bundle.harness.get(handle.taskId)?.failure?.reason).toBe("user-abort");
  });
});

describe("TasksHarness — awaitingInput(Effect) real interruptibility (ADR 69 T2a)", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("an Effect pause flips working → input_required → working → completed and resolves with the Effect's value", async () => {
    bundle = await fakeTasks();
    const gate = makeDeferred<string>();

    const envsP = takeStatusEnvelopes(bundle.bus, 4);

    const handle = bundle.harness.submit(async (ctx) => {
      // Effect overload — a pause expressed as an Effect (not a Promise).
      const provided = await ctx.awaitingInput(
        Effect.promise(() => gate.promise),
        {
          message: "awaiting effect",
        },
      );
      return [{ type: "text", text: provided }];
    });

    expect(bundle.harness.status(handle.taskId)).toBe("input_required");
    expect(bundle.harness.get(handle.taskId)?.statusMessage).toBe("awaiting effect");

    gate.resolve("effect-value");
    const result = await handle.result;
    expect(result).toEqual([{ type: "text", text: "effect-value" }]);
    expect(bundle.harness.status(handle.taskId)).toBe("completed");

    const infos = (await envsP).map((e) => e.payload as TaskInfo);
    expect(infos.map((i) => i.status)).toEqual([
      "working",
      "input_required",
      "working",
      "completed",
    ]);
  });

  it("a cancel WHILE paused on an Effect INTERRUPTS the Effect fiber (onInterrupt finalizer fires) and lands terminal cancelled", async () => {
    bundle = await fakeTasks();
    let interrupted = false;

    // A never-completing pause with a real interrupt finalizer. On the
    // Promise path this would hang forever ignoring the signal; on the
    // Effect path the task's `signal` (aborted by cancel) natively
    // `Fiber.interrupt`s it, so `onInterrupt` runs.
    const paused = Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    );

    const handle = bundle.harness.submit(async (ctx) => {
      const v = await ctx.awaitingInput(paused, { message: "awaiting effect" });
      return [{ type: "text", text: String(v) }];
    });
    expect(bundle.harness.status(handle.taskId)).toBe("input_required");

    const rejected = drainRejection(handle.result);
    await bundle.harness.cancel(handle.taskId, "user-abort");
    expect(bundle.harness.status(handle.taskId)).toBe("cancelled");
    expect(await rejected).toMatchObject({ _tag: "TaskRejection", status: "cancelled" });

    // The proof of REAL interruptibility (vs AbortSignal-flag-only): the
    // Effect's finalizer ran because its fiber was interrupted.
    await waitFor(() => interrupted);
    expect(interrupted).toBe(true);
  });
});
