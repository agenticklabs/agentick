/**
 * `<Compaction strategy={…}>` — the tree door (ADR 97).
 *
 * The claim under test is the precedence ladder, not the render: a strategy
 * declared in the tree outranks the one bound at construction for as long as it
 * is mounted, and unmounting restores the configured default rather than
 * leaving the timeline with none.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { CompactDecisionCtx, CompactStrategy } from "@agentick/spec";

import { TimelineHarness } from "../harness.js";

/**
 * A strategy identified by the ceiling it fires at, so which one is in force is
 * observable through `shouldCompact` — the surface a trigger actually uses —
 * rather than by reaching into the harness for the resolved object.
 */
const firesAt = (limit: number): CompactStrategy => ({
  source: "projection",
  run: async ({ entries }) => entries,
  shouldCompact: (ctx) => ctx.usedTokens >= limit,
});

/** The ceiling currently in force, probed through the public decision surface. */
const ceilingOf = (h: TimelineHarness): number | undefined => {
  for (const limit of [100, 200, 300]) {
    if (h.shouldCompact({ usedTokens: limit })) return limit;
  }
  return undefined;
};

function harnessWith(compact?: CompactStrategy): TimelineHarness {
  return new TimelineHarness(
    `tl-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    compact ? { compact } : {},
  );
}

describe("tree beats config, and only while mounted", () => {
  it("outranks the construction-bound strategy", async () => {
    const harness = harnessWith(firesAt(300));
    await harness.ready;
    expect(ceilingOf(harness)).toBe(300);

    harness.declareCompact(firesAt(100));
    expect(ceilingOf(harness)).toBe(100);

    await harness.close();
  });

  it("restores the configured default on unmount, not nothing", async () => {
    // The failure this rules out: a conditional `<Compaction>` unmounting and
    // leaving the session with no strategy at all, so every later fold rejects
    // with CompactStrategyMissing and the thread grows unbounded.
    const harness = harnessWith(firesAt(300));
    await harness.ready;

    const undo = harness.declareCompact(firesAt(100));
    undo();
    expect(ceilingOf(harness)).toBe(300);

    await harness.close();
  });

  it("keeps the newest declaration when a stale unmount arrives late", async () => {
    // Two components swap: the outgoing one's cleanup runs AFTER the incoming
    // one registered. Clearing unconditionally would wipe a live declaration.
    const harness = harnessWith();
    await harness.ready;

    const undoFirst = harness.declareCompact(firesAt(100));
    harness.declareCompact(firesAt(200));
    undoFirst();

    expect(ceilingOf(harness)).toBe(200);

    await harness.close();
  });

  it("answers shouldCompact from whichever strategy currently wins", async () => {
    const never: CompactStrategy = { ...firesAt(300), shouldCompact: () => false };
    const harness = harnessWith(never);
    await harness.ready;

    const ctx: CompactDecisionCtx = { usedTokens: 1_000_000 };
    expect(harness.shouldCompact(ctx)).toBe(false);

    harness.declareCompact(firesAt(100));
    expect(harness.shouldCompact(ctx)).toBe(true);

    await harness.close();
  });

  it("says no when nothing is bound — an absent opinion is not a yes", async () => {
    const harness = harnessWith();
    await harness.ready;
    expect(harness.shouldCompact({ usedTokens: 1_000_000 })).toBe(false);
    await harness.close();
  });
});

// The component is a two-line effect over `declareCompact`; asserting React
// calls an effect would be testing React. What it must not do is drift from the
// bridge method it calls, which the type system already enforces.
void React;
