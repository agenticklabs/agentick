/** @jsxImportSource react */
// @vitest-environment happy-dom
/**
 * Integration: `useHandle` drives a REAL client handle end-to-end.
 *
 * The unit specs bind fakes that mirror the store contract; this one wires the
 * actual `tasksHandle` (a `channelView` fold over the `task-status` channel) to a
 * spy transport and proves the whole path: a client that mounts, then receives a
 * snapshot frame, re-renders with the folded state — and does so without a render
 * loop (the real handle's `list()` is ref-stable per frame, the invariant
 * `useHandle` relies on). This closes the "works on the real handles, not just my
 * fakes" gap.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { spyClientTransport } from "@agentick/client-core-next/testing";
import type { TaskInfo } from "@agentick/spec-next";
import { tasksHandle } from "@agentick/tasks-next/client";

import { useHandle } from "../use-handle.js";

const TASK_STATUS_CHANNEL = "task-status";

function task(taskId: string): TaskInfo {
  return { taskId, status: "working", createdAt: 0, lastUpdatedAt: 0, ttl: null };
}

describe("useHandle × real tasksHandle", () => {
  it("re-renders with the folded snapshot when a frame arrives", async () => {
    const spy = spyClientTransport();
    const handle = tasksHandle(spy, "s1");
    function View() {
      const tasks = useHandle(handle);
      return <span data-testid="ids">{tasks.map((t) => t.taskId).join(",")}</span>;
    }

    render(<View />);
    expect(screen.getByTestId("ids").textContent).toBe(""); // empty before any frame

    act(() => {
      spy.emit(TASK_STATUS_CHANNEL, { kind: "snapshot", tasks: [task("t1"), task("t2")] });
    });
    await waitFor(() => expect(screen.getByTestId("ids").textContent).toBe("t1,t2"));

    handle.close();
  });

  it("does not render-loop on the real handle (ref-stable list())", async () => {
    const spy = spyClientTransport();
    const handle = tasksHandle(spy, "s1");
    let renders = 0;
    function Counter() {
      renders++;
      const tasks = useHandle(handle);
      return <span data-testid="n">{tasks.length}</span>;
    }

    render(<Counter />);
    const afterMount = renders;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    act(() => {
      spy.emit(TASK_STATUS_CHANNEL, { kind: "snapshot", tasks: [task("t1")] });
    });
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("1"));
    // One fold => a bounded number of additional renders (no getSnapshot loop).
    expect(renders - afterMount).toBeLessThanOrEqual(2);

    handle.close();
  });
});
