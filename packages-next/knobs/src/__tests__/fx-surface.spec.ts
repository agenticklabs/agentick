/**
 * KnobsHarness `.fx` — the dual-typed edge (ADR 77 Stage 1).
 *
 * Proves the reference harness exposes both surfaces of one command:
 *   - `knobs.fx.set(input)`  → a composable **Effect** (un-run; nests in
 *     a parent `Effect.gen` so writes stay in one fiber tree).
 *   - `knobs.set(input)`     → the derived Promise facade
 *     (`PromiseView<KnobsFx>`), `runPromise` at the boundary.
 * Both dispatch the SAME declared `knobs:set` command; `fx` is sugar.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { KnobsHarness } from "../harness.js";

async function makeHarness(scope = "fx"): Promise<KnobsHarness> {
  const harness = new KnobsHarness(
    scope,
    new MemoryJournal({ capacity: 10_000 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("KnobsHarness — .fx dual-typed edge", () => {
  it("fx.set returns a composable Effect (not a Promise)", async () => {
    const harness = await makeHarness();
    const eff = harness.fx.set({ id: "verbose", value: true });

    expect(Effect.isEffect(eff)).toBe(true);
    expect(eff).not.toBeInstanceOf(Promise);
    // Un-run: the mutation has NOT happened yet.
    expect(harness.get("verbose")).toBeUndefined();

    await Effect.runPromise(eff);
    expect(harness.get("verbose")).toBe(true);
  });

  it("the plain method is the Promise facade", async () => {
    const harness = await makeHarness();
    const p = harness.set({ id: "verbose", value: true });

    expect(p).toBeInstanceOf(Promise);
    expect(Effect.isEffect(p)).toBe(false);

    await p;
    expect(harness.get("verbose")).toBe(true);
  });

  it("both surfaces drive the SAME declared command", async () => {
    const viaFx = await makeHarness("via-fx");
    const viaPromise = await makeHarness("via-promise");

    await Effect.runPromise(viaFx.fx.set({ id: "n", value: 1 }));
    await viaPromise.set({ id: "n", value: 1 });

    // Identical observable outcome — fx is pure sugar over the facade's command.
    expect(viaFx.get("n")).toBe(viaPromise.get("n"));
    expect(viaFx.list()).toEqual(viaPromise.list());
  });

  it("fx twins nest in one Effect.gen (single fiber tree)", async () => {
    const harness = await makeHarness();

    // Two writes composed with yield* — one fiber, no runPromise between them.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* harness.fx.set({ id: "a", value: 1 });
        yield* harness.fx.set({ id: "b", value: 2 });
      }),
    );

    expect(harness.get("a")).toBe(1);
    expect(harness.get("b")).toBe(2);
  });

  it("fx.dispatch composes and yields the set_knob ContentBlock[]", async () => {
    const harness = await makeHarness();
    await Effect.runPromise(
      harness.fx.register({
        id: "temp",
        descriptor: { valueType: "number", defaultValue: 0, min: 0, max: 10 },
      }),
    );

    const blocks = await Effect.runPromise(harness.fx.dispatch({ name: "temp", value: 5 }));

    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(harness.get("temp")).toBe(5);
  });
});
