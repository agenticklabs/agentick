/**
 * TimelineHarness — concrete tests + conformance run.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { EventQuery, ProtocolEvent, TimelineEntry } from "@agentick/spec-next";

import { TimelineHarness } from "../harness.js";
import { runTimelineHarnessConformance, messageEntry } from "../conformance.js";
import { withHandler } from "../strategies.js";

async function makeHarness(scope = "test"): Promise<{
  harness: TimelineHarness;
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
}> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new TimelineHarness(scope, journal, bus, inbox);
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
    await harness.compact(withHandler({ handler: async ({ entries }) => entries }));
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });
});

describe("TimelineHarness — inbox addressability", () => {
  it("inbox append message reaches the append() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_inbox");
    const entry: TimelineEntry = messageEntry("from-inbox", "via inbox");
    await Effect.runPromise(
      inbox.send(`timeline:s_inbox`, {
        messageId: ulid(),
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
        messageId: ulid(),
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
    await harness.compact(withHandler({ handler: async () => [] }));
    expect(harness.read().entries).toEqual([]);
    await Effect.runPromise(
      inbox.send(`timeline:s_reset`, {
        messageId: ulid(),
        type: "timeline:resetProjection",
      }),
    );
    await settle();
    expect(harness.read().entries).toEqual([e1]);
    await harness.close();
  });
});

describe("TimelineHarness — pending Operation envelopes", () => {
  it("queue() emits requested + terminal under command:queue", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "timeline",
      name: { exact: "timeline:command:queue" },
    });
    await harness.queue({ role: "user", content: [{ type: "text", text: "hi" }] });
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });

  it("drain() emits its own envelope AND child append envelopes with parentOpId", async () => {
    const { harness, bus } = await makeHarness();
    await harness.queue({ role: "user", content: [{ type: "text", text: "x" }] });
    await harness.queue({ role: "user", content: [{ type: "text", text: "y" }] });

    const { events, stop } = await subscribeEnvelopes(bus, { surface: "timeline" });
    await harness.drain();
    await settle();
    await stop();

    const drainReq = events.find(
      (e) => e.name === "timeline:command:drain" && e.phase === "requested",
    );
    expect(drainReq).toBeDefined();
    const drainOpId = drainReq!.opId;

    // One batched append envelope follows, with parentOpId = drain's opId.
    const appendReqs = events.filter(
      (e) => e.name === "timeline:command:append" && e.phase === "requested",
    );
    expect(appendReqs.length).toBe(1);
    expect(appendReqs[0]!.parentOpId).toBe(drainOpId);
    await harness.close();
  });
});

describe("TimelineHarness — pending inbox routing", () => {
  it("inbox queue message reaches the queue() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_q");
    await Effect.runPromise(
      inbox.send(`timeline:s_q`, {
        messageId: ulid(),
        type: "timeline:queue",
        payload: [{ role: "user", content: [{ type: "text", text: "from inbox" }] }],
      }),
    );
    await settle();
    const pending = harness.readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.role).toBe("user");
    await harness.close();
  });

  it("inbox drain message moves pending → log + projection", async () => {
    const { harness, inbox } = await makeHarness("s_d");
    await harness.queue({ role: "user", content: [{ type: "text", text: "queued" }] });
    expect(harness.readPending()).toHaveLength(1);

    await Effect.runPromise(
      inbox.send(`timeline:s_d`, {
        messageId: ulid(),
        type: "timeline:drain",
      }),
    );
    await settle();
    expect(harness.readPending()).toEqual([]);
    expect(harness.read().entries).toHaveLength(1);
    await harness.close();
  });
});

describe("TimelineHarness — snapshot round-trip across instances", () => {
  it("exportSnapshot / importSnapshot preserves log + projection across instances", async () => {
    const { harness } = await makeHarness();
    await harness.append(messageEntry("e1", "a"));
    await harness.append(messageEntry("e2", "b"));
    await harness.compact(
      withHandler({
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
    const { harness } = await makeHarness(`conformance-${ulid()}`);
    return harness;
  },
});
