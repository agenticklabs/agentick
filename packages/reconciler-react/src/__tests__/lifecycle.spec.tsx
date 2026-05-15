import { describe, expect, it } from "vitest";
import React, { useState } from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { stubBridges } from "../bridges/stub-bridges.js";
import { useOnTickStart } from "../react/hooks/use-on-tick-start.js";
import { useOnTickEnd } from "../react/hooks/use-on-tick-end.js";
import { useOnExecutionStart } from "../react/hooks/use-on-execution-start.js";
import { useOnExecutionEnd } from "../react/hooks/use-on-execution-end.js";
import { useOnError } from "../react/hooks/use-on-error.js";
import { LifecycleStore } from "../harness/lifecycle-store.js";
import { flush } from "../testing/flush.js";

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_lifecycle",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("LifecycleStore — dispatch + catch-up unit tests", () => {
  it("dispatch invokes registered handlers for the matching kind", async () => {
    const store = new LifecycleStore();
    const seen: string[] = [];
    store.register("tick-start", () => {
      seen.push("ts");
    });
    store.register("tick-end", () => {
      seen.push("te");
    });
    await store.dispatch({ kind: "tick-start", tickId: "t1" });
    expect(seen).toEqual(["ts"]);
    await store.dispatch({ kind: "tick-end", tickId: "t1", result: 0 });
    expect(seen).toEqual(["ts", "te"]);
  });

  it("catch-up: handler registered AFTER tick-start fires immediately", async () => {
    const store = new LifecycleStore();
    await store.dispatch({ kind: "tick-start", tickId: "t1" });
    const seen: string[] = [];
    store.register("tick-start", (ev) => {
      seen.push(`${ev.tickId}-late`);
    });
    // Catch-up is synchronous within the register call.
    expect(seen).toEqual(["t1-late"]);
  });

  it("no catch-up after tick-end clears the active tick-start", async () => {
    const store = new LifecycleStore();
    await store.dispatch({ kind: "tick-start", tickId: "t1" });
    await store.dispatch({ kind: "tick-end", tickId: "t1", result: 0 });
    const seen: string[] = [];
    store.register("tick-start", (ev) => {
      seen.push(ev.tickId);
    });
    // tick-start is no longer active → no catch-up.
    expect(seen).toEqual([]);
  });

  it("handler registered BEFORE dispatch is NOT double-fired on catch-up", async () => {
    const store = new LifecycleStore();
    const seen: string[] = [];
    store.register("tick-start", (ev) => {
      seen.push(ev.tickId);
    });
    await store.dispatch({ kind: "tick-start", tickId: "t1" });
    expect(seen).toEqual(["t1"]);
    // Registering ANOTHER handler should catch up, but the existing
    // handler shouldn't see t1 again.
    store.register("tick-start", (ev) => {
      seen.push(`late-${ev.tickId}`);
    });
    expect(seen).toEqual(["t1", "late-t1"]);
  });

  it("execution-start catch-up works the same way", async () => {
    const store = new LifecycleStore();
    await store.dispatch({ kind: "execution-start", executionId: "e1" });
    const seen: string[] = [];
    store.register("execution-start", (ev) => {
      seen.push(ev.executionId);
    });
    expect(seen).toEqual(["e1"]);
  });

  it("tick-end / execution-end / error have NO catch-up", async () => {
    const store = new LifecycleStore();
    await store.dispatch({ kind: "tick-end", tickId: "t1", result: 0 });
    await store.dispatch({ kind: "execution-end", executionId: "e1", outcome: "ok" });
    await store.dispatch({
      kind: "error",
      phase: "tick",
      error: { name: "E", message: "x" },
    });
    const seen: string[] = [];
    store.register("tick-end", () => seen.push("te"));
    store.register("execution-end", () => seen.push("ee"));
    store.register("error", () => seen.push("err"));
    expect(seen).toEqual([]);
  });

  it("clear() drops all state", async () => {
    const store = new LifecycleStore();
    let calls = 0;
    store.register("tick-start", () => {
      calls++;
    });
    await store.dispatch({ kind: "tick-start", tickId: "t1" });
    expect(calls).toBe(1);
    store.clear();
    await store.dispatch({ kind: "tick-start", tickId: "t2" });
    expect(calls).toBe(1);
  });

  it("counts() reports registered handler totals", () => {
    const store = new LifecycleStore();
    store.register("tick-start", () => {});
    store.register("tick-start", () => {});
    store.register("error", () => {});
    expect(store.counts()).toEqual({
      "tick-start": 2,
      "tick-end": 0,
      "execution-start": 0,
      "execution-end": 0,
      error: 1,
    });
  });
});

