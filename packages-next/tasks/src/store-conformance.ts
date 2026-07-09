/**
 * Conformance suite for {@link TaskStore} implementations (ADR 68).
 *
 * Every adapter — the bundled {@link InMemoryTaskStore}, a future
 * `@agentick/tasks-store-postgres-next`, any adopter-written store — MUST pass
 * this suite. The behaviors pinned here are the substrate contract the
 * {@link TasksHarness} depends on: put→get round-trip, upsert-in-place,
 * scope + status filtered `list`, delete, and (when supported) prune of
 * terminals. An adapter that diverges breaks the harness's durability +
 * re-hydration guarantees.
 *
 * Mirrors `runTimelineStoreConformance` (`@agentick/timeline-next`). Usage
 * from an adapter package's test file:
 *
 * ```ts
 * import { runTaskStoreConformance } from "@agentick/tasks-next";
 * import { myTaskStore } from "../src/index.js";
 *
 * runTaskStoreConformance({ label: "my-store", factory: () => myTaskStore() });
 * ```
 */

import { describe, expect, it } from "vitest";

import type { TaskRecord, TaskStore } from "@agentick/spec-next";

export interface TaskStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => TaskStore | Promise<TaskStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a
   * store). For adapters whose backend may be absent in the test env —
   * compute availability at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
  /** Capabilities the suite skips if unsupported. */
  readonly capabilities?: {
    /** `prune` supported — defaults to `typeof store.prune === "function"`. */
    readonly prune?: boolean;
  };
}

/** Minimal well-formed record — the store treats records as opaque blobs. */
function record(taskId: string, over: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId,
    status: "working",
    scope: {},
    executorKind: "in-process",
    detached: false,
    ttl: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function runTaskStoreConformance(opts: TaskStoreConformanceOptions): void {
  const setup = async (): Promise<TaskStore> => opts.factory();
  const suite = opts.skip ? describe.skip : describe;

  suite(`TaskStore conformance — ${opts.label}`, () => {
    it("reports a stable, non-empty backend identifier", async () => {
      const store = await setup();
      expect(typeof store.backend).toBe("string");
      expect(store.backend.length).toBeGreaterThan(0);
    });

    it("get() returns undefined for an unknown task", async () => {
      const store = await setup();
      expect(await store.get("task:never-seen")).toBeUndefined();
    });

    it("put then get round-trips the record", async () => {
      const store = await setup();
      const r = record("task:a", { statusMessage: "hi" });
      await store.put(r);
      expect(await store.get("task:a")).toEqual(r);
    });

    it("put upserts in place — a later put of the same id replaces", async () => {
      const store = await setup();
      await store.put(record("task:a", { status: "working" }));
      await store.put(
        record("task:a", { status: "completed", result: [{ type: "text", text: "ok" }] }),
      );
      const got = await store.get("task:a");
      expect(got?.status).toBe("completed");
      expect(got?.result).toEqual([{ type: "text", text: "ok" }]);
      // Still one record, not two.
      expect(await store.list()).toHaveLength(1);
    });

    it("list() with no query returns every record", async () => {
      const store = await setup();
      await store.put(record("task:a"));
      await store.put(record("task:b"));
      expect((await store.list()).map((r) => r.taskId).sort()).toEqual(["task:a", "task:b"]);
    });

    it("list() filters by scope (every provided dimension must match)", async () => {
      const store = await setup();
      await store.put(record("task:a", { scope: { sessionId: "s1" } }));
      await store.put(record("task:b", { scope: { sessionId: "s2" } }));
      await store.put(record("task:c", { scope: { sessionId: "s1", executionId: "e9" } }));
      const s1 = await store.list({ scope: { sessionId: "s1" } });
      expect(s1.map((r) => r.taskId).sort()).toEqual(["task:a", "task:c"]);
      const narrowed = await store.list({ scope: { sessionId: "s1", executionId: "e9" } });
      expect(narrowed.map((r) => r.taskId)).toEqual(["task:c"]);
    });

    it("list() filters by status — single value and set", async () => {
      const store = await setup();
      await store.put(record("task:a", { status: "working" }));
      await store.put(record("task:b", { status: "completed" }));
      await store.put(record("task:c", { status: "failed" }));
      expect((await store.list({ status: "working" })).map((r) => r.taskId)).toEqual(["task:a"]);
      const terminal = await store.list({ status: ["completed", "failed"] });
      expect(terminal.map((r) => r.taskId).sort()).toEqual(["task:b", "task:c"]);
    });

    it("list() combines scope + status filters", async () => {
      const store = await setup();
      await store.put(record("task:a", { scope: { sessionId: "s1" }, status: "working" }));
      await store.put(record("task:b", { scope: { sessionId: "s1" }, status: "completed" }));
      await store.put(record("task:c", { scope: { sessionId: "s2" }, status: "working" }));
      const got = await store.list({ scope: { sessionId: "s1" }, status: "working" });
      expect(got.map((r) => r.taskId)).toEqual(["task:a"]);
    });

    it("delete() removes a record and is idempotent", async () => {
      const store = await setup();
      await store.put(record("task:a"));
      await store.delete("task:a");
      expect(await store.get("task:a")).toBeUndefined();
      expect(await store.list()).toEqual([]);
      // Second delete: absent → resolves, no throw.
      await expect(store.delete("task:a")).resolves.toBeUndefined();
    });

    const prune = opts.capabilities?.prune;
    it.skipIf(prune === false)("prune() drops terminal records older than the cutoff", async () => {
      const store = await setup();
      if (store.prune === undefined) return;
      await store.put(record("old-done", { status: "completed", updatedAt: 1000 }));
      await store.put(record("old-working", { status: "working", updatedAt: 1000 }));
      await store.put(record("new-done", { status: "completed", updatedAt: 5000 }));
      await store.prune(3000);
      const remaining = (await store.list()).map((r) => r.taskId).sort();
      // Terminal + old → pruned. In-flight (even if old) survives. New survives.
      expect(remaining).toEqual(["new-done", "old-working"]);
    });
  });
}
