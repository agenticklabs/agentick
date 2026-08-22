/**
 * KnobsHarness — `knobs-state` channel (ADR 73): snapshot + JSON-Patch delta
 * frames, and their round-trip against `applyJsonPatch`.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { applyJsonPatch } from "@agentick/utils";
import { stubStoreCtx } from "@agentick/store";
import type { KnobPrimitive } from "@agentick/spec";

import { KnobsHarness, type KnobsHarnessOptions } from "../harness.js";
import { createKnobStore } from "../store.js";
import { KNOBS_STATE_CHANNEL_FQN, type KnobsStateFrame } from "../channel.js";

async function makeHarness(
  scope = "test",
  store?: KnobsHarnessOptions["store"],
): Promise<{ harness: KnobsHarness; bus: LocalEventBus }> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new KnobsHarness(
    scope,
    journal,
    bus,
    inbox,
    undefined,
    store !== undefined ? { store } : {},
  );
  await harness.ready;
  return { harness, bus };
}

async function collectFrames(
  bus: LocalEventBus,
): Promise<{ frames: KnobsStateFrame[]; stop: () => Promise<void> }> {
  const frames: KnobsStateFrame[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({ surface: "session" }), (e) =>
      Effect.sync(() => {
        if (e.name === KNOBS_STATE_CHANNEL_FQN) frames.push(e.payload as KnobsStateFrame);
      }),
    ),
  );
  await new Promise((r) => setImmediate(r));
  return {
    frames,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("KnobsHarness — knobs-state channel", () => {
  it("emits an `add` delta for a new id and `replace` for an existing one", async () => {
    const { harness, bus } = await makeHarness();
    const { frames, stop } = await collectFrames(bus);

    await harness.set({ id: "verbose", value: true });
    await harness.set({ id: "verbose", value: false });
    await settle();
    await stop();

    const deltas = frames.filter((f) => f.kind === "delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      kind: "delta",
      ops: [{ op: "add", path: "/verbose", value: true }],
    });
    expect(deltas[1]).toMatchObject({
      kind: "delta",
      ops: [{ op: "replace", path: "/verbose", value: false }],
    });
    await harness.close();
  });

  it("stamps a monotonic, gap-free version on successive frames", async () => {
    const { harness, bus } = await makeHarness();
    const { frames, stop } = await collectFrames(bus);

    await harness.set({ id: "a", value: 1 });
    await harness.set({ id: "b", value: 2 });
    await harness.set({ id: "a", value: 3 });
    await settle();
    await stop();

    const versions = frames.map((f) => f.version);
    expect(versions).toEqual([1, 2, 3]);
    await harness.close();
  });

  it("emits an `add` delta when register seeds a default, and none for a descriptor-only register", async () => {
    const { harness, bus } = await makeHarness();
    const { frames, stop } = await collectFrames(bus);

    await harness.register({ id: "temp", descriptor: { valueType: "number", defaultValue: 7 } });
    // No default → registers a descriptor but changes no cell → no frame.
    await harness.register({ id: "model", descriptor: { valueType: "string" } });
    await settle();
    await stop();

    const deltas = frames.filter((f) => f.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.ops).toEqual([{ op: "add", path: "/temp", value: 7 }]);
    await harness.close();
  });

  it("emits a full snapshot frame on importSnapshot (wholesale replace)", async () => {
    const { harness, bus } = await makeHarness();
    await harness.set({ id: "keep", value: 1 });
    const { frames, stop } = await collectFrames(bus);

    harness.importSnapshot({ x: "a", y: 2 });
    await settle();
    await stop();

    const snapshots = frames.filter((f) => f.kind === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.values).toEqual({ x: "a", y: 2 });
    await harness.close();
  });

  it("emits a full snapshot frame on hydrate() so a resumed session's subscribers re-seed", async () => {
    const store = createKnobStore();
    await store.put({ scope: "resumed", id: "mood", value: "curious" }, stubStoreCtx());
    const { harness, bus } = await makeHarness("resumed", store);
    const { frames, stop } = await collectFrames(bus);

    await harness.hydrate({ sessionId: "resumed", tick: 3, storeCtx: stubStoreCtx() });
    await settle();
    await stop();

    const snapshots = frames.filter((f) => f.kind === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.values).toEqual({ mood: "curious" });
    await harness.close();
  });

  it("stateSnapshotFrame() reflects current state at the current version without advancing it", async () => {
    const { harness } = await makeHarness();
    await harness.set({ id: "a", value: 1 });
    await harness.set({ id: "b", value: 2 });

    const first = harness.stateSnapshotFrame();
    expect(first.values).toEqual({ a: 1, b: 2 });
    expect(first.version).toBe(2); // two deltas emitted → version 2

    const second = harness.stateSnapshotFrame();
    expect(second.version).toBe(2); // reading does not advance the counter
    await harness.close();
  });

  it("escapes ids containing / and ~ into RFC 6901 tokens that round-trip", async () => {
    const { harness, bus } = await makeHarness();
    const { frames, stop } = await collectFrames(bus);

    await harness.set({ id: "group/child", value: 1 });
    await harness.set({ id: "a~b", value: 2 });
    await settle();
    await stop();

    const seed: Record<string, KnobPrimitive> = {};
    let doc = seed;
    for (const f of frames) if (f.kind === "delta") doc = applyJsonPatch(doc, f.ops);
    expect(doc).toEqual({ "group/child": 1, "a~b": 2 });
    await harness.close();
  });

  it("MONEY TEST: snapshot seed + applied deltas reconstruct the live store", async () => {
    const { harness, bus } = await makeHarness();
    // Some state exists before the subscriber attaches.
    await harness.set({ id: "verbose", value: true });
    await harness.set({ id: "temperature", value: 0.7 });

    // A late subscriber seeds from the on-demand snapshot, then follows deltas.
    const seed = harness.stateSnapshotFrame();
    const { frames, stop } = await collectFrames(bus);

    await harness.set({ id: "temperature", value: 0.2 }); // replace
    await harness.set({ id: "model", value: "opus" }); // add
    await settle();
    await stop();

    let reconstructed: Record<string, KnobPrimitive> = { ...seed.values };
    for (const f of frames)
      if (f.kind === "delta") reconstructed = applyJsonPatch(reconstructed, f.ops);

    expect(reconstructed).toEqual(harness.exportSnapshot());
    expect(reconstructed).toEqual({ verbose: true, temperature: 0.2, model: "opus" });
    await harness.close();
  });
});
