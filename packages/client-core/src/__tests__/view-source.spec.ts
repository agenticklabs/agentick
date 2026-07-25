/**
 * `filteredView` — the VIEW FACTORY fan-out primitive (B2 slice 4). Proves the
 * fan-out invariants at the primitive level (the timeline-specific "two views,
 * one WIRE subscription" proof lives in `@agentick/timeline`):
 *   - two minted views share the source — the source is subscribed ONCE per view
 *     but the source itself owns the single upstream subscription;
 *   - each view projects its own `filter`;
 *   - views update on source change;
 *   - a view closes INDEPENDENTLY (its sibling keeps updating);
 *   - closing the source stops delivery to every view.
 *
 * @see docs/proposals/v2/guide-wire-and-client.md §2
 */

import { describe, expect, it } from "vitest";
import { filteredView, type CollectionViewSource } from "../view-source.js";

interface Item {
  readonly id: string;
  readonly kind: "a" | "b";
}

/** A controllable source: an in-memory list + a fan-out `subscribe`, `set` to
 *  mutate and notify. Records how many times `subscribe` was called. */
function fakeSource(): CollectionViewSource<Item> & {
  set(items: readonly Item[]): void;
  subscribeCount(): number;
} {
  let items: readonly Item[] = [];
  const listeners = new Set<() => void>();
  let subscribeCount = 0;
  return {
    list: () => items,
    subscribe(cb: () => void) {
      subscribeCount++;
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next: readonly Item[]) {
      items = next;
      for (const l of [...listeners]) l();
    },
    subscribeCount: () => subscribeCount,
  };
}

const idOf = (i: Item): string => i.id;

describe("filteredView — fan-out primitive", () => {
  it("projects each view's own filter over the shared source", () => {
    const source = fakeSource();
    const onlyA = filteredView(source, { filter: (i) => i.kind === "a" }, idOf);
    const onlyB = filteredView(source, { filter: (i) => i.kind === "b" }, idOf);

    source.set([
      { id: "1", kind: "a" },
      { id: "2", kind: "b" },
      { id: "3", kind: "a" },
    ]);

    expect(onlyA.list().map(idOf)).toEqual(["1", "3"]);
    expect(onlyB.list().map(idOf)).toEqual(["2"]);
    expect(onlyA.get("1")).toBeDefined();
    expect(onlyA.get("2")).toBeUndefined(); // filtered out of this view
  });

  it("both views update on a source change; each fires its own listener", () => {
    const source = fakeSource();
    const v1 = filteredView(source, {}, idOf);
    const v2 = filteredView(source, {}, idOf);
    let n1 = 0;
    let n2 = 0;
    v1.subscribe(() => n1++);
    v2.subscribe(() => n2++);

    source.set([{ id: "1", kind: "a" }]);
    expect(n1).toBe(1);
    expect(n2).toBe(1);
    expect(v1.list()).toHaveLength(1);
    expect(v2.list()).toHaveLength(1);
  });

  it("closes INDEPENDENTLY — a closed view stops, its sibling keeps updating", () => {
    const source = fakeSource();
    const v1 = filteredView(source, {}, idOf);
    const v2 = filteredView(source, {}, idOf);
    let n1 = 0;
    let n2 = 0;
    v1.subscribe(() => n1++);
    v2.subscribe(() => n2++);

    v1.close();
    source.set([{ id: "1", kind: "a" }]);
    expect(n1).toBe(0); // closed — no notification
    expect(n2).toBe(1); // sibling still live
    expect(v2.list()).toHaveLength(1);
  });

  it("list() is referentially STABLE between changes (the useSyncExternalStore contract)", () => {
    const source = fakeSource();
    const view = filteredView(source, { filter: (i) => i.kind === "a" }, idOf);
    source.set([
      { id: "1", kind: "a" },
      { id: "2", kind: "b" },
    ]);

    const first = view.list();
    // Same ref across repeated reads with no intervening change — otherwise a
    // React consumer render-loops (a fresh filtered array per call is the bug).
    expect(view.list()).toBe(first);
    expect(view.list()).toBe(first);

    // A source change re-projects to a NEW ref (the change is observable)...
    source.set([{ id: "3", kind: "a" }]);
    const second = view.list();
    expect(second).not.toBe(first);
    expect(second.map(idOf)).toEqual(["3"]);
    // ...and that new ref is then itself stable until the next change.
    expect(view.list()).toBe(second);
  });

  it("no view opens its own upstream subscription — the source is the single owner", () => {
    const source = fakeSource();
    filteredView(source, {}, idOf);
    filteredView(source, {}, idOf);
    filteredView(source, {}, idOf);
    // Each view registers ONE listener on the source; the source owns the ONE
    // upstream (wire) subscription — the views never open their own.
    expect(source.subscribeCount()).toBe(3);
  });
});
