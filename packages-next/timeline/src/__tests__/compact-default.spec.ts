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
import type { CompactStrategy, TimelineEntry } from "@agentick/spec-next";
import { CompactStrategyMissing } from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
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
    // The log is untouched (projection-only compaction).
    expect(timeline.readPersisted().map(idOf)).toEqual(["a", "b"]);
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

  it("enumerates all four declared verbs via commands() (queue/drain deleted, ADR 53)", async () => {
    const timeline = mkTimeline();
    await timeline.ready;
    expect(timeline.commands().map((c) => c.name)).toEqual([
      "timeline:append",
      "timeline:replaceProjection",
      "timeline:resetProjection",
      "timeline:compact",
    ]);
    await timeline.close();
  });
});
