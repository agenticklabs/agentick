/**
 * TimelineHarness — concrete tests + conformance run.
 */

import type { StoreCtx } from "@agentick/spec";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { EventQuery, ProtocolEvent, TimelineEntry } from "@agentick/spec";
import { progressEventName, timelineEventQuery, TIMELINE_COMPACT_EVENT_NAME } from "@agentick/spec";

import { stubStoreCtx } from "@agentick/store";

import { TimelineHarness } from "../harness.js";
import { MemoryTimelineStore, timelineScopeKey } from "../store.js";
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
    expect(harness.read().entries).toContainEqual(entry);
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
    expect(harness.read().entries).toHaveLength(1);
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

describe("TimelineHarness — branch: the fork transport (checkpointing §5)", () => {
  const branchCtx = (fromSessionId: string, toSeq?: number) => ({
    sessionId: fromSessionId,
    fromSessionId,
    tick: 0,
    storeCtx: stubStoreCtx(),
    ...(toSeq !== undefined ? { toSeq } : {}),
  });
  const idsOf = (entries: readonly TimelineEntry[]): string[] =>
    entries.map((e) => (e.kind === "message" ? e.message.id : e.kind));

  it("copies the source scope onto its own, and hydrate opens on the copy", async () => {
    const store = new MemoryTimelineStore();
    const { harness: parent } = await makeHarness(timelineScopeKey("br-parent"), { store });
    await parent.append(messageEntry("p1", "one"), messageEntry("p2", "two"));
    await parent.persist();
    await parent.close();

    // A DIFFERENT scope over the SAME store — the child of a fork.
    const { harness: child } = await makeHarness(timelineScopeKey("br-child"), { store });
    expect(child.read().entries).toEqual([]);

    await child.branch(branchCtx("br-parent"));
    await child.hydrate();
    expect(idsOf(child.read().entries)).toEqual(["p1", "p2"]);
    expect(idsOf(child.read().entries)).toEqual(["p1", "p2"]);

    // The copy is the CHILD's: appending to it leaves the parent's log alone.
    await child.append(messageEntry("c1", "three"));
    await child.persist();
    expect(idsOf(await store.read(timelineScopeKey("br-parent"), stubStoreCtx()))).toEqual([
      "p1",
      "p2",
    ]);
    await child.close();
  });

  it("bounds the inherited prefix BY SEQ, not by position — a windowed source (baseSeq > 0)", async () => {
    const store = new MemoryTimelineStore();
    const { harness: parent } = await makeHarness(timelineScopeKey("br5-parent"), { store });
    await parent.append(
      messageEntry("p1", "1"),
      messageEntry("p2", "2"),
      messageEntry("p3", "3"),
      messageEntry("p4", "4"),
      messageEntry("p5", "5"),
    );
    await parent.persist();
    await parent.close();
    // Compaction moved the window: the log now starts at seq 2 (p3). Index 0 ≠ seq 0.
    await store.prune(timelineScopeKey("br5-parent"), { seq: 2 }, stubStoreCtx());

    const { harness: child } = await makeHarness(timelineScopeKey("br5-child"), { store });
    await child.branch(branchCtx("br5-parent", 3));
    await child.hydrate();
    // seq ≤ 3 inclusive over the live window [p3@2, p4@3, p5@4] — never p5.
    expect(idsOf(child.read().entries)).toEqual(["p3", "p4"]);
    await child.close();
  });

  it("toSeq -1 — no anchor — inherits nothing", async () => {
    const store = new MemoryTimelineStore();
    const { harness: parent } = await makeHarness(timelineScopeKey("br6-parent"), { store });
    await parent.append(messageEntry("p1", "one"));
    await parent.persist();
    await parent.close();

    const { harness: child } = await makeHarness(timelineScopeKey("br6-child"), { store });
    await child.branch(branchCtx("br6-parent", -1));
    await child.hydrate();
    expect(child.read().entries).toEqual([]);
    await child.close();
  });

  it("delegates to store.branch with the source key, its own scope and the bound — nothing else", async () => {
    const calls: unknown[] = [];
    class SpyStore extends MemoryTimelineStore {
      override branch(
        source: string,
        target: string,
        opts: { readonly toSeq?: number },
        ctx: StoreCtx,
      ) {
        calls.push([source, target, opts]);
        return super.branch(source, target, opts, ctx);
      }
    }
    const store = new SpyStore();
    const { harness: child } = await makeHarness(timelineScopeKey("br7-child"), { store });
    await child.branch(branchCtx("br7-parent", 0));
    expect(calls).toEqual([
      [timelineScopeKey("br7-parent"), timelineScopeKey("br7-child"), { toSeq: 0 }],
    ]);
    await child.close();
  });

  it("branching into a non-empty scope is a no-op — a retried fork cannot double the log", async () => {
    const store = new MemoryTimelineStore();
    const { harness: parent } = await makeHarness(timelineScopeKey("br2-parent"), { store });
    await parent.append(messageEntry("p1", "one"));
    await parent.persist();
    await parent.close();

    const { harness: child } = await makeHarness(timelineScopeKey("br2-child"), { store });
    await child.branch(branchCtx("br2-parent"));
    await child.branch(branchCtx("br2-parent"));
    await child.hydrate();
    expect(idsOf(child.read().entries)).toEqual(["p1"]);
    await child.close();
  });

  it("an unknown source scope copies nothing", async () => {
    const store = new MemoryTimelineStore();
    const { harness } = await makeHarness(timelineScopeKey("br3-child"), { store });
    await harness.branch(branchCtx("never-existed"));
    await harness.hydrate();
    expect(harness.read().entries).toEqual([]);
    await harness.close();
  });

  it("a store-less harness branches without effect", async () => {
    // The bundled default store is per-harness, so the source scope cannot be
    // in it — durability across sessions was never on offer without injection.
    const { harness } = await makeHarness("br4-child");
    await harness.branch(branchCtx("br4-parent"));
    expect(harness.read().entries).toEqual([]);
    await harness.close();
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
  makeFromDefinition: async (definition, scopeId) => {
    const { harness } = await makeHarness(
      scopeId ?? `conformance-genesis-${generateId()}`,
      definition,
    );
    return harness;
  },
});
