/**
 * ADR 68 durability layer — the NEW behaviors the record-as-source-of-
 * truth refactor introduces, on top of the (unchanged) harness parity
 * suite:
 *
 *   1. `runTaskStoreConformance(InMemoryTaskStore)` — the store port.
 *   2. detached-survives-close: a `detached: true` task is NOT aborted on
 *      `close()` and its record persists in the shared store; a
 *      non-detached task IS aborted.
 *   3. get/list served from the store projection (scope-filtered).
 *   4. interrupted-on-hydration: a store pre-seeded with an orphaned
 *      `working` record → a freshly-constructed harness marks it
 *      `interrupted` (no reattachable in-process executor).
 */

import { afterEach, describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { TaskRecord } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";
import { drainRejection } from "@agentick/utils/testing";

import { InMemoryTaskStore } from "../store.js";
import { runTaskStoreConformance } from "../store-conformance.js";
import { TasksHarness } from "../harness.js";

// ── 1. Store port conformance ──────────────────────────────────────────
runTaskStoreConformance({ label: "InMemoryTaskStore", factory: () => new InMemoryTaskStore() });

// ── Shared harness-on-a-store fixture ───────────────────────────────────
function mkHarness(store: InMemoryTaskStore, sessionId: string): TasksHarness {
  return new TasksHarness(
    `${sessionId}:tasks`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { parentScope: { sessionId }, store },
  );
}

// ── 2. detached survives close; non-detached is aborted ─────────────────
describe("TasksHarness — detached lifetime (ADR 68)", () => {
  let harness: TasksHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.close();
    harness = undefined;
  });

  it("close() leaves a detached task running + persisted; aborts a non-detached one", async () => {
    const store = new InMemoryTaskStore();
    harness = mkHarness(store, "s-detach");
    await harness.hydrated;

    let releaseDetached: (v: string) => void = () => {};
    const detached = harness.submit(
      // Stays pending until released. A detached task is NOT aborted on
      // close(), so this survives across close() and completes later.
      () => new Promise<string>((resolve) => (releaseDetached = resolve)),
      { detached: true },
    );
    const normal = harness.submit(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "unreachable";
    });
    // Pre-drain the non-detached rejection.
    const normalDrained = drainRejection(normal.result);

    await new Promise((r) => setTimeout(r, 0));
    expect(harness.pendingCount()).toBe(2);

    await harness.close();

    // Non-detached: aborted with reason harness_closed.
    await expect(normalDrained).resolves.toMatchObject({ status: "cancelled" });
    expect(harness.get(normal.taskId)?.failure?.reason).toBe("harness_closed");

    // Detached: STILL working, record persisted in the shared store.
    expect(harness.get(detached.taskId)?.status).toBe("working");
    const persisted = await store.get(detached.taskId, stubStoreCtx());
    expect(persisted?.status).toBe("working");
    expect(persisted?.detached).toBe(true);

    // It runs to completion after close (the store record follows it).
    releaseDetached("done-after-close");
    expect(await detached.result).toBe("done-after-close");
    expect((await store.get(detached.taskId, stubStoreCtx()))?.status).toBe("completed");
  });

  it("every transition is persisted to the store (get/list are the store projection)", async () => {
    const store = new InMemoryTaskStore();
    harness = mkHarness(store, "s-persist");
    await harness.hydrated;

    const handle = harness.submit(async () => 42);
    // Initial working record is in the store synchronously after submit.
    expect((await store.get(handle.taskId, stubStoreCtx()))?.status).toBe("working");
    await handle.result;
    expect((await store.get(handle.taskId, stubStoreCtx()))?.status).toBe("completed");

    // list() reflects the harness's scope-filtered projection.
    expect(harness.list().map((t) => t.taskId)).toEqual([handle.taskId]);
    // The store holds it under this session's scope.
    const scoped = await store.list({ scope: { sessionId: "s-persist" } }, stubStoreCtx());
    expect(scoped.map((r) => r.taskId)).toEqual([handle.taskId]);
  });
});

