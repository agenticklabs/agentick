/**
 * KnobsHarness — the `onChange` notify seam (ADR 75): mutation sites emit a
 * typed `ChangeEvent`; the StateDelta channel is one projection over it, and
 * external observers can attach to the same stream. This is the proving
 * consumer that the change-event primitive is the substrate the projection
 * rides on, not a bespoke per-harness mechanism.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ChangeEvent } from "@agentick/pubsub";
import type { KnobPrimitive } from "@agentick/spec";

import { KnobsHarness } from "../harness.js";

async function makeHarness(scope = "test"): Promise<KnobsHarness> {
  const harness = new KnobsHarness(
    scope,
    new MemoryJournal({ capacity: 10_000 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("KnobsHarness — onChange notify seam", () => {
  it("emits an add (no prev) for a new id and an update (with prev) for an existing one", async () => {
    const harness = await makeHarness();
    const seen: ChangeEvent<KnobPrimitive>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.set({ id: "verbose", value: true });
    await harness.set({ id: "verbose", value: false });
    await harness.close();

    expect(seen).toEqual([
      { key: "verbose", value: true }, // add — no prev
      { key: "verbose", value: false, prev: true }, // update — carries prev
    ]);
  });

  it("emits an add when register seeds a default, and nothing for a descriptor-only register", async () => {
    const harness = await makeHarness();
    const seen: ChangeEvent<KnobPrimitive>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.register({ id: "temp", descriptor: { valueType: "number", defaultValue: 7 } });
    await harness.register({ id: "model", descriptor: { valueType: "string" } }); // no seed → no change

    await harness.close();
    expect(seen).toEqual([{ key: "temp", value: 7 }]);
  });

  it("fires on a model dispatch that mutates a knob (dispatch rides applySet)", async () => {
    const harness = await makeHarness();
    await harness.set({ id: "mode", value: "slow" });
    const seen: ChangeEvent<KnobPrimitive>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.dispatch({ name: "mode", value: "fast" });

    await harness.close();
    expect(seen).toEqual([{ key: "mode", value: "fast", prev: "slow" }]);
  });

  it("unsubscribe stops delivery", async () => {
    const harness = await makeHarness();
    const seen: KnobPrimitive[] = [];
    const off = harness.onChange((c) => seen.push(c.value ?? "gone"));

    await harness.set({ id: "a", value: 1 });
    off();
    await harness.set({ id: "a", value: 2 });

    await harness.close();
    expect(seen).toEqual([1]);
  });

  it("supports multiple projections on one stream — a second observer sees every change the channel also projects", async () => {
    const harness = await makeHarness();
    const projectionA: string[] = [];
    const projectionB: string[] = [];
    harness.onChange((c) => projectionA.push(`${c.key}=${String(c.value)}`));
    harness.onChange((c) => projectionB.push(`${c.key}=${String(c.value)}`));

    await harness.set({ id: "x", value: 1 });
    await harness.set({ id: "y", value: 2 });

    await harness.close();
    // Both external observers see the full stream — the StateDelta channel
    // (a third, internal subscriber) does too, decoupled from the mutation.
    expect(projectionA).toEqual(["x=1", "y=2"]);
    expect(projectionB).toEqual(["x=1", "y=2"]);
  });
});
