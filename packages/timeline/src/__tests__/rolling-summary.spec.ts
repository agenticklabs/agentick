/**
 * `rollingSummary` — the fold, the cap, and what happens when the cap is hit.
 */

import { describe, expect, it, vi } from "vitest";

import type { CompactGenerate, ProgressUpdate, TimelineEntry } from "@agentick/spec";
import { rollingSummary, DEFAULT_SUMMARY_INSTRUCTIONS } from "../strategies.js";

function entries(count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "message" as const,
    message: {
      id: `m${i}`,
      ts: i,
      role: "user" as const,
      content: [{ type: "text" as const, text: `turn ${i}` }],
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
