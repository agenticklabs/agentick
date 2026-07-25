/**
 * StateHarness — the `onChange` notify seam (ADR 75). Parallel to the knobs
 * retrofit, but state exercises what knobs cannot: a `delete` (the `remove`
 * path) and `unknown` values that may legitimately be `undefined` (so
 * add-vs-update rides an `existed` check, not `prev !== undefined`).
 */

import { describe, expect, it } from "vitest";
import type { ChangeEvent } from "@agentick/pubsub";

import { stubStateHarness } from "../testing/index.js";

describe("StateHarness — onChange notify seam", () => {
  it("emits add (no prev) for a new key and update (with prev) for an existing one", async () => {
    const harness = stubStateHarness();
    await harness.ready;
    const seen: ChangeEvent<unknown>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.set({ key: "a", value: 1 });
    await harness.set({ key: "a", value: 2 });
    await harness.close();

    expect(seen).toEqual([
      { key: "a", value: 1 }, // add
      { key: "a", value: 2, prev: 1 }, // update
    ]);
  });

  it("emits a remove (value omitted) on delete, and nothing when deleting an absent key", async () => {
    const harness = stubStateHarness();
    await harness.ready;
    await harness.set({ key: "a", value: "x" });
    const seen: ChangeEvent<unknown>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.delete({ key: "a" });
    await harness.delete({ key: "missing" }); // no-op → no change

    await harness.close();
    expect(seen).toEqual([{ key: "a", prev: "x" }]);
  });

  it("uses an existed check, not prev!==undefined: set(undefined) then set(value) is add→update", async () => {
    const harness = stubStateHarness();
    await harness.ready;
    const seen: ChangeEvent<unknown>[] = [];
    harness.onChange((c) => seen.push(c));

    await harness.set({ key: "u", value: undefined }); // new key, value IS undefined
    await harness.set({ key: "u", value: 5 }); // key existed → update

    await harness.close();
    // The discriminator is `has`, not prev-presence. A naive prev!==undefined
    // check would misread the second set as an add (prev is undefined).
    expect(seen).toHaveLength(2);
    expect(seen[0]!.key).toBe("u");
    expect("prev" in seen[0]!).toBe(false); // add — prev omitted
    expect(seen[1]).toMatchObject({ key: "u", value: 5 });
    expect("prev" in seen[1]!).toBe(true); // update — prev present (undefined)
    expect(seen[1]!.prev).toBeUndefined();
  });

  it("unsubscribe stops delivery; multiple projections share one stream", async () => {
    const harness = stubStateHarness();
    await harness.ready;
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = harness.onChange((c) => a.push(c.value));
    harness.onChange((c) => b.push(c.value));

    await harness.set({ key: "k", value: 1 });
    offA();
    await harness.set({ key: "k", value: 2 });

    await harness.close();
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