// ── 2b. ttl reaper lifetime across close ────────────────────────────────
describe("TasksHarness — ttl reaper lifetime across close (ADR 68)", () => {
  it("a surviving detached task KEEPS its deadline after close", async () => {
    // The deliberate exception to "a task this harness stopped serving holds no
    // timer". A detached task outlives the session by contract, so the ttl that
    // BOUNDS it has to outlive the session too — disarming the reaper at close
    // would hand a detached task an unbounded lifetime, which is the worse leak.
    const store = new InMemoryTaskStore();
    const harness = mkHarness(store, "s-ttl-detached");
    await harness.hydrated;

    const handle = harness.submit(() => new Promise<string>(() => {}), {
      detached: true,
      ttl: 20,
    });
    const outcome = drainRejection(handle.result);

    await harness.close();
    // Survived close, still running.
    expect(harness.get(handle.taskId)?.status).toBe("working");

    // …and its deadline still lands.
    await expect(outcome).resolves.toMatchObject({ status: "failed" });
    expect(harness.get(handle.taskId)?.failure?.kind).toBe("timeout");
    const persisted = await store.get(handle.taskId, stubStoreCtx());
    expect(persisted?.status).toBe("failed");
    expect(persisted?.failure?.kind).toBe("timeout");
  });

  it("cancelling a detached task disarms its reaper — the deadline never rewrites the outcome", async () => {
    // The path `app.destroySession` takes: destroy cancels the detached tasks
    // close abandons, and that cancellation must take the timer with it, or a
    // reaper fires later against a task nobody is serving.
    const store = new InMemoryTaskStore();
    const harness = mkHarness(store, "s-ttl-cancelled");
    await harness.hydrated;

    const handle = harness.submit(() => new Promise<string>(() => {}), {
      detached: true,
      ttl: 20,
    });
    const outcome = drainRejection(handle.result);

    await harness.cancel(handle.taskId, "destroyed");
    await expect(outcome).resolves.toMatchObject({ status: "cancelled" });
    await harness.close();

    // Well past the ttl: the outcome is still the cancellation, with its reason
    // intact — the reaper did not run and did not relabel it a timeout.
    await new Promise((r) => setTimeout(r, 60));
    expect(harness.get(handle.taskId)?.status).toBe("cancelled");
    expect(harness.get(handle.taskId)?.failure?.reason).toBe("destroyed");
    expect((await store.get(handle.taskId, stubStoreCtx()))?.status).toBe("cancelled");
  });
});

// ── 3. Shared store isolates sessions; no cross-session list bleed ───────
describe("TasksHarness — shared app-scoped store isolation (ADR 68)", () => {
  it("two harnesses on one store each list only their own scope", async () => {
    const store = new InMemoryTaskStore();
    const a = mkHarness(store, "sess-a");
    const b = mkHarness(store, "sess-b");
    await Promise.all([a.hydrated, b.hydrated]);
    try {
      const ha = a.submit(async () => "a");
      const hb = b.submit(async () => "b");
      await Promise.all([ha.result, hb.result]);
      expect(a.list().map((t) => t.taskId)).toEqual([ha.taskId]);
      expect(b.list().map((t) => t.taskId)).toEqual([hb.taskId]);
      // The store holds both.
      expect((await store.list(undefined, stubStoreCtx())).map((r) => r.taskId).sort()).toEqual(
        [ha.taskId, hb.taskId].sort(),
      );
    } finally {
      await a.close();
      await b.close();
    }
  });
});

// ── 4. interrupted-on-hydration ─────────────────────────────────────────
describe("TasksHarness — interrupted on hydration (ADR 68)", () => {
  it("an orphaned 'working' store record is marked interrupted on construction", async () => {
    const store = new InMemoryTaskStore();
    const now = Date.now();
    // Simulate a record left behind by a prior run (no live executor).
    const orphan: TaskRecord = {
      taskId: "task:orphan",
      status: "working",
      scope: { sessionId: "s-hydrate" },
      executorKind: "in-process",
      detached: false,
      ttl: null,
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    };
    await store.put(orphan, stubStoreCtx());

    const harness = mkHarness(store, "s-hydrate");
    try {
      await harness.hydrated;
      // Projection + store both report interrupted.
      expect(harness.status("task:orphan")).toBe("interrupted");
      expect(harness.get("task:orphan")?.failure?.reason).toBe("interrupted");
      expect((await store.get("task:orphan", stubStoreCtx()))?.status).toBe("interrupted");
      // result() on the orphan rejects with an interrupted TaskRejection.
      await expect(harness.result("task:orphan")).rejects.toMatchObject({
        _tag: "TaskRejection",
        taskId: "task:orphan",
        status: "interrupted",
      });
    } finally {
      await harness.close();
    }
  });

  it("terminal records from a prior run are surfaced read-only (not re-interrupted)", async () => {
    const store = new InMemoryTaskStore();
    const now = Date.now();
    const done: TaskRecord = {
      taskId: "task:done",
      status: "completed",
      scope: { sessionId: "s-hydrate2" },
      executorKind: "in-process",
      detached: false,
      ttl: null,
      result: [{ type: "text", text: "prior" }],
      createdAt: now - 10_000,
      updatedAt: now - 9_000,
    };
    await store.put(done, stubStoreCtx());

    const harness = mkHarness(store, "s-hydrate2");
    try {
      await harness.hydrated;
      expect(harness.status("task:done")).toBe("completed");
      expect(await harness.result("task:done")).toEqual([{ type: "text", text: "prior" }]);
    } finally {
      await harness.close();
    }
  });
});
