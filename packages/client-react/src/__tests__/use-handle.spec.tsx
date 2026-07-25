/** @jsxImportSource react */
// @vitest-environment happy-dom
/**
 * `useHandle` — the generic client-handle React binding.
 *
 * Proves: re-render on handle change; referential-stability (a stable `list()`
 * ref produces NO render loop — the render-count assertion the whole design
 * hinges on); the SSR `getServerSnapshot` path renders without throwing.
 *
 * The fake handle mirrors the real handles' store contract (a `liveStore`-style
 * held snapshot: `list()` returns the SAME array ref until `set` replaces it),
 * so what passes here is exactly what the bundled handles guarantee.
 */

import { act, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filteredView,
  type ClientHandle,
  type CollectionViewSource,
  type Enumerable,
} from "@agentick/client-core";

import { useHandle } from "../use-handle.js";

interface Item {
  readonly id: string;
  readonly label: string;
}

/** A controllable fake handle: a held snapshot + zero-arg subscribe (the store
 * contract). `list()` is ref-stable between `set`s — the invariant `useHandle`
 * relies on. `unstable: true` returns a FRESH array per call (the contract
 * VIOLATION used to prove the binding does not silently paper over it). */
function fakeHandle(
  initial: readonly Item[],
  { unstable = false }: { unstable?: boolean } = {},
): ClientHandle & Enumerable<Item> & { set(next: readonly Item[]): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    list: () => (unstable ? [...state] : state),
    get: (id) => state.find((x) => x.id === id),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      state = next;
      for (const l of [...listeners]) l();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHandle", () => {
  it("renders the handle's current snapshot and re-renders on change", () => {
    const handle = fakeHandle([{ id: "a", label: "Alpha" }]);
    function View() {
      const items = useHandle(handle);
      return (
        <ul>
          {items.map((i) => (
            <li key={i.id}>{i.label}</li>
          ))}
        </ul>
      );
    }

    render(<View />);
    expect(screen.getByText("Alpha")).toBeTruthy();

    act(() => {
      handle.set([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]);
    });
    expect(screen.getByText("Bravo")).toBeTruthy();
  });

  it("does NOT render-loop when list() is referentially stable (render-count bound)", () => {
    const handle = fakeHandle([{ id: "a", label: "Alpha" }]);
    const renders = vi.fn();
    function Counter() {
      renders();
      const items = useHandle(handle);
      return <span>{items.length}</span>;
    }

    render(<Counter />);
    // A stable getSnapshot => exactly one render for the mount (no loop). If the
    // snapshot ref churned, useSyncExternalStore would re-render without bound.
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => {
      handle.set([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]);
    });
    // Exactly one additional render for the one change — still bounded.
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("surfaces a handle that violates the ref-stability contract (documents the requirement)", () => {
    // A handle whose list() returns a fresh array every call breaks the
    // useSyncExternalStore contract. React detects the churn and throws rather
    // than looping forever — proving `useHandle` relies on the contract instead
    // of silently re-caching around a broken store.
    const handle = fakeHandle([{ id: "a", label: "Alpha" }], { unstable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function View() {
      const items = useHandle(handle);
      return <span>{items.length}</span>;
    }
    expect(() => render(<View />)).toThrow(/getSnapshot|Maximum update depth/i);
    errSpy.mockRestore();
  });

  it("renders on the server via getServerSnapshot without throwing", () => {
    const handle = fakeHandle([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Bravo" },
    ]);
    function View() {
      const items = useHandle(handle);
      return (
        <ul>
          {items.map((i) => (
            <li key={i.id}>{i.label}</li>
          ))}
        </ul>
      );
    }
    // renderToStaticMarkup drives the third (getServerSnapshot) argument; it must
    // return the same snapshot and not touch any browser-only path.
    const html = renderToStaticMarkup(<View />);
    expect(html).toContain("Alpha");
    expect(html).toContain("Bravo");
  });

  it("works on a minted FilteredView (same structural store contract, ref-stable)", () => {
    // A FilteredView is `list()/get()/subscribe()/close()` — structurally a
    // ClientHandle & Enumerable, so useHandle binds it with no special-casing.
    // Uses the REAL filteredView so its memoized (ref-stable) projection is what
    // drives the hook — a filtered view whose list() churned would render-loop.
    const handle = fakeHandle([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Bravo" },
    ]);
    const source: CollectionViewSource<Item> = {
      list: () => handle.list(),
      subscribe: (cb) => handle.subscribe(cb),
    };
    const view = filteredView(source, { filter: (i) => i.id === "b" }, (i) => i.id);
    function View() {
      const items = useHandle(view);
      return <span>{items.map((i) => i.label).join(",")}</span>;
    }
    render(<View />);
    expect(screen.getByText("Bravo")).toBeTruthy();
  });
});
