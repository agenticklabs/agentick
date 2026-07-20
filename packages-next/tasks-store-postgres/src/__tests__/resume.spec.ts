/**
 * The cross-process resume PROOF — what the in-memory store CANNOT
 * demonstrate. The whole point of the pg tier (ADR 68): task records
 * outlive the process, so a fresh `TasksHarness` over the SAME pg
 * table sees the prior run's records and does honest orphan accounting.
 *
 * Two unlocks, each modeled as harness #1 (the "old process") →
 * abandon/close → harness #2 (a "new process") over a FRESH
 * `postgresTaskStore` adapter on the SAME pool + table:
 *
 *   1. **interrupted-on-restart fires for real** — harness #1 submits an
 *      in-process task that never settles, then is abandoned WITHOUT
 *      `close()` (a graceful close would cancel it; we want the orphaned
 *      `working` record). Harness #2 hydrates: the in-process executor
 *      can't reattach a lost fiber (`reattach` → undefined), so the
 *      orphan is marked `interrupted`. With the in-memory store this
 *      path is a same-process no-op; here it crosses the durable plane.
 *
 *   2. **terminal adoption across restart** — harness #1 submits a task
 *      that COMPLETES; harness #2 hydrates the terminal record and
 *      `result()` returns the stored blocks decoded from pg (NOT from a
 *      live fiber).
 *
 * GATED on `TASKS_PG_URL`, same as the conformance suite. Absent → the
 * whole describe registers skipped.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { fakeTasks } from "@agentick/tasks-next/testing";
import { stubStoreCtx } from "@agentick/store-next";

import { postgresTaskStore } from "../store.ts";

const url = process.env.TASKS_PG_URL;
const pool = url ? new Pool({ connectionString: url }) : undefined;
const tables: string[] = [];
let counter = 0;

/** Fresh per-test table, shared across the two harnesses of that test. */
function freshTable(): string {
  const table = `agentick_tasks_resume_${process.pid}_${++counter}`;
  tables.push(table);
  return table;
}

/** Poll an async predicate until true (the harness `persist` is
 *  fire-and-forget, so a durable pg write is NOT landed when `submit` /
 *  `result` return — we must wait for it, not race it). */
async function until(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5_000, pollMs = 20 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`until: predicate did not become true within ${timeoutMs}ms`);
}

afterAll(async () => {
  if (!pool) return;
  for (const t of tables) {
    await pool.query(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
  }
  await pool.end();
});

describe.skipIf(pool === undefined)("postgresTaskStore — cross-process resume (ADR 68)", () => {
  it("interrupted-on-restart fires for real over a shared pg table", async () => {
    const table = freshTable();
    const sessionId = "resume-interrupt";

    // ── "old process": harness #1 with a durable pg store ──
    const store1 = postgresTaskStore({ executor: pool!, table, migrate: "create-if-absent" });
    const b1 = await fakeTasks({ sessionId, store: store1 });
    await b1.harness.hydrated;

    // A long-running in-process task that never settles on its own.
    const handle = b1.harness.submit(
      ({ signal }) =>
        new Promise<readonly []>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    // Do NOT let the pending result surface as an unhandled rejection when
    // (if) the abandoned harness ever aborts — it won't here, but be safe.
    void handle.result.catch(() => undefined);

    // Await the DURABLE write — persist is fire-and-forget.
    await until(
      async () => (await store1.get(handle.taskId, stubStoreCtx()))?.status === "working",
    );

    // ── CRASH: abandon harness #1 WITHOUT close() → orphaned `working`. ──

    // ── "new process": harness #2 over a FRESH adapter, SAME pool+table. ──
    const store2 = postgresTaskStore({ executor: pool!, table, migrate: "create-if-absent" });
    const b2 = await fakeTasks({ sessionId, store: store2 });
    await b2.harness.hydrated;

    // The orphan is marked interrupted — in the projection (synchronous
    // after hydrated) AND durably in pg (hydration's re-persist is itself
    // fire-and-forget, so poll the durable write rather than race it).
    expect(b2.harness.status(handle.taskId)).toBe("interrupted");
    await until(
      async () => (await store2.get(handle.taskId, stubStoreCtx()))?.status === "interrupted",
    );
    await expect(b2.harness.result(handle.taskId)).rejects.toMatchObject({
      _tag: "TaskRejection",
      taskId: handle.taskId,
      status: "interrupted",
    });

    await b2.close();
  });

  it("terminal adoption across restart returns the stored result from pg", async () => {
    const table = freshTable();
    const sessionId = "resume-terminal";
    const blocks = [{ type: "text", text: "done-across-restart" }] as const;

    // ── "old process": submit a task that completes. ──
    const store1 = postgresTaskStore({ executor: pool!, table, migrate: "create-if-absent" });
    const b1 = await fakeTasks({ sessionId, store: store1 });
    await b1.harness.hydrated;

    const handle = b1.harness.submit(async () => blocks);
    await handle.result;
    await until(
      async () => (await store1.get(handle.taskId, stubStoreCtx()))?.status === "completed",
    );
    await b1.close(); // graceful — already terminal, nothing to cancel.

    // ── "new process": harness #2 hydrates the terminal record. ──
    const store2 = postgresTaskStore({ executor: pool!, table, migrate: "create-if-absent" });
    const b2 = await fakeTasks({ sessionId, store: store2 });
    await b2.harness.hydrated;

    expect(b2.harness.get(handle.taskId)?.status).toBe("completed");
    // Result is decoded from pg jsonb, not carried by a live fiber.
    expect(await b2.harness.result(handle.taskId)).toEqual(blocks);

    await b2.close();
  });
});
