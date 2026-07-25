/**
 * `postgresTimelineStore` runs the shared {@link runTimelineStoreConformance}
 * suite against a REAL Postgres — real IDENTITY, real jsonb. No fakes: no
 * pg-mem, no in-memory Postgres stand-in (they don't honor IDENTITY / jsonb
 * faithfully, so a green there would be a lie).
 *
 * GATED on availability, exactly like `sandbox-docker`'s `docker info`
 * probe: a `TIMELINE_PG_URL` connection string must be present. Absent, the
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
import { runTimelineStoreConformance } from "@agentick/timeline";

import { postgresTimelineStore } from "../store.js";

const url = process.env.TIMELINE_PG_URL;
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

runTimelineStoreConformance({
  label: url ? "postgres" : "postgres (skipped: TIMELINE_PG_URL unset)",
  skip: pool === undefined,
  factory: () => {
    // Only reached when the suite is NOT skipped, i.e. pool is defined.
    const table = `agentick_timeline_test_${process.pid}_${++counter}`;
    tables.push(table);
    return postgresTimelineStore({ executor: pool!, table, migrate: "create-if-absent" });
  },
});
