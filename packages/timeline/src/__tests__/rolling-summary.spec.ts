/**
 * `rollingSummary` — the fold, the cap, and what happens when the cap is hit.
 */

import { describe, expect, it, vi } from "vitest";

import type { CompactGenerate, ProgressUpdate, TimelineEntry } from "@agentick/spec";
import { rollingSummary, DEFAULT_SUMMARY_INSTRUCTIONS } from "../strategies.js";

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

function stubGenerate(
  result: Partial<Awaited<ReturnType<CompactGenerate>>> = {},
  deltas: readonly number[] = [],
): CompactGenerate {
  return async ({ onDelta }) => {
    for (const outputTokens of deltas) onDelta?.({ text: "…", outputTokens });
    return { text: "a summary", outputTokens: 12, truncated: false, ...result };
  };
}

const summaryOf = (e: TimelineEntry) =>
  (e as { message: { content: readonly { data?: { summary?: string } }[] } }).message.content[0]
    ?.data?.summary;

describe("the fold", () => {
  it("replaces everything but the kept tail with one summary event", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const out = await strategy.run({ entries: entries(10), generate: stubGenerate() });

    expect(out).toHaveLength(3);
    expect(summaryOf(out[0]!)).toBe("a summary");
    expect((out[1] as { message: { id: string } }).message.id).toBe("m8");
  });

  it("records what it folded", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const out = await strategy.run({ entries: entries(10), generate: stubGenerate() });
    const data = (out[0] as { message: { content: readonly { data: Record<string, unknown> }[] } })
      .message.content[0]!.data;

    expect(data).toMatchObject({ entriesBefore: 8, entriesAfter: 2 });
  });

  it("does nothing when there is nothing older than the tail", async () => {
    const strategy = rollingSummary({ keepVerbatim: 6 });
    const input = entries(4);
    expect(await strategy.run({ entries: input, generate: stubGenerate() })).toBe(input);
  });

  it("reads the projection, not the durable log", () => {
    expect(rollingSummary().source).toBe("projection");
  });

  it("says so when nothing bound a model", async () => {
    await expect(rollingSummary().run({ entries: entries(10) })).rejects.toThrow(/needs a model/);
  });
});

describe("truncation is not persisted", () => {
  it("leaves the timeline untouched when the cap was hit", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const input = entries(10);
    const out = await strategy.run({
      entries: input,
      generate: stubGenerate({ truncated: true, text: "a summary cut off mid-" }),
    });

    expect(out).toBe(input);
  });
});

describe("instructions", () => {
  it("sends the standing rules when the caller supplies none", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ keepVerbatim: 2 }).run({ entries: entries(10), generate: seen });
    expect(seen.mock.calls[0]![0].instructions).toBe(DEFAULT_SUMMARY_INSTRUCTIONS);
  });

  it("appends a per-call steer AFTER the standing rules", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ instructions: "Standing.", keepVerbatim: 2 }).run({
      entries: entries(10),
      instructions: "Keep every number.",
      generate: seen,
    });
    expect(seen.mock.calls[0]![0].instructions).toBe("Standing.\n\nKeep every number.");
  });

  it("keeps the steer on the event so a steered fold is distinguishable", async () => {
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      entries: entries(10),
      instructions: "Keep every number.",
      generate: stubGenerate(),
    });
    const data = (out[0] as { message: { content: readonly { data: Record<string, unknown> }[] } })
      .message.content[0]!.data;
    expect(data["instructions"]).toBe("Keep every number.");
  });
});

