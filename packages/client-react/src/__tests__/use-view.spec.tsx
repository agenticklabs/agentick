/** @jsxImportSource react */
// @vitest-environment happy-dom
/**
 * `useView` — the React binding for a handle's VIEW FACTORY.
 *
 * Proves: renders the minted view's filtered projection; re-renders on source
 * change; closes the view on unmount; re-mints (closing the old view) on dep
 * change; no render loop (the minted view's `list()` is ref-stable — the
 * `filteredView` memo fix). The fake handle mints a REAL `filteredView` over a
 * controllable source, wrapped to record `close`, so the lifecycle asserted here
 * is the real one `session.timeline.view(...)` exercises.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { filteredView, type CollectionViewSource, type FilteredView } from "@agentick/client-core";

import { useView, type ViewCapableHandle } from "../use-view.js";

interface Item {
  readonly id: string;
  readonly kind: "a" | "b";
}

interface ViewOpts {
  readonly filter?: (item: Item) => boolean;
}

/** A view-capable handle over a controllable source. `view(opts)` mints a REAL
 * filteredView wrapped so tests can observe `close`. `set` drives the source. */
function fakeViewHandle(): ViewCapableHandle<Item, ViewOpts> & {
  set(items: readonly Item[]): void;
  closeCalls(): number;
  openCalls(): number;
} {
  let items: readonly Item[] = [];
  const listeners = new Set<() => void>();
  const source: CollectionViewSource<Item> = {
    list: () => items,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  let closeCalls = 0;
  let openCalls = 0;
  return {
    view(opts?: ViewOpts): FilteredView<Item> {
      openCalls++;
      const v = filteredView(source, opts ?? {}, (i) => i.id);
      return {
        list: v.list,
        get: v.get,
        subscribe: v.subscribe,
        close: () => {
          closeCalls++;
          v.close();
        },
      };
    },
    set(next) {
      items = next;
      for (const l of [...listeners]) l();
    },
    closeCalls: () => closeCalls,
    openCalls: () => openCalls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useView", () => {
  it("renders the minted view's filtered projection and re-renders on source change", () => {
    const handle = fakeViewHandle();
    function View() {
      const items = useView(handle, { filter: (i) => i.kind === "a" });
      return <span data-testid="ids">{items.map((i) => i.id).join(",")}</span>;
    }

    render(<View />);
    act(() => {
      handle.set([
        { id: "1", kind: "a" },
        { id: "2", kind: "b" },
        { id: "3", kind: "a" },
      ]);
    });
    expect(screen.getByTestId("ids").textContent).toBe("1,3"); // kind "b" filtered out
  });

  it("does NOT render-loop (minted view list() is ref-stable)", () => {
    const handle = fakeViewHandle();
    const renders = vi.fn();
    function Counter() {
      renders();
      const items = useView(handle, { filter: (i) => i.kind === "a" });
      return <span>{items.length}</span>;
    }
    render(<Counter />);
    expect(renders).toHaveBeenCalledTimes(1); // bounded — one mount render, no loop
    act(() => {
      handle.set([{ id: "1", kind: "a" }]);
    });
    expect(renders).toHaveBeenCalledTimes(2); // one change, one more render
  });

  it("closes the view on unmount", () => {
    const handle = fakeViewHandle();
    function View() {
      const items = useView(handle, {});
      return <span>{items.length}</span>;
    }
    const { unmount } = render(<View />);
    expect(handle.openCalls()).toBe(1);
    expect(handle.closeCalls()).toBe(0);
    unmount();
    expect(handle.closeCalls()).toBe(1);
  });

  it("re-mints (closing the previous view) when deps change", () => {
    const handle = fakeViewHandle();
    handle.set([
      { id: "1", kind: "a" },
      { id: "2", kind: "b" },
    ]);
    function View({ kind }: { kind: "a" | "b" }) {
      const items = useView(handle, { filter: (i) => i.kind === kind }, [kind]);
      return <span data-testid="ids">{items.map((i) => i.id).join(",")}</span>;
    }

    const { rerender } = render(<View kind="a" />);
    expect(screen.getByTestId("ids").textContent).toBe("1");
    expect(handle.openCalls()).toBe(1);

    rerender(<View kind="b" />);
    expect(screen.getByTestId("ids").textContent).toBe("2");
    expect(handle.openCalls()).toBe(2); // re-minted for the new dep
    expect(handle.closeCalls()).toBe(1); // the old view was closed
  });

  it("keeps the SAME view across re-renders with unchanged deps (no churn)", () => {
    const handle = fakeViewHandle();
    function View() {
      const items = useView(handle, {}, []);
      return <span>{items.length}</span>;
    }
    const { rerender } = render(<View />);
    rerender(<View />);
    rerender(<View />);
    expect(handle.openCalls()).toBe(1); // minted once, reused
    expect(handle.closeCalls()).toBe(0);
  });
});
