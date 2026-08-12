/**
 * `rollingSummary` — the fold, the cap, and what happens when the cap is hit.
 */

import { describe, expect, it, vi } from "vitest";

import type { CompactGenerate, ProgressUpdate, TimelineEntry } from "@agentick/spec";
import { deriveTestContext } from "@agentick/runtime/testing";

import {
  rollingSummary,
  DEFAULT_SUMMARY_INSTRUCTIONS,
  QUESTIONS_INSTRUCTION,
} from "../strategies.js";

/** The facets a harness mints; a strategy only ever reads them. */
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

function stubGenerate(
  result: Partial<Awaited<ReturnType<CompactGenerate>>> = {},
  deltas: readonly number[] = [],
): CompactGenerate {
  return async ({ onDelta }) => {
    for (const outputTokens of deltas) onDelta?.({ text: "…", outputTokens });
    return { text: "a summary", truncated: false, ...result };
  };
}

const blockOf = (e: TimelineEntry) =>
  (
    e as {
      message: {
        content: readonly {
          data?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
        }[];
      };
    }
  ).message.content[0]!;

const summaryOf = (e: TimelineEntry) =>
  (e as { message: { content: readonly { data?: { summary?: string } }[] } }).message.content[0]
    ?.data?.summary;

describe("keepVerbatim bounds the tail by tokens, not just by count", () => {
  /** A turn carrying a large tool result — a page outline, a query dump. */
  const fat = (id: string, chars: number): TimelineEntry => ({
    kind: "message",
    message: {
      id,
      ts: 0,
      role: "user",
      content: [{ type: "text", text: "x".repeat(chars) }],
    },
  });

  it("keeps fewer entries when the recent ones are large", async () => {
    // The ratchet: a COUNT-bounded tail of six page outlines can exceed the
    // trigger's ceiling on its own, and then no amount of folding older
    // material gets under it — the fold destroys context and the trigger stays
    // hot. Bounding the tail by tokens is what makes the fold able to succeed.
    const keepVerbatim = ({
      entries: all,
      sizeOf,
    }: {
      entries: readonly TimelineEntry[];
      sizeOf: (e: TimelineEntry) => number;
    }): number => {
      let budget = 10_000;
      let n = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        budget -= sizeOf(all[i]!);
        if (budget < 0) break;
        n++;
      }
      return Math.max(1, n);
    };

    const strategy = rollingSummary({ keepVerbatim });
    // Ten turns of ~5k tokens each (20k chars / 4). Only two fit in 10k.
    const fatLog = Array.from({ length: 10 }, (_, i) => fat(`f${i}`, 20_000));
    const out = await strategy.run({ ...ctx(), entries: fatLog, generate: stubGenerate() });

    // 1 summary + the tail that fits, which is far fewer than the default 6.
    expect(out.length).toBeLessThan(6);
    expect(summaryOf(out[0]!)).toBe("a summary");
  });

  it("still takes a plain number, which is the common case", async () => {
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate(),
    });
    expect(out).toHaveLength(3); // summary + 2
  });

  it("sizes an image, so a screenshot-heavy tail is not measured as empty", () => {
    // `sizeOf` is the shared arithmetic (ADR 97). Before it, media scored zero,
    // so a token-bounded tail would have kept everything and bounded nothing.
    let seen = 0;
    const withImage: TimelineEntry = {
      kind: "message",
      message: {
        id: "img",
        ts: 0,
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://e.test/a.png" } }],
      },
    };
    void rollingSummary({
      keepVerbatim: ({ entries: all, sizeOf }) => {
        seen = sizeOf(all[0]!);
        return 1;
      },
    }).run({ ...ctx(), entries: [withImage, ...entries(3)], generate: stubGenerate() });
    expect(seen).toBeGreaterThan(0);
  });
});