describe("the cap is the progress denominator", () => {
  it("reports emitted against the budget as the summary streams", async () => {
    const seen: ProgressUpdate[] = [];
    await rollingSummary({ maxOutputTokens: 500, keepVerbatim: 2 }).run({
      entries: entries(10),
      generate: stubGenerate({}, [100, 250]),
      progress: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { progress: 100, total: 500 },
      { progress: 250, total: 500 },
    ]);
  });

  it("caps at 8192 by default", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ keepVerbatim: 2 }).run({ entries: entries(10), generate: seen });
    expect(seen.mock.calls[0]![0].maxOutputTokens).toBe(8192);
  });

  it("takes a function of the fold", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({
      keepVerbatim: 2,
      maxOutputTokens: ({ entries }) => entries.length * 100,
    }).run({ entries: entries(10), generate: seen });
    expect(seen.mock.calls[0]![0].maxOutputTokens).toBe(800);
  });
});

describe("shouldCompact", () => {
  it("fires at the token ceiling, not a fraction of a million-token window", () => {
    const strategy = rollingSummary();
    expect(strategy.shouldCompact!({ usedTokens: 25_000, contextWindow: 1_000_000 })).toBe(false);
    expect(strategy.shouldCompact!({ usedTokens: 120_000, contextWindow: 1_000_000 })).toBe(true);
  });

  it("takes a function of the live sizing", () => {
    const strategy = rollingSummary({
      threshold: ({ contextWindow }) => (contextWindow ?? 200_000) * 0.5,
    });
    expect(strategy.shouldCompact!({ usedTokens: 60_000, contextWindow: 100_000 })).toBe(true);
    expect(strategy.shouldCompact!({ usedTokens: 40_000, contextWindow: 100_000 })).toBe(false);
  });
});

describe("keepSummaries bounds the stack", () => {
  const label = (e: TimelineEntry) =>
    (e as { message: { content: readonly { type: string }[]; id: string } }).message.content[0]!
      .type === "system_event"
      ? "S"
      : (e as { message: { id: string } }).message.id;

  /** Fold `rounds` times, four new turns between each. */
  async function foldRepeatedly(keepSummaries: number, rounds: number): Promise<string[][]> {
    const strategy = rollingSummary({ keepVerbatim: 6, keepSummaries });
    const shapes: string[][] = [];
    let current: readonly TimelineEntry[] = entries(10);
    for (let r = 0; r < rounds; r++) {
      current = await strategy.run({ entries: current, generate: stubGenerate() });
      shapes.push(current.map(label));
      current = [...current, ...entries(4, 100 * (r + 1))];
    }
    return shapes;
  }

  it("default 1 re-summarizes the previous summary — one summary, always", async () => {
    const shapes = await foldRepeatedly(1, 4);
    for (const shape of shapes) expect(shape.filter((s) => s === "S")).toHaveLength(1);
  });

  it("a bound of 4 stacks summaries instead of compressing them again", async () => {
    const shapes = await foldRepeatedly(4, 3);
    expect(shapes.map((s) => s.filter((x) => x === "S").length)).toEqual([1, 2, 3]);
  });

  it("earlier summaries pass through untouched while under the bound", async () => {
    const strategy = rollingSummary({ keepVerbatim: 6, keepSummaries: 4 });
    const first = await strategy.run({ entries: entries(10), generate: stubGenerate() });
    const seen = vi.fn(stubGenerate());
    await strategy.run({ entries: [...first, ...entries(4, 100)], generate: seen });

    expect(seen.mock.calls[0]![0].entries.some(isSummaryEntry)).toBe(false);
  });

  it("collapses back to one when the bound is reached", async () => {
    const shapes = await foldRepeatedly(2, 4);
    expect(shapes.map((s) => s.filter((x) => x === "S").length)).toEqual([1, 2, 1, 2]);
  });

  it("never exceeds the bound", async () => {
    const shapes = await foldRepeatedly(3, 8);
    for (const shape of shapes) {
      expect(shape.filter((s) => s === "S").length).toBeLessThanOrEqual(3);
    }
  });
});

function isSummaryEntry(e: TimelineEntry): boolean {
  return (
    e.kind === "message" &&
    e.message.role === "event" &&
    e.message.content.some((b) => b.type === "system_event" && b.event === "compaction")
  );
}
