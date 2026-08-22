/**
 * StateHarness — concrete tests + conformance run.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { EventQuery, ProtocolEvent } from "@agentick/spec";

import { StateHarness } from "../harness.js";
import { runStateHarnessConformance } from "../conformance.js";

async function makeHarness(scope = "test"): Promise<{
  harness: StateHarness;
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
}> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new StateHarness(scope, journal, bus, inbox);
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

describe("StateHarness — Operation envelopes", () => {
  it("set() emits requested + terminal envelopes on the state surface", async () => {
    const { harness, bus } = await makeHarness();
    const { events, stop } = await subscribeEnvelopes(bus, { surface: "state" });
    await harness.set({ key: "foo", value: 42 });
    await settle();
    await stop();
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    expect(events.every((e) => e.surface === "state")).toBe(true);
    await harness.close();
  });

  it("delete() emits envelopes under command:delete", async () => {
    const { harness, bus } = await makeHarness();
    await harness.set({ key: "foo", value: 42 });
    const { events, stop } = await subscribeEnvelopes(bus, {
      surface: "state",
      name: { exact: "state:command:delete" },
    });
    await harness.delete({ key: "foo" });
    await settle();
    await stop();
    expect(events.some((e) => e.phase === "requested")).toBe(true);
    expect(events.some((e) => e.phase === "terminal")).toBe(true);
    await harness.close();
  });
});

describe("StateHarness — inbox addressability", () => {
  it("inbox set message reaches the set() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_xyz");
    await Effect.runPromise(
      inbox.send(`state:s_xyz`, {
        messageId: generateId(),
        type: "state:set",
        payload: { key: "remote", value: "value" },
      }),
    );
    await settle();
    expect(harness.get("remote")).toBe("value");
    await harness.close();
  });

  it("inbox delete message reaches the delete() Operation", async () => {
    const { harness, inbox } = await makeHarness("s_del");
    await harness.set({ key: "to-remove", value: "x" });
    await Effect.runPromise(
      inbox.send(`state:s_del`, {
        messageId: generateId(),
        type: "state:delete",
        payload: { key: "to-remove" },
      }),
    );
    await settle();
    expect(harness.has("to-remove")).toBe(false);
    await harness.close();
  });
});

// ============================================================================
// Conformance suite
// ============================================================================

runStateHarnessConformance({
  make: async () => {
    const { harness } = await makeHarness(`conformance-${generateId()}`);
    return harness;
  },
  makeOverStore: async (store, scope) => {
    const harness = new StateHarness(
      scope,
      new MemoryJournal({ capacity: 10_000 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store },
    );
    await harness.ready;
    return harness;
  },
});
