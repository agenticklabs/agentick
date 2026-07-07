/**
 * fs-specific restart durability (NOT part of the shared conformance suite —
 * this simulates a *process restart* by constructing a brand-new
 * `fsTimelineStore` over the SAME directory, so its in-memory `seq` cursor
 * starts cold).
 *
 * The frozen `seq` contract requires "never reused — emptying a session
 * never lets a future append reuse a retired `seq`". A naive file adapter
 * would lose the high-water mark once `prune` empties the transcript (no
 * line left to re-seed from) and restart `seq` at 0 — silently colliding
 * with retired seqs and dropping entries from a consumer holding a
 * `history({ fromSeq })` cursor. The `.hwm` sidecar closes that gap; these
 * tests prove it.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimelineEntry } from "@agentick/timeline-next";

import { fsTimelineStore } from "../store.js";

function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}
const idOf = (e: TimelineEntry): string => (e as { message: { id: string } }).message.id;

describe("fsTimelineStore — restart durability across prune-to-empty", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentick-timeline-fs-restart-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a cold instance continues seq past pruned-away entries (no reuse)", async () => {
    const first = fsTimelineStore({ dir });
    const seqs = await first.append("s1", [entry("a"), entry("b"), entry("c")]);
    expect(seqs).toEqual([0, 1, 2]);

    // Erase everything — the transcript is now empty.
    const removed = await first.prune!("s1", { seq: 3 });
    expect(removed).toBe(3);
    expect(await first.load("s1")).toEqual([]);

    // Simulate a process restart: a brand-new store over the SAME dir has a
    // cold cursor and must recover the high-water mark from the sidecar.
    const second = fsTimelineStore({ dir });
    expect(await second.load("s1")).toEqual([]); // still empty after "restart"

    const [sd] = await second.append("s1", [entry("d")]);
    expect(sd).toBe(3); // continues past c (seq 2) — NOT restarted at 0
    expect((await second.load("s1")).map(idOf)).toEqual(["d"]);
  });

  it("a cursor held across the restart still sees the new entry", async () => {
    const first = fsTimelineStore({ dir });
    await first.append("s2", [entry("a"), entry("b"), entry("c")]); // 0,1,2
    await first.prune!("s2", { seq: 3 }); // empty

    const second = fsTimelineStore({ dir });
    const [sd] = await second.append("s2", [entry("d")]);
    expect(sd).toBe(3);

    // A consumer that recorded fromSeq=3 before the crash finds exactly the
    // new entry at its true seq — it is NOT hidden behind a reused seq 0.
    const page = await second.history!("s2", { fromSeq: 3 });
    expect(page).toEqual([{ seq: 3, entry: entry("d") }]);
    // And a full scan from 0 sees only the surviving entry, tagged seq 3.
    const all = await second.history!("s2", { fromSeq: 0 });
    expect(all.map((t) => t.seq)).toEqual([3]);
  });

  it("delete after prune-to-empty ends the session — a later append restarts at 0", async () => {
    const first = fsTimelineStore({ dir });
    await first.append("s3", [entry("a"), entry("b")]); // 0,1
    await first.prune!("s3", { seq: 2 }); // empty, hwm sidecar = 2

    // delete must report the pruned-empty session as present (matches
    // MemoryTimelineStore) and remove BOTH the transcript and the sidecar.
    expect(await first.delete("s3")).toBe(true);

    const second = fsTimelineStore({ dir });
    const [sa] = await second.append("s3", [entry("a2")]);
    expect(sa).toBe(0); // delete ended the session → fresh sequence
  });

  it("sessions() never enumerates the .hwm sidecar", async () => {
    const store = fsTimelineStore({ dir });
    await store.append("s4", [entry("a")]); // 0
    await store.prune!("s4", { seq: 1 }); // empty + writes s4.hwm

    // The sidecar exists on disk...
    const names = await readdir(dir);
    expect(names.some((n) => n.endsWith(".hwm"))).toBe(true);
    // ...but a pruned-empty session holds nothing, so it is not enumerated.
    expect(await store.sessions()).not.toContain("s4");

    // A fresh instance over the same dir agrees.
    const restarted = fsTimelineStore({ dir });
    expect(await restarted.sessions()).not.toContain("s4");
  });
});
