/**
 * `polledView` — the read core the six RPC-backed handles (gates, state, skills,
 * prompts, resources, tools) delegate to. These pin the behavior those handles
 * used to each hand-roll: the eager seed and its notification, the swallowed
 * seed failure, the by-id index, referential stability of `list()`, and the
 * refresh query pass-through.
 */

import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@agentick/utils/testing";

import { polledView } from "../polled-view.js";

interface Row {
  readonly name: string;
}
const rows = (...names: string[]): readonly Row[] => names.map((name) => ({ name }));

describe("polledView", () => {
  it("seeds itself eagerly and notifies when the seed lands", async () => {
    let resolveFetch!: (value: readonly Row[]) => void;
    const view = polledView<Row>({
      fetch: () =>
        new Promise<readonly Row[]>((resolve) => {
          resolveFetch = resolve;
        }),
      key: (r) => r.name,
    });

    // A subscriber that attaches while the seed is still in flight still hears it.
    const seen: number[] = [];
    view.subscribe(() => seen.push(view.list().length));
    expect(view.list()).toEqual([]);

    resolveFetch(rows("a", "b"));
    await waitFor(() => seen.length > 0);

    expect(seen).toEqual([2]);
    expect(view.list().map((r) => r.name)).toEqual(["a", "b"]);
    expect(view.get("b")).toEqual({ name: "b" });
    expect(view.get("nope")).toBeUndefined();
  });

  it("swallows a failed seed, leaving the snapshot empty; refresh() recovers", async () => {
    let calls = 0;
    const view = polledView<Row>({
      fetch: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("session unreachable"))
          : Promise.resolve(rows("a"));
      },
      key: (r) => r.name,
    });

    await waitFor(() => calls === 1);
    expect(view.list()).toEqual([]);

    await expect(view.refresh()).resolves.toEqual([{ name: "a" }]);
    expect(view.list()).toEqual([{ name: "a" }]);
  });

  it("reads a null / undefined reply as the empty snapshot", async () => {
    const view = polledView<Row>({ fetch: async () => null, key: (r) => r.name });
    await expect(view.refresh()).resolves.toEqual([]);
    expect(view.list()).toEqual([]);
  });

  it("keeps list() referentially stable between refreshes", async () => {
    const view = polledView<Row>({ fetch: async () => rows("a"), key: (r) => r.name });
    const first = await view.refresh();
    expect(view.list()).toBe(first);
    expect(view.list()).toBe(view.list());
  });

  it("passes the refresh query through to fetch", async () => {
    const fetch = vi.fn(async (_query?: { readonly filter: string }) => rows("a"));
    const view = polledView<Row, { readonly filter: string }>({ fetch, key: (r) => r.name });

    await view.refresh({ filter: "x" });
    expect(fetch).toHaveBeenCalledWith({ filter: "x" });
    // The eager seed passes none.
    expect(fetch.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("unsubscribe detaches one listener; close() drops them all", async () => {
    const view = polledView<Row>({ fetch: async () => rows("a"), key: (r) => r.name });
    const a = vi.fn();
    const b = vi.fn();
    const offA = view.subscribe(a);
    view.subscribe(b);

    // Let the eager seed's notification land, then count only explicit refreshes.
    await waitFor(() => a.mock.calls.length === 1);
    a.mockClear();
    b.mockClear();

    await view.refresh();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    await view.refresh();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    view.close();
    await view.refresh();
    expect(b).toHaveBeenCalledTimes(2);
    // Reads still work after close — only the fan-out stops.
    expect(view.list()).toEqual([{ name: "a" }]);
  });
});