describe("the fold", () => {
  it("replaces everything but the kept tail with one summary event", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const out = await strategy.run({ ...ctx(), entries: entries(10), generate: stubGenerate() });

    expect(out).toHaveLength(3);
    expect(summaryOf(out[0]!)).toBe("a summary");
    expect((out[1] as { message: { id: string } }).message.id).toBe("m8");
  });

  it("records what it folded", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const out = await strategy.run({ ...ctx(), entries: entries(10), generate: stubGenerate() });
    const data = (out[0] as { message: { content: readonly { data: Record<string, unknown> }[] } })
      .message.content[0]!.data;

    expect(data).toMatchObject({ entriesBefore: 8, entriesAfter: 2 });
  });

  it("does nothing when there is nothing older than the tail", async () => {
    const strategy = rollingSummary({ keepVerbatim: 6 });
    const input = entries(4);
    expect(await strategy.run({ ...ctx(), entries: input, generate: stubGenerate() })).toBe(input);
  });

  it("reads the projection, not the durable log", () => {
    expect(rollingSummary().source).toBe("projection");
  });

  it("says so when nothing bound a model", async () => {
    await expect(rollingSummary().run({ ...ctx(), entries: entries(10) })).rejects.toThrow(
      /needs a model/,
    );
  });
});

describe("truncation is not persisted", () => {
  it("leaves the timeline untouched when the cap was hit", async () => {
    const strategy = rollingSummary({ keepVerbatim: 2 });
    const input = entries(10);
    const out = await strategy.run({
      ...ctx(),
      entries: input,
      generate: stubGenerate({ truncated: true, text: "a summary cut off mid-" }),
    });

    expect(out).toBe(input);
  });
});

describe("instructions", () => {
  it("sends the standing rules when the caller supplies none", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ keepVerbatim: 2, questions: false }).run({
      ...ctx(),
      entries: entries(10),
      generate: seen,
    });
    expect(seen.mock.calls[0]![0].instructions).toBe(DEFAULT_SUMMARY_INSTRUCTIONS);
  });

  it("appends a per-call steer AFTER the standing rules", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ instructions: "Standing.", keepVerbatim: 2, questions: false }).run({
      ...ctx(),
      entries: entries(10),
      instructions: "Keep every number.",
      generate: seen,
    });
    expect(seen.mock.calls[0]![0].instructions).toBe("Standing.\n\nKeep every number.");
  });

  it("keeps the steer on the event so a steered fold is distinguishable", async () => {
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      instructions: "Keep every number.",
      generate: stubGenerate(),
    });
    const data = (out[0] as { message: { content: readonly { data: Record<string, unknown> }[] } })
      .message.content[0]!.data;
    expect(data["instructions"]).toBe("Keep every number.");
  });
});

describe("what your log caught", () => {
  /** A real turn: user asks, assistant calls a tool, the tool replies, assistant answers. */
  const turn = (n: number): TimelineEntry[] =>
    [
      { role: "user" as const, content: [{ type: "text" as const, text: `ask ${n}` }] },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, toolUseId: `c${n}`, name: "q", input: {} }],
      },
      {
        role: "tool" as const,
        content: [{ type: "tool_result" as const, toolUseId: `c${n}`, content: [] }],
      },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${n}` }] },
    ].map((message, i) => ({
      kind: "message" as const,
      message: { id: `t${n}_${i}`, ts: n * 10 + i, ...message },
    })) as TimelineEntry[];

  const summaryEntry = (id: string): TimelineEntry =>
    ({
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
            data: { summary: "older" },
          },
        ],
      },
    }) as TimelineEntry;

  it("refuses to re-summarize a summary when that is all it would fold", async () => {
    // Measured: a second /compact folded ONE entry — the previous summary —
    // spending 3194 output tokens with a COLD cache to produce a worse summary,
    // and reported 11 entries in, 11 out. One open turn leaves the fold nothing
    // else to reach, which is exactly when the churn used to fire.
    const seen = vi.fn(stubGenerate());
    const openTurn = [
      { role: "user" as const, content: [{ type: "text" as const, text: "ask" }] },
      ...Array.from({ length: 5 }, () => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "step" }],
      })),
    ].map((message, i) => ({
      kind: "message" as const,
      message: { id: `o${i}`, ts: i, ...message },
    })) as TimelineEntry[];
    const input = [summaryEntry("s0"), ...openTurn];

    const out = await rollingSummary({ keepVerbatim: 6 }).run({
      ...ctx(),
      entries: input,
      generate: seen,
    });

    expect(out).toBe(input);
    expect(seen).not.toHaveBeenCalled();
  });

  it("cuts at the NEAREST turn start, so one long turn cannot defeat the fold", async () => {
    // Searching backward alone walked past three turns to the only boundary it
    // could find, kept ten entries against a keepVerbatim of six, and left the
    // fold with nothing but the summary.
    const input = [summaryEntry("s0"), ...turn(1), ...turn(2), ...turn(3)];
    const out = await rollingSummary({ keepVerbatim: 6 }).run({
      ...ctx(),
      entries: input.slice(0, 9),
      generate: stubGenerate(),
    });

    // Folded past the summary into real material, and kept a whole turn.
    expect(out.length).toBeLessThan(9);
    expect(summaryOf(out[0]!)).toBe("a summary");
    expect((out[1] as { message: { id: string } }).message.id).toBe("t2_0");
  });

  it("resolves the range even when a boundary sits at the edge of the fold", async () => {
    // Measured: `coversThrough` came back null because the last folded entry was
    // a turn boundary, which carries no id — and a range that does not resolve
    // cannot rebuild the projection.
    const boundary = {
      kind: "boundary",
      boundary: { executionId: "e1", outcome: "succeeded" },
      ts: 1,
    } as unknown as TimelineEntry;
    const out = await rollingSummary({ keepVerbatim: 4 }).run({
      ...ctx(),
      entries: [...turn(1), boundary, ...turn(2)],
      generate: stubGenerate(),
    });
    const data = (out[0] as { message: { content: readonly { data: Record<string, unknown> }[] } })
      .message.content[0]!.data;

    expect(data["coversFrom"]).toBe("t1_0");
    expect(data["coversThrough"]).toBe("t1_3");
  });
});

describe("the fold names what it answers", () => {
  const reply = `<questions>
