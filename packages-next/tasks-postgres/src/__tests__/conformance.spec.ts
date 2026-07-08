/**
 * `postgresTaskStore` runs the shared {@link runTaskStoreConformance} suite
 * against a REAL Postgres — real jsonb, real `@>` containment, real GIN /
 * btree indexes. No fakes: no pg-mem, no in-memory Postgres stand-in (they
 * don't honor jsonb containment faithfully, so a green there would be a
 * lie).
 *
 * GATED on availability, exactly like `timeline-postgres`'s `TIMELINE_PG_URL`
 * probe: a `TASKS_PG_URL` connection string must be present. Absent, the
 * suite registers as **skipped** (threaded through the conformance suite's
 * own `skip` option — not a test-body `if`, which the linter forbids). That
 * is the correct, honest outcome in an env without a real Postgres,
 * matching the docker / lambda suites.
 *
 * Isolation: each store instance gets a FRESH uniquely-named table
 * (`migrate: "create-if-absent"`); an `afterAll` drops every table created.
 */

import { afterAll } from "vitest";
import { Pool } from "pg";
import { runTaskStoreConformance } from "@agentick/tasks-next";

import { postgresTaskStore } from "../store.js";

const url = process.env.TASKS_PG_URL;
// Lazily constructed only when a real backend is configured.
const pool = url ? new Pool({ connectionString: url }) : undefined;
const tables: string[] = [];
let counter = 0;

afterAll(async () => {
  if (!pool) return;
  for (const t of tables) {
    await pool.query(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
  }
  await pool.end();
});

runTaskStoreConformance({
  label: url ? "postgres" : "postgres (skipped: TASKS_PG_URL unset)",
  skip: pool === undefined,
  factory: () => {
    // Only reached when the suite is NOT skipped, i.e. pool is defined.
    const table = `agentick_tasks_test_${process.pid}_${++counter}`;
    tables.push(table);
    return postgresTaskStore({ executor: pool!, table, migrate: "create-if-absent" });
  },
});
