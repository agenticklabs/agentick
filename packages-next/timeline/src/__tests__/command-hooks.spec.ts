/**
 * TimelineHarness — command-lifecycle hook (ADR 80/83). `timeline:compact`
 * (op `timeline:command:compact`) routes through `runOperation`, so the
 * `CommandRegistry` augmentation in `harness.ts` mints
 * `onBeforeTimelineCompact` / `onAfterTimelineCompact`. This test proves the
 * hook fires when `compact()` runs (the explicit-arg form shares the op name
 * with the signal form, so both fire the same hook).
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { TimelineHarness } from "../harness.js";
import { messageEntry } from "../conformance.js";
import { fromHandler } from "../strategies.js";

async function makeHarness(scope = "t-hooks"): Promise<TimelineHarness> {
  const harness = new TimelineHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("TimelineHarness — compact hook (ADR 83)", () => {
  it("onBeforeTimelineCompact fires when compact() is called", async () => {
    const harness = await makeHarness();
    await harness.append(messageEntry("e1", "a"));

    let fired = 0;
    const off = harness.hook({
      onBeforeTimelineCompact: () => {
        fired += 1;
      },
    });

    await harness.compact(fromHandler({ handler: async ({ entries }) => entries }));

    expect(fired).toBe(1);

    off();
    await harness.close();
  });

  it("onAfterTimelineCompact sees the CompactResult output", async () => {
    const harness = await makeHarness("t-hooks-2");
    await harness.append(messageEntry("e1", "a"));

    let seenOutput: unknown;
    const off = harness.hooks.onAfterTimelineCompact((output) => {
      seenOutput = output;
    });

    await harness.compact(fromHandler({ handler: async ({ entries }) => entries }));

    expect(seenOutput).toMatchObject({
      entriesBefore: expect.any(Number),
      entriesAfter: expect.any(Number),
    });

    off();
    await harness.close();
  });
});