- How does Harbor View handle retainage?
- What did we decide about the March invoice?
</questions>

We reviewed Harbor View's retainage terms.`;

  it("asks for the questions on top of whatever rules the adopter set", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ instructions: "Ernesto's rules.", keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: seen,
    });
    const sent = String(seen.mock.calls[0]![0].instructions);
    expect(sent).toContain("Ernesto's rules.");
    expect(sent).toContain(QUESTIONS_INSTRUCTION);
    expect(sent.indexOf("Ernesto's rules.")).toBeLessThan(sent.indexOf(QUESTIONS_INSTRUCTION));
  });

  it("records them off the model's path, and the summary keeps none of the block", async () => {
    // Left in, the summary would put a list of unanswered questions in front of
    // a model that will try to answer them.
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate({ text: reply }),
    });

    expect(blockOf(out[0]!).metadata?.["questions"]).toEqual([
      "How does Harbor View handle retainage?",
      "What did we decide about the March invoice?",
    ]);
    expect(summaryOf(out[0]!)).toBe("We reviewed Harbor View's retainage terms.");
  });

  it("takes the summary as-is when the model wrote no block", async () => {
    // A missing key costs findability, not correctness — never the summary.
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate({ text: "just prose" }),
    });

    expect(summaryOf(out[0]!)).toBe("just prose");
    expect(blockOf(out[0]!).metadata ?? {}).not.toHaveProperty("questions");
  });

  it("can be turned off", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ keepVerbatim: 2, questions: false }).run({
      ...ctx(),
      entries: entries(10),
      generate: seen,
    });
    expect(String(seen.mock.calls[0]![0].instructions)).not.toContain("<questions>");
  });
});

describe("what the fold cost", () => {
  it("records the call's usage where the model does not read it", async () => {
    // `data` is rendered into the model's context, key by key. Cost is
    // bookkeeping — it belongs on the block's metadata, which formatters skip.
    const usage = { inputTokens: 40_000, outputTokens: 900, totalTokens: 40_900 };
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate({ usage: { ...usage, cachedInputTokens: 34_000 } }),
    });

    expect(blockOf(out[0]!).metadata?.["usage"]).toEqual({ ...usage, cachedInputTokens: 34_000 });
    expect(blockOf(out[0]!).data).not.toHaveProperty("usage");
  });

  it("omits the key when the provider reported none", async () => {
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate(),
    });

    expect(blockOf(out[0]!).metadata ?? {}).not.toHaveProperty("usage");
  });
});

