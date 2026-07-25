/**
 * #139 — kill-and-resume acceptance, run against every store pole (ADR 49).
 *
 * The suite body lives in `@agentick/session/testing`
 * (`runKillResumeAcceptance`); this file wires it to each backing. Per the
 * `makeStore` contract, each pole returns a store over a durable backing
 * SHARED across calls within one test — so a second `makeStore()` models a
 * fresh process/replica opening the same durable state:
 *
 *   - **memory** — the SAME `MemoryTimelineStore` instance (in-process
 *     durability; the shared JS object IS the backing). MUST pass.
 *   - **fs** — a new `fsTimelineStore` over the SAME `mkdtemp` dir. Real
 *     files on disk. MUST pass.
 *   - **postgres** — a new `postgresTimelineStore` over the SAME pool +
 *     table. Registers SKIPPED without `TIMELINE_PG_URL` (honest, like the
 *     store-conformance / docker suites), so CI without a database stays
 *     green.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { MemoryTimelineStore, type TimelineStore } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";
import { postgresTimelineStore } from "@agentick/timeline-postgres";
import { runKillResumeAcceptance } from "../testing/index.js";

// ── memory ──────────────────────────────────────────────────────────────
// One shared instance — a second makeStore() is the same durable object,
// modelling a resume within the same process against in-memory durability.
const memoryStore = new MemoryTimelineStore();
runKillResumeAcceptance({ label: "memory", makeStore: () => memoryStore });

// ── fs ──────────────────────────────────────────────────────────────────
// One shared temp dir for the whole file; each makeStore() is a fresh
// adapter over the SAME dir (the filesystem is the shared backing).
const fsDir = mkdtempSync(join(tmpdir(), "agentick-kill-resume-"));
runKillResumeAcceptance({ label: "fs", makeStore: () => fsTimelineStore({ dir: fsDir }) });
afterAll(() => {
  rmSync(fsDir, { recursive: true, force: true });
});

// ── postgres ──────────────────────────────────────────────────────────────
// Skipped without a real database. When present, each makeStore() is a
// fresh adapter over the SAME pool + a per-run table (create-if-absent),
// so the two "processes" share the durable backing and runs stay isolated.
const pgUrl = process.env.TIMELINE_PG_URL;
const pgTable = `agentick_kill_resume_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let pgPool: import("pg").Pool | undefined;

async function makePgStore(): Promise<TimelineStore> {
  if (!pgPool) {
    const { Pool } = await import("pg");
    pgPool = new Pool({ connectionString: pgUrl });
  }
  return postgresTimelineStore({
    executor: pgPool,
    table: pgTable,
    migrate: "create-if-absent",
  });
}

runKillResumeAcceptance({ label: "postgres", makeStore: makePgStore, skip: !pgUrl });

afterAll(async () => {
  if (pgPool) {
    await pgPool.query(`DROP TABLE IF EXISTS "${pgTable}"`).catch(() => {});
    await pgPool.end().catch(() => {});
  }
});
