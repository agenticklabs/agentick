/**
 * The construction-bound default compaction strategy (ADR 51 signal
 * form — the A2.2 slot that makes a bare `timeline:compact` verb
 * addressable):
 *
 *   1. `compact()` with no argument runs the configured default.
 *   2. An explicit call-site strategy overrides the default
 *      (inner-scope-wins, in-process only).
 *   3. No argument + no default → typed `CompactStrategyMissing`.
 *
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CompactStrategy, TimelineEntry } from "@agentick/spec";
import { CompactStrategyMissing } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { TimelineHarness } from "../harness.js";

function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

const summaryStrategy = (marker: string): CompactStrategy => ({
  run: async () => [entry(marker)],
  metadata: { marker },
});

function mkTimeline(compact?: CompactStrategy) {
  return new TimelineHarness(
    "s1:timeline",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    compact !== undefined ? { compact } : {},
  );
}

const idOf = (e: TimelineEntry): string => (e as { message: { id: string } }).message.id;

describe("TimelineHarness — construction-bound default compact (ADR 51 signal form)", () => {
  it("compact() with no argument runs the configured default strategy", async () => {
    const timeline = mkTimeline(summaryStrategy("default-summary"));
    await timeline.ready;
    await timeline.append(entry("a"), entry("b"));

    const result = await timeline.compact();
    expect(result).toMatchObject({ entriesBefore: 2, entriesAfter: 1 });
    expect(timeline.read().entries.map(idOf)).toEqual(["default-summary"]);
    // The log is never REWRITTEN, but what the compaction produced is appended
    // to it — a summary is a fact, and the log is what happened.
    expect(timeline.readPersisted().map(idOf)).toEqual(["a", "b", "default-summary"]);
    await timeline.close();
  });

  it("an explicit call-site strategy overrides the default (inner-scope-wins)", async () => {
    const timeline = mkTimeline(summaryStrategy("default-summary"));
    await timeline.ready;
    await timeline.append(entry("a"));

    await timeline.compact(summaryStrategy("override-summary"));
    expect(timeline.read().entries.map(idOf)).toEqual(["override-summary"]);
    await timeline.close();
  });

  it("no argument + no configured default rejects with typed CompactStrategyMissing", async () => {
    const timeline = mkTimeline();
    await timeline.ready;
    await timeline.append(entry("a"));

    await expect(timeline.compact()).rejects.toBeInstanceOf(CompactStrategyMissing);
    await timeline.close();
  });
});

describe("TimelineHarness — compact as an addressable verb (ADR 51 slice 4)", () => {
  it("a bare timeline:compact inbox verb runs the construction-bound default", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const timeline = new TimelineHarness("s2:timeline", journal, bus, inbox, {
      compact: summaryStrategy("signal-summary"),
    });
    await timeline.ready;
    await timeline.append(entry("a"), entry("b"));

    // The signal form: verb + no payload, from ANY origin — this is the
    // exact message a wire client's `timeline/compact` resolves to.
    const result = await Effect.runPromise(
      inbox.ask("timeline:s2:timeline", { type: "timeline:compact", origin: "wire" }),
    );
    expect(result).toMatchObject({ entriesBefore: 2, entriesAfter: 1 });
    expect(timeline.read().entries.map(idOf)).toEqual(["signal-summary"]);
    await timeline.close();
  });

  it("advisory instructions ride the signal as data; the resident strategy receives them", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    let seenInstructions: unknown;
    const timeline = new TimelineHarness("s3:timeline", journal, bus, inbox, {
      compact: {
        run: async (ctx) => {
          seenInstructions = ctx.instructions;
          return [entry("hinted-summary")];
        },
      },
    });
    await timeline.ready;
    await timeline.append(entry("a"));

    await Effect.runPromise(
      inbox.ask("timeline:s3:timeline", {
        type: "timeline:compact",
        payload: { instructions: "keep decisions, drop chit-chat" },
      }),
    );
    expect(seenInstructions).toBe("keep decisions, drop chit-chat");
    expect(timeline.read().entries.map(idOf)).toEqual(["hinted-summary"]);
    await timeline.close();
  });

  it("enumerates every declared verb via commands() (queue/drain deleted, ADR 53)", async () => {
    const timeline = mkTimeline();
    await timeline.ready;
    expect(timeline.commands().map((c) => c.name)).toEqual([
      "timeline:append",
      "timeline:replaceProjection",
      "timeline:resetProjection",
      "timeline:compact",
      // The READ joined the grammar in ADR 93 — see history-command.spec.ts.
      "timeline:history",
    ]);
    await timeline.close();
  });
});

describe("what a compaction produces is durable", () => {
  it("appends the summary to the log — it is a fact, not a projection artifact", async () => {
    const tl = mkTimeline(summaryStrategy("S1"));
    await tl.ready;
    await tl.append(entry("a"), entry("b"), entry("c"));

    await tl.compact();

    expect(tl.read().entries.map(idOf)).toEqual(["S1"]);
    // Before this, `replaceProjection` never reached the store and the summary
    // vanished on restart — which is what forced adopters into a side table.
    expect(tl.readPersisted().map(idOf)).toEqual(["a", "b", "c", "S1"]);
  });

  it("keeps every iteration in the log while the projection stays small", async () => {
    const tl = mkTimeline();
    await tl.ready;
    await tl.append(entry("a"), entry("b"));

    await tl.compact(summaryStrategy("S1"));
    await tl.append(entry("c"));
    await tl.compact(summaryStrategy("S2"));

    expect(tl.read().entries.map(idOf)).toEqual(["S2"]);
    expect(tl.readPersisted().map(idOf)).toEqual(["a", "b", "S1", "c", "S2"]);
  });

  it("does not re-append entries the strategy carried through", async () => {
    const keepTail: CompactStrategy = { run: async ({ entries }) => entries.slice(-1) };
    const tl = mkTimeline(keepTail);
    await tl.ready;
    await tl.append(entry("a"), entry("b"));

    await tl.compact();

    expect(tl.readPersisted().map(idOf)).toEqual(["a", "b"]);
  });

  it("a strategy that CLONES entries still does not duplicate the log", async () => {
    const clone: CompactStrategy = {
      run: async ({ entries }) => entries.map((e) => structuredClone(e)),
    };
    const tl = mkTimeline(clone);
    await tl.ready;
    await tl.append(entry("a"), entry("b"));

    await tl.compact();

    expect(tl.readPersisted().map(idOf)).toEqual(["a", "b"]);
  });
});