describe("the cap is the progress denominator", () => {
  it("reports emitted against the budget as the summary streams", async () => {
    const seen: ProgressUpdate[] = [];
    await rollingSummary({ maxOutputTokens: 500, keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: stubGenerate({}, [100, 250]),
      progress: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { progress: 100, total: 500, message: "Folding 8 entries" },
      { progress: 250, total: 500, message: "Folding 8 entries" },
    ]);
  });

  it("says what it is folding, since a token count alone means nothing", async () => {
    const seen: ProgressUpdate[] = [];
    await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(3),
      generate: stubGenerate({}, [10]),
      progress: (u) => seen.push(u),
    });

    expect(seen[0]!.message).toBe("Folding 1 entry");
  });

  it("caps at 8192 by default", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: entries(10),
      generate: seen,
    });
    expect(seen.mock.calls[0]![0].maxOutputTokens).toBe(8192);
  });

  it("takes a function of the fold", async () => {
    const seen = vi.fn(stubGenerate());
    await rollingSummary({
      keepVerbatim: 2,
      maxOutputTokens: ({ entries }) => entries.length * 100,
    }).run({ ...ctx(), entries: entries(10), generate: seen });
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
      current = await strategy.run({ ...ctx(), entries: current, generate: stubGenerate() });
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
    const first = await strategy.run({ ...ctx(), entries: entries(10), generate: stubGenerate() });
    const seen = vi.fn(stubGenerate());
    await strategy.run({ ...ctx(), entries: [...first, ...entries(4, 100)], generate: seen });

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

describe("the fold cuts on a turn boundary", () => {
  /** user → assistant(tool_use) → tool_result → assistant(text), repeated. */
  function turns(count: number): TimelineEntry[] {
    const out: TimelineEntry[] = [];
    for (let t = 0; t < count; t++) {
      const mk = (role: string, type: string, i: number) =>
        ({
          kind: "message",
          message: {
            id: `t${t}-${i}`,
            ts: t * 10 + i,
            role,
            content: [
              type === "text"
                ? { type: "text", text: `t${t}` }
                : type === "tool_use"
                  ? { type: "tool_use", id: `c${t}`, name: "nav", input: {} }
                  : { type: "tool_result", toolUseId: `c${t}`, content: [] },
            ],
          },
        }) as TimelineEntry;
      out.push(mk("user", "text", 0), mk("assistant", "tool_use", 1));
      out.push(mk("user", "tool_result", 2), mk("assistant", "text", 3));
    }
    return out;
  }

  const roleOf = (e: TimelineEntry) => (e as { message: { role: string } }).message.role;
  const firstBlock = (e: TimelineEntry) =>
    (e as { message: { content: readonly { type: string }[] } }).message.content[0]!.type;

  it("the entry after the summary is a real user message, not a fragment", async () => {
    const out = await rollingSummary({ keepVerbatim: 6 }).run({
      ...ctx(),
      entries: turns(5),
      generate: stubGenerate(),
    });

    expect(firstBlock(out[0]!)).toBe("system_event");
    expect(roleOf(out[1]!)).toBe("user");
    expect(firstBlock(out[1]!)).toBe("text");
  });

  it("never orphans a tool_result from its tool_use", async () => {
    // The cut landing between them is a hard provider error, not a quality
    // problem — Anthropic and Google both reject the request.
    for (const keepVerbatim of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const out = await rollingSummary({ keepVerbatim }).run({
        ...ctx(),
        entries: turns(5),
        generate: stubGenerate(),
      });
      const kept = out.slice(1).map(firstBlock);
      const firstResult = kept.indexOf("tool_result");
      if (firstResult >= 0) {
        expect(kept.slice(0, firstResult)).toContain("tool_use");
      }
    }
  });

  it("keepVerbatim is a floor — it rounds OUT to a whole turn", async () => {
    const out = await rollingSummary({ keepVerbatim: 2 }).run({
      ...ctx(),
      entries: turns(5),
      generate: stubGenerate(),
    });
    // 2 would have cut mid-turn; the whole final turn (4 entries) survives.
    expect(out.slice(1)).toHaveLength(4);
    expect(roleOf(out[1]!)).toBe("user");
  });

  it("falls back to the nearest legal cut when no turn start is reachable", async () => {
    // The shape of an agent run: one request, then a tail of tool calls with no
    // further human turn. Preferring a turn start is right; REQUIRING one meant
    // this conversation could never be compacted at all, which is how a long run
    // grows until the window overflows. A fragment is also less bad than the old
    // docblock implies — the fold puts a summary immediately before the tail, so
    // the kept window is never actually unprefaced.
    const noUserTurn = turns(1).slice(1); // starts at the assistant's tool_use
    const out = await rollingSummary({ keepVerbatim: 1 }).run({
      ...ctx(),
      entries: noUserTurn,
      generate: stubGenerate(),
    });
    expect(out).not.toBe(noUserTurn);
    // The pair went into the fold together — the cut landed after the result.
    expect(out.slice(1).map(firstBlock)).not.toContain("tool_result");
  });
});
