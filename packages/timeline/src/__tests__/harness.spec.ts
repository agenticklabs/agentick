/**
 * TimelineHarness — concrete tests + conformance run.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { EventQuery, ProtocolEvent, TimelineEntry } from "@agentick/spec";
import { progressEventName, timelineEventQuery, TIMELINE_COMPACT_EVENT_NAME } from "@agentick/spec";

import { TimelineHarness } from "../harness.js";
import { runTimelineHarnessConformance, messageEntry } from "../conformance.js";
import type { TimelineDefinition } from "../definition.js";
import { fromHandler } from "../strategies.js";

async function makeHarness(
  scope = "test",
  definition: TimelineDefinition = {},
): Promise<{
  harness: TimelineHarness;
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
}> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new TimelineHarness(scope, journal, bus, inbox, definition);
  await harness.ready;
  return { harness, journal, bus, inbox };
}

async function subscribeEnvelopes(
  bus: LocalEventBus,
  query: EventQuery,
): Promise<{ events: ProtocolEvent[]; stop: () => Promise<void> }> {
  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe(query), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );
  await new Promise((r) => setImmediate(r));
  return {
    events,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Concrete behavior tests
// ============================================================================

describe("TimelineHarness — Operation envelopes", () => {
  it("append() emits requested + terminal envelopes on the timeline surface", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "timeline" });
    await harness.append(messageEntry("e1", "hello"));
    await settle();
    await stop();
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    expect(events.every((e) => e.surface === "timeline")).toBe(true);
    await harness.close();
  });

  it("compact() emits envelopes under command:compact", async () => {
    const { harness, bus } = await makeHarness();
    await harness.append(messageEntry("e1", "a"));
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "timeline",
      name: { exact: "timeline:command:compact" },
    });
    await harness.compact(fromHandler({ handler: async ({ entries }) => entries }));
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });

  it("compact() publishes its produced entries as an append-shaped envelope", async () => {
    const { harness, bus } = await makeHarness();
    await harness.append(messageEntry("a", "one"), messageEntry("b", "two"));
    const { events, stop } = await subscribeEnvelopes(bus, timelineEventQuery());
    await harness.compact(
      fromHandler({ handler: async () => [messageEntry("summary", "folded")] }),
    );
    await settle();
    await stop();
    // Exactly one append-shaped envelope, carrying ONLY the produced summary —
    // a live window folding `timelineEventQuery()` sees the compaction land
    // without a reload, and the entries it already holds are not re-sent.
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { entries: readonly TimelineEntry[] };
    expect(payload.entries.map((e) => (e as { message: { id: string } }).message.id)).toEqual([
      "summary",
    ]);
    expect(events[0].parentOpId).toMatch(/^timeline:compact:/);
    await harness.close();
  });

  it("compact() that produces no new entries publishes no append-shaped envelope", async () => {
    const { harness, bus } = await makeHarness();
    await harness.append(messageEntry("a", "one"), messageEntry("b", "two"));
    const { events, stop } = await subscribeEnvelopes(bus, timelineEventQuery());
    await harness.compact(fromHandler({ handler: async ({ entries }) => entries }));
    await settle();
    await stop();
    expect(events).toHaveLength(0);
    await harness.close();
  });

  it("compaction progress frames name their operation and carry its opId", async () => {
    const { harness, bus } = await makeHarness();
    await harness.append(messageEntry("e1", "a"));
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "timeline" });
    await harness.compact(
      fromHandler({
        handler: async ({ entries, progress }) => {
          progress?.({ progress: 1, total: 2, message: "folding" });
          return entries;
        },
      }),
    );
    await settle();
    await stop();

    const compactOpId = events.find(
      (e) => e.name === TIMELINE_COMPACT_EVENT_NAME && e.phase === "requested",
    )?.opId;
    expect(compactOpId).toBeDefined();

    // The harness's own opening frame first, then the strategy's report.
    const frames = events.filter((e) => e.name === progressEventName("timeline"));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.payload).toEqual({
      token: compactOpId,
      op: TIMELINE_COMPACT_EVENT_NAME,
      progress: 0,
    });
    // The token IS the operation's id, so a consumer needs no second key to
    // join a frame to the lifecycle it belongs to.
    expect(frames[1]!.payload).toEqual({
      token: compactOpId,
      op: TIMELINE_COMPACT_EVENT_NAME,
      progress: 1,
      total: 2,
      message: "folding",
    });
    expect(frames[1]!.parentOpId).toBe(compactOpId);
    await harness.close();
  });

  it("a fold whose strategy never reports still announces itself with an opening frame", async () => {
    const { harness, bus } = await makeHarness();
    await harness.append(messageEntry("e1", "a"));
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "timeline" });
    await harness.compact(fromHandler({ handler: async ({ entries }) => entries }));
    await settle();
    await stop();

    const frames = events.filter((e) => e.name === progressEventName("timeline"));
    expect(frames).toHaveLength(1);
    // No `total`: the bar a subscriber draws from this is indeterminate until
    // the strategy publishes a measured one.
    expect(frames[0]!.payload).toMatchObject({
      op: TIMELINE_COMPACT_EVENT_NAME,
      progress: 0,
    });
    expect(frames[0]!.payload).not.toHaveProperty("total");
    await harness.close();
  });
});

describe("TimelineHarness — inbox addressability", () => {
  it("inbox append message reaches the append() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_inbox");
    const entry: TimelineEntry = messageEntry("from-inbox", "via inbox");
    await Effect.runPromise(
      inbox.send(`timeline:s_inbox`, {
        messageId: generateId(),
        type: "timeline:append",
        payload: { entries: [entry] },
      }),
    );
    await settle();
    expect(harness.readPersisted()).toContainEqual(entry);
    await harness.close();
  });

  it("inbox replaceProjection message reaches the harness", async () => {
    const { harness, inbox } = await makeHarness("s_replace");
    await harness.append(messageEntry("e1", "original"));
    const replacement = [messageEntry("r1", "replaced")];
    await Effect.runPromise(
      inbox.send(`timeline:s_replace`, {
        messageId: generateId(),
        type: "timeline:replaceProjection",
        payload: { entries: replacement },
      }),
    );
    await settle();
    expect(harness.read().entries).toEqual(replacement);
    // Log still has the original.
    expect(harness.readPersisted()).toHaveLength(1);
    await harness.close();
  });

  it("inbox resetProjection message rebuilds projection from log", async () => {
    const { harness, inbox } = await makeHarness("s_reset");
    const e1 = messageEntry("e1", "a");
    await harness.append(e1);
    await harness.compact(fromHandler({ handler: async () => [] }));
    expect(harness.read().entries).toEqual([]);
    await Effect.runPromise(
      inbox.send(`timeline:s_reset`, {
        messageId: generateId(),
        type: "timeline:resetProjection",
      }),
    );
    await settle();
    expect(harness.read().entries).toEqual([e1]);
    await harness.close();
  });
});

describe("TimelineHarness — snapshot round-trip across instances", () => {
  it("exportSnapshot / importSnapshot preserves log + projection across instances", async () => {
    const { harness } = await makeHarness();
    await harness.append(messageEntry("e1", "a"));
    await harness.append(messageEntry("e2", "b"));
    await harness.compact(
      fromHandler({
        handler: async ({ entries }) => [messageEntry("summary", `count=${entries.length}`)],
        metadata: { kind: "test-summary" },
      }),
    );
    const snap = harness.exportSnapshot();

    const { harness: restored } = await makeHarness("restored");
    await restored.importSnapshot(snap);
    expect(restored.readPersisted()).toEqual(snap.persisted);
    expect(restored.read().entries).toEqual(snap.projection);
    expect(restored.exportSnapshot().lastCompaction).toEqual(snap.lastCompaction);

    await harness.close();
    await restored.close();
  });
});

// ============================================================================
// Conformance suite
// ============================================================================

runTimelineHarnessConformance({
  make: async () => {
    const { harness } = await makeHarness(`conformance-${generateId()}`);
    return harness;
  },
  // ADR 93 — lights up the GENESIS section (the seed law, the typed hydrate
  // failure). The definition IS the harness's options, so this is a pass-through.
  makeFromDefinition: async (definition) => {
    const { harness } = await makeHarness(`conformance-genesis-${generateId()}`, definition);
    return harness;
  },
});
