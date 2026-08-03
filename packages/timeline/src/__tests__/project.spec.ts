/**
 * The projection is a pure function of the log.
 *
 * That is the invariant the event-sourced framing buys, and the one a
 * side-table cursor violates: if rebuilding the view needs state kept
 * elsewhere, the log and that state can disagree. The load-bearing test is the
 * round trip — fold the log after a restart, get the live projection back.
 */

import { describe, expect, it } from "vitest";
import { deriveTestContext } from "@agentick/runtime/testing";
import type { CompactGenerate, TimelineEntry } from "@agentick/spec";

import { projectLog } from "../project.js";
import { rollingSummary } from "../strategies.js";

const ctx = () => deriveTestContext();

function entries(count: number, offset = 0): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "message" as const,
    message: {
      id: `m${i + offset}`,
      ts: i + offset,
      role: "user" as const,
      content: [{ type: "text" as const, text: `turn ${i + offset}` }],
    },
  }));
}

const gen =
  (text: string): CompactGenerate =>
  async () => ({ text, outputTokens: 1, truncated: false });

const label = (e: TimelineEntry): string => {
  const m = e as { message: { id: string; content: readonly { type: string }[] } };
  return m.message.content[0]?.type === "system_event" ? "S" : m.message.id;
};

/** What the store holds after a compaction: the log, then what the fold produced. */
function logAfter(
  log: readonly TimelineEntry[],
  projection: readonly TimelineEntry[],
): TimelineEntry[] {
  const known = new Set(log.map((e) => (e.kind === "message" ? e.message.id : e.kind)));
  return [
    ...log,
    ...projection.filter((e) => !known.has(e.kind === "message" ? e.message.id : e.kind)),
  ];
}

describe("the round trip", () => {
  it("folding the log reproduces the live projection", async () => {
    const strategy = rollingSummary({ keepVerbatim: 3 });
    const log = entries(10);
    const live = await strategy.run({ ...ctx(), entries: log, generate: gen("S1") });

    // What a restart reads back, folded with no cursor and no side table.
    expect(projectLog(logAfter(log, live)).map(label)).toEqual(live.map(label));
  });

  it("survives two compactions", async () => {
    const strategy = rollingSummary({ keepVerbatim: 3, keepSummaries: 4 });
    let log: readonly TimelineEntry[] = entries(10);
    let live = await strategy.run({ ...ctx(), entries: log, generate: gen("S1") });
    log = logAfter(log, live);

    const grown = [...live, ...entries(5, 100)];
    log = [...log, ...entries(5, 100)];
    live = await strategy.run({ ...ctx(), entries: grown, generate: gen("S2") });
    log = logAfter(log, live);

    expect(projectLog(log).map(label)).toEqual(live.map(label));
  });
});

describe("the fold itself", () => {
  it("puts the summary where its range starts, not where it was appended", async () => {
    const strategy = rollingSummary({ keepVerbatim: 3 });
    const log = entries(10);
    const live = await strategy.run({ ...ctx(), entries: log, generate: gen("S1") });
    const folded = projectLog(logAfter(log, live));

    // The summary was written last and reads first — position and coverage are
    // different facts, and the fold reads the second one.
    expect(folded.map(label)).toEqual(["S", "m7", "m8", "m9"]);
  });

  it("is idempotent — folding a projection returns it unchanged", async () => {
    const strategy = rollingSummary({ keepVerbatim: 3 });
    const live = await strategy.run({ ...ctx(), entries: entries(10), generate: gen("S1") });
    expect(projectLog(live).map(label)).toEqual(live.map(label));
  });

  it("a log with no compaction is returned as-is", () => {
    const log = entries(4);
    expect(projectLog(log)).toBe(log);
  });

  it("an outer range hides the summaries inside it", () => {
    const raw = entries(6);
    const inner = summaryEvent("s-inner", "m0", "m2");
    const outer = summaryEvent("s-outer", "m0", "m4");
    const folded = projectLog([...raw, inner, outer]);

    expect(folded.map(label)).toEqual(["S", "m5"]);
    expect(folded[0]).toBe(outer);
  });

  it("ignores a compaction event that declares no range", () => {
    const log = [...entries(3), summaryEvent("s", undefined, undefined)];
    expect(projectLog(log)).toBe(log);
  });

  it("keeps a summary whose range no longer resolves, rather than dropping it", () => {
    // Substituting nothing is recoverable; vanishing the record of a fold is
    // not. This is also what makes the fold idempotent.
    const log = [...entries(3), summaryEvent("s", "gone", "alsogone")];
    expect(projectLog(log).map(label)).toEqual(["m0", "m1", "m2", "S"]);
  });
});

function summaryEvent(id: string, coversFrom?: string, coversThrough?: string): TimelineEntry {
  return {
    kind: "message",
    message: {
      id,
      ts: 0,
      role: "event",
      content: [
        {
          type: "system_event",
          event: "compaction",
          source: "timeline",
          data: { summary: id, ...(coversFrom ? { coversFrom, coversThrough } : {}) },
        },
      ],
    },
  } as TimelineEntry;
}
