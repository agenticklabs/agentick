/**
 * `fsTimelineStore` runs the shared {@link runTimelineStoreConformance}
 * suite against a REAL temp directory — real files, real `appendFile` /
 * `readFile` / `rm`. No fakes. Each test gets a fresh `mkdtemp` dir; an
 * `afterEach` removes it.
 *
 * This suite MUST pass green in any environment (no external dependency) —
 * it is the proof the JSONL adapter reproduces MemoryTimelineStore's
 * append-only / `seq` / prune semantics exactly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";
import { runTimelineStoreConformance } from "@agentick/timeline";

import { fsTimelineStore } from "../store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

runTimelineStoreConformance({
  label: "fs",
  factory: async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-timeline-fs-"));
    dirs.push(dir);
    return fsTimelineStore({ dir });
  },
});
