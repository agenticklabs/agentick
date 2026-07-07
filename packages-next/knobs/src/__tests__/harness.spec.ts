/**
 * KnobsHarness — concrete tests + conformance run.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { EventQuery, ProtocolEvent } from "@agentick/spec-next";

import { KnobsHarness } from "../harness.js";
import { runKnobsHarnessConformance } from "../conformance.js";

async function makeHarness(scope = "test"): Promise<{
  harness: KnobsHarness;
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
}> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new KnobsHarness(scope, journal, bus, inbox);
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

describe("KnobsHarness — Operation envelopes", () => {
  it("set() emits requested + terminal envelopes on the knobs surface", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "knobs" });
    await harness.set({ id: "verbose", value: true });
    await settle();
    await stop();
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    expect(events.every((e) => e.surface === "knobs")).toBe(true);
    await harness.close();
  });

  it("register() emits envelopes under the command:register name", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "knobs",
      name: { exact: "knobs:command:register" },
    });
    await harness.register({
      id: "mood",
      descriptor: { description: "current mood", defaultValue: "curious" },
    });
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });

  it("dispatch() emits envelopes under the command:dispatch name", async () => {
    const { harness, bus } = await makeHarness();
    await harness.register({
      id: "mood",
      descriptor: {
        defaultValue: "curious",
        valueType: "string",
        options: ["curious", "decisive"],
      },
    });
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "knobs",
      name: { exact: "knobs:command:dispatch" },
    });
    await harness.dispatch({ name: "mood", value: "decisive" });
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });
});

describe("KnobsHarness — inbox addressability", () => {
  it("an external actor's inbox message reaches the set() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_xyz");
    const address = `knobs:s_xyz`;
    await Effect.runPromise(
      inbox.send(address, {
        messageId: ulid(),
        type: "knobs:set",
        payload: { id: "verbose", value: true },
      }),
    );
    await settle();
    expect(harness.get("verbose")).toBe(true);
    await harness.close();
  });

  it("inbox register message attaches a descriptor with defaultValue", async () => {
    const { harness, inbox } = await makeHarness("s_abc");
    await Effect.runPromise(
      inbox.send(`knobs:s_abc`, {
        messageId: ulid(),
        type: "knobs:register",
        payload: {
          id: "limit",
          descriptor: { valueType: "number", defaultValue: 100 },
        },
      }),
    );
    await settle();
    expect(harness.get("limit")).toBe(100);
    await harness.close();
  });

  it("inbox dispatch with invalid input returns error block via Operation", async () => {
    const { harness, bus, inbox } = await makeHarness("s_disp");
    await harness.register({
      id: "mood",
      descriptor: {
        defaultValue: "curious",
        valueType: "string",
        options: ["curious", "decisive"],
      },
    });
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "knobs",
      name: { exact: "knobs:command:dispatch" },
    });
    await Effect.runPromise(
      inbox.send(`knobs:s_disp`, {
        messageId: ulid(),
        type: "knobs:dispatch",
        payload: { name: "mood", value: "playful" },
      }),
    );
    await settle();
    await stop();
    // Dispatch returns its result via the Operation's terminal envelope;
    // mutation does NOT commit.
    expect(harness.get("mood")).toBe("curious");
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });
});

describe("KnobsHarness — snapshot round-trip", () => {
  it("exportSnapshot / importSnapshot preserves values + fires subscribers", async () => {
    const { harness } = await makeHarness();
    await harness.set({ id: "a", value: 1 });
    await harness.set({ id: "b", value: "two" });
    const snap = harness.exportSnapshot();
    expect(snap).toMatchObject({ a: 1, b: "two" });

    const { harness: restored } = await makeHarness("restored");
    let listenerHits = 0;
    restored.subscribeAll(() => {
      listenerHits++;
    });
    restored.importSnapshot(snap);
    expect(restored.get("a")).toBe(1);
    expect(restored.get("b")).toBe("two");
    expect(listenerHits).toBeGreaterThan(0);
    await harness.close();
    await restored.close();
  });

  it("descriptors are NOT included in the snapshot (re-declared on remount)", async () => {
    const { harness } = await makeHarness();
    await harness.register({
      id: "mood",
      descriptor: { description: "current mood", defaultValue: "curious" },
    });
    const snap = harness.exportSnapshot();
    // Snapshot is values only; descriptor metadata is absent.
    expect(Object.keys(snap)).toEqual(["mood"]);
    expect(typeof snap.mood).toBe("string");
    await harness.close();
  });
});

describe("KnobsHarness — read-only knobs", () => {
  it("dispatch by name rejects writes to a read-only knob", async () => {
    const { harness } = await makeHarness();
    await harness.register({
      id: "phase",
      descriptor: {
        defaultValue: "collecting",
        valueType: "string",
        options: ["collecting", "processing", "done"],
        readOnly: true,
      },
    });

    const blocks = await harness.dispatch({ name: "phase", value: "done" });

    expect((blocks[0] as { text?: string }).text).toContain("read-only");
    expect(harness.get("phase")).toBe("collecting");
    await harness.close();
  });

  it("group dispatch skips read-only members and mutates the rest", async () => {
    const { harness } = await makeHarness();
    await harness.register({
      id: "locked",
      descriptor: {
        defaultValue: "off",
        valueType: "string",
        options: ["off", "on"],
        group: "flags",
        readOnly: true,
      },
    });
    await harness.register({
      id: "open",
      descriptor: {
        defaultValue: "off",
        valueType: "string",
        options: ["off", "on"],
        group: "flags",
      },
    });

    const blocks = await harness.dispatch({ group: "flags", value: "on" });
    const text = (blocks[0] as { text?: string }).text ?? "";

    expect(harness.get("open")).toBe("on");
    expect(harness.get("locked")).toBe("off");
    expect(text).toContain("open");
    expect(text).not.toContain("locked");
    await harness.close();
  });

  it("group dispatch errors when every member is read-only", async () => {
    const { harness } = await makeHarness();
    await harness.register({
      id: "g1",
      descriptor: {
        defaultValue: "active",
        valueType: "string",
        options: ["inactive", "active"],
        group: "gates",
        readOnly: true,
      },
    });

    const blocks = await harness.dispatch({ group: "gates", value: "inactive" });

    expect((blocks[0] as { text?: string }).text).toContain("read-only");
    expect(harness.get("g1")).toBe("active");
    await harness.close();
  });

  it("harness.set() still mutates a read-only knob (application-owned writes)", async () => {
    const { harness } = await makeHarness();
    await harness.register({
      id: "phase",
      descriptor: { defaultValue: "collecting", valueType: "string", readOnly: true },
    });

    await harness.set({ id: "phase", value: "done" });

    expect(harness.get("phase")).toBe("done");
    await harness.close();
  });
});

// ============================================================================
// Conformance suite — runs the full protocol-contract test set
// ============================================================================

runKnobsHarnessConformance({
  make: async () => {
    const { harness } = await makeHarness(`conformance-${ulid()}`);
    return harness;
  },
});