describe("Lifecycle hooks — integration through ReconcilerHarness", () => {
  it("useOnTickStart fires when notifyLifecycle dispatches tick-start", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function App() {
      useOnTickStart((ev) => {
        events.push(`start:${ev.tickId}`);
      });
      useOnTickEnd((ev) => {
        events.push(`end:${ev.tickId}`);
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_ts",
      sessionId: "s",
      element: React.createElement(App),
      bridges: stubBridges(),
    });
    // useEffect (which registers the lifecycle handlers) runs after
    // commit. Flush to ensure registration completes before dispatch.
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_ts",
      event: { kind: "tick-start", tickId: "t1" },
    });
    await harness.notifyLifecycle({
      mountId: "m_ts",
      event: { kind: "tick-end", tickId: "t1", result: { ok: true } },
    });
    expect(events).toEqual(["start:t1", "end:t1"]);
  });

  it("CATCH-UP: useOnTickStart in a mid-tick mount fires on registration", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function Mountee() {
      useOnTickStart((ev) => {
        events.push(`catch-up:${ev.tickId}`);
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    // Mount with an EMPTY tree first. The lifecycle store has no
    // handlers yet.
    await harness.mount({
      mountId: "m_late",
      sessionId: "s",
      element: React.createElement(React.Fragment),
      bridges: stubBridges(),
    });
    await flush();

    // Tick starts. No handlers, nothing fires. The active tick-start
    // is now remembered by the store.
    await harness.notifyLifecycle({
      mountId: "m_late",
      event: { kind: "tick-start", tickId: "t-mid" },
    });

    // NOW the user component mounts (rerender swaps element in). Its
    // useOnTickStart handler should fire immediately (catch-up).
    await harness.rerender({
      mountId: "m_late",
      element: React.createElement(Mountee),
    });
    await flush();

    expect(events).toEqual(["catch-up:t-mid"]);
  });

  it("CATCH-UP fires only once per handler, even across renders", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function Mountee({ label }: { label: string }) {
      useOnTickStart((ev) => {
        events.push(`${label}:${ev.tickId}`);
      });
      return React.createElement("message", { role: "user" }, label);
    }

    await harness.mount({
      mountId: "m_once",
      sessionId: "s",
      element: React.createElement(React.Fragment),
      bridges: stubBridges(),
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_once",
      event: { kind: "tick-start", tickId: "t1" },
    });

    await harness.rerender({
      mountId: "m_once",
      element: React.createElement(Mountee, { label: "a" }),
    });
    await flush();

    // A second rerender with a prop change → React reconciles in
    // place. The hook should NOT fire a second time for the same tick.
    await harness.rerender({
      mountId: "m_once",
      element: React.createElement(Mountee, { label: "a" }),
    });
    await flush();

    expect(events).toEqual(["a:t1"]);
  });

  it("useOnExecutionStart catch-up works through the harness", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function Mountee() {
      useOnExecutionStart((ev) => {
        events.push(`exec:${ev.executionId}`);
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_exec",
      sessionId: "s",
      element: React.createElement(React.Fragment),
      bridges: stubBridges(),
    });
    await flush();
    await harness.notifyLifecycle({
      mountId: "m_exec",
      event: { kind: "execution-start", executionId: "e1" },
    });
    await harness.rerender({
      mountId: "m_exec",
      element: React.createElement(Mountee),
    });
    await flush();
    expect(events).toEqual(["exec:e1"]);
  });

  it("useOnError fires for error events", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function App() {
      useOnError((ev) => {
        events.push(`${ev.phase}:${ev.error.message}`);
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_err",
      sessionId: "s",
      element: React.createElement(App),
      bridges: stubBridges(),
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_err",
      event: {
        kind: "error",
        phase: "tick",
        error: { name: "RenderFailed", message: "boom" },
      },
    });
    expect(events).toEqual(["tick:boom"]);
  });

  it("useOnExecutionEnd fires once for execution-end (no catch-up)", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function App() {
      useOnExecutionEnd((ev) => {
        events.push(`${ev.executionId}:${String(ev.outcome)}`);
      });
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_eend",
      sessionId: "s",
      element: React.createElement(App),
      bridges: stubBridges(),
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_eend",
      event: { kind: "execution-end", executionId: "e1", outcome: "succeeded" },
    });
    expect(events).toEqual(["e1:succeeded"]);
  });

  it("unmount clears the lifecycle store; later dispatch is a no-op", async () => {
    const harness = await makeHarness();
    const events: string[] = [];

    function App() {
      useOnTickStart((ev) => events.push(ev.tickId));
      return React.createElement("message", { role: "user" }, "ok");
    }

    await harness.mount({
      mountId: "m_unmount",
      sessionId: "s",
      element: React.createElement(App),
      bridges: stubBridges(),
    });
    await flush();

    await harness.notifyLifecycle({
      mountId: "m_unmount",
      event: { kind: "tick-start", tickId: "t1" },
    });
    expect(events).toEqual(["t1"]);

    await harness.unmount({ mountId: "m_unmount" });
    await expect(
      harness.notifyLifecycle({
        mountId: "m_unmount",
        event: { kind: "tick-start", tickId: "t2" },
      }),
    ).rejects.toMatchObject({ _tag: "NotMounted" });
  });
});

// Suppress unused-symbol warning when useState isn't otherwise touched.
void useState;
