/**
 * Conformance suite for {@link TaskStore} implementations (ADR 68).
 *
 * Every adapter — the bundled {@link InMemoryTaskStore}, a future
 * `@agentick/tasks-store-postgres`, any adopter-written store — MUST pass
 * this suite. The behaviors pinned here are the substrate contract the
 * {@link TasksHarness} depends on: put→get round-trip, upsert-in-place,
 * scope + status filtered `list`, delete, and (when supported) prune of
 * terminals. An adapter that diverges breaks the harness's durability +
 * re-hydration guarantees.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store`); the
 * task-specific cases (upsert, scope filter, status filter, combined, prune of
 * terminals, plus the full "delete removes a record" round-trip) are registered
 * through its `cases` hook. Mirrors `runTimelineStoreConformance`
 * (`@agentick/timeline`). Usage from an adapter package's test file:
 *
 * ```ts
 * import { runTaskStoreConformance } from "@agentick/tasks";
 * import { myTaskStore } from "../src/index.js";
 *
 * runTaskStoreConformance({ label: "my-store", factory: () => myTaskStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { TaskRecord, TaskStore } from "@agentick/spec";
import { runStoreConformance, stubStoreCtx } from "@agentick/store";

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
  runStoreConformance<TaskStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    capabilities: opts.capabilities,
    // Store-agnostic: unknown key → undefined; delete of an absent key settles.
    emptyRead: { read: (store, key) => store.get(key, stubStoreCtx()), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key, stubStoreCtx()),
    cases: ({ setup, capabilities }) => {
      it("put then get round-trips the record", async () => {
        const store = await setup();
        const r = record("task:a", { statusMessage: "hi" });
        await store.put(r, stubStoreCtx());
        expect(await store.get("task:a", stubStoreCtx())).toEqual(r);
      });

      it("put upserts in place — a later put of the same id replaces", async () => {
        const store = await setup();
        await store.put(record("task:a", { status: "working" }), stubStoreCtx());
        await store.put(
          record("task:a", { status: "completed", result: [{ type: "text", text: "ok" }] }),
          stubStoreCtx(),
        );
        const got = await store.get("task:a", stubStoreCtx());
        expect(got?.status).toBe("completed");
        expect(got?.result).toEqual([{ type: "text", text: "ok" }]);
        // Still one record, not two.
        expect(await store.list(undefined, stubStoreCtx())).toHaveLength(1);
      });

      it("list() with no query returns every record", async () => {
        const store = await setup();
        await store.put(record("task:a"), stubStoreCtx());
        await store.put(record("task:b"), stubStoreCtx());
        expect((await store.list(undefined, stubStoreCtx())).map((r) => r.taskId).sort()).toEqual([
          "task:a",
          "task:b",
        ]);
      });

      it("list() filters by scope (every provided dimension must match)", async () => {
        const store = await setup();
        await store.put(record("task:a", { scope: { sessionId: "s1" } }), stubStoreCtx());
        await store.put(record("task:b", { scope: { sessionId: "s2" } }), stubStoreCtx());
        await store.put(
          record("task:c", { scope: { sessionId: "s1", executionId: "e9" } }),
          stubStoreCtx(),
        );
        const s1 = await store.list({ scope: { sessionId: "s1" } }, stubStoreCtx());
        expect(s1.map((r) => r.taskId).sort()).toEqual(["task:a", "task:c"]);
        const narrowed = await store.list(
          { scope: { sessionId: "s1", executionId: "e9" } },
          stubStoreCtx(),
        );
        expect(narrowed.map((r) => r.taskId)).toEqual(["task:c"]);
      });

      it("list() filters by status — single value and set", async () => {
        const store = await setup();
        await store.put(record("task:a", { status: "working" }), stubStoreCtx());
        await store.put(record("task:b", { status: "completed" }), stubStoreCtx());
        await store.put(record("task:c", { status: "failed" }), stubStoreCtx());
        expect(
          (await store.list({ status: "working" }, stubStoreCtx())).map((r) => r.taskId),
        ).toEqual(["task:a"]);
        const terminal = await store.list({ status: ["completed", "failed"] }, stubStoreCtx());
        expect(terminal.map((r) => r.taskId).sort()).toEqual(["task:b", "task:c"]);
      });

      it("list() combines scope + status filters", async () => {
        const store = await setup();
        await store.put(
          record("task:a", { scope: { sessionId: "s1" }, status: "working" }),
          stubStoreCtx(),
        );
        await store.put(
          record("task:b", { scope: { sessionId: "s1" }, status: "completed" }),
          stubStoreCtx(),
        );
        await store.put(
          record("task:c", { scope: { sessionId: "s2" }, status: "working" }),
          stubStoreCtx(),
        );
        const got = await store.list(
          { scope: { sessionId: "s1" }, status: "working" },
          stubStoreCtx(),
        );
        expect(got.map((r) => r.taskId)).toEqual(["task:a"]);
      });

      it("delete() removes a record and is idempotent", async () => {
        const store = await setup();
        await store.put(record("task:a"), stubStoreCtx());
        await store.delete("task:a", stubStoreCtx());
        expect(await store.get("task:a", stubStoreCtx())).toBeUndefined();
        expect(await store.list(undefined, stubStoreCtx())).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("task:a", stubStoreCtx())).resolves.toBeUndefined();
      });

      const prune = capabilities?.prune;
      it.skipIf(prune === false)(
        "prune() drops terminal records older than the cutoff",
        async () => {
          const store = await setup();
          if (store.prune === undefined) return;
          await store.put(
            record("old-done", { status: "completed", updatedAt: 1000 }),
            stubStoreCtx(),
          );
          await store.put(
            record("old-working", { status: "working", updatedAt: 1000 }),
            stubStoreCtx(),
          );
          await store.put(
            record("new-done", { status: "completed", updatedAt: 5000 }),
            stubStoreCtx(),
          );
          await store.prune(3000, stubStoreCtx());
          const remaining = (await store.list(undefined, stubStoreCtx()))
            .map((r) => r.taskId)
            .sort();
          // Terminal + old → pruned. In-flight (even if old) survives. New survives.
          expect(remaining).toEqual(["new-done", "old-working"]);
        },
      );
    },
  });
}
