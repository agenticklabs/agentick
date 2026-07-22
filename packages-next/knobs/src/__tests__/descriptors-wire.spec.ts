/**
 * KnobsHarness — `KnobDescriptor[]` on the `knobs-state` snapshot (friction #1).
 *
 * The snapshot frame carries DESCRIPTORS, not just bare values: id + value +
 * the declared metadata (label via `description`, type, bounds, options,
 * group, readOnly, …) so a descriptor-aware client renders labels/ranges/enums
 * without a second round-trip. These prove:
 *
 *   - the frame's `descriptors` reflect what the app declared (round-trip);
 *   - the non-serializable fields (`validate` fn, `schema`) are STRIPPED — they
 *     cannot cross a transport;
 *   - `values` is unchanged (additive — the values-only fold still works);
 *   - the `channelSnapshotPayload()` provider path returns the same frame.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { jsonSchema } from "@agentick/spec-next";

import { KnobsHarness } from "../harness.js";

async function makeHarness(scope = "desc"): Promise<KnobsHarness> {
  const harness = new KnobsHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("KnobsHarness — descriptors on the wire (friction #1)", () => {
  it("carries the declared descriptor metadata (id + value + fields) in the snapshot", async () => {
    const harness = await makeHarness();
    await harness.register({
      id: "temperature",
      descriptor: {
        description: "Sampling temperature",
        valueType: "number",
        defaultValue: 0.7,
        min: 0,
        max: 2,
        step: 0.1,
        group: "sampling",
      },
    });
    await harness.register({
      id: "mode",
      descriptor: { valueType: "string", options: ["fast", "smart"], readOnly: true },
    });
    await harness.set({ id: "mode", value: "smart" });

    const frame = harness.stateSnapshotFrame();

    // Values are unchanged — the additive floor.
    expect(frame.values).toEqual({ temperature: 0.7, mode: "smart" });

    const byId = Object.fromEntries(frame.descriptors.map((d) => [d.id, d]));
    expect(byId.temperature).toMatchObject({
      id: "temperature",
      value: 0.7,
      description: "Sampling temperature",
      valueType: "number",
      min: 0,
      max: 2,
      step: 0.1,
      group: "sampling",
    });
    expect(byId.mode).toMatchObject({
      id: "mode",
      value: "smart",
      valueType: "string",
      options: ["fast", "smart"],
      readOnly: true,
    });

    await harness.close();
  });

  it("STRIPS the non-serializable fields (`validate` fn + `schema`)", async () => {
    const harness = await makeHarness();
    await harness.register({
      id: "guarded",
      descriptor: {
        valueType: "number",
        defaultValue: 1,
        // Neither of these can cross a transport.
        validate: (v) => (typeof v === "number" && v > 0 ? true : "must be positive"),
        schema: jsonSchema({ type: "number" }),
      },
    });

    const [desc] = harness.stateSnapshotFrame().descriptors;
    expect(desc).toMatchObject({ id: "guarded", value: 1, valueType: "number" });
    expect("validate" in desc!).toBe(false);
    expect("schema" in desc!).toBe(false);

    await harness.close();
  });

  it("the channelSnapshotPayload() provider path returns the descriptor-carrying frame", async () => {
    const harness = await makeHarness();
    await harness.register({
      id: "verbose",
      descriptor: { valueType: "boolean", defaultValue: true },
    });

    // The provider path (what the session/sub-subscribe prepends) is the same
    // frame as the direct `stateSnapshotFrame()`.
    expect(harness.channelSnapshotPayload()).toEqual(harness.stateSnapshotFrame());
    const frame = harness.stateSnapshotFrame();
    expect(frame.descriptors).toContainEqual(
      expect.objectContaining({ id: "verbose", value: true, valueType: "boolean" }),
    );

    await harness.close();
  });
});
