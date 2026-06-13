import { describe, expect, it } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ReconcilerHarness, useData } from "@agentick/reconciler-react-next";
import { InMemoryDataBridge, fakeBridges, fakeKnobsHarness } from "@agentick/reconciler-next";
import { useKnob } from "@agentick/knobs-next/react";
import { flush } from "@agentick/reconciler-react-next/testing";
import type { HookBridges, ReconcilerSnapshot } from "@agentick/spec-next";

async function makeHarness(scope = `snap-${Math.random()}`) {
  const harness = new ReconcilerHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("InMemoryDataBridge — snapshot/restore unit", () => {
  it("export → import round-trips fulfilled entries", async () => {
    const src = new InMemoryDataBridge();
    await src.fetch("user/42", async () => ({ name: "Ryan" }));
    await src.fetch("config", async () => ({ theme: "dark" }), { tag: "config" });

    const snap = src.exportSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map((e) => e.key).sort()).toEqual(["config", "user/42"]);

    const dest = new InMemoryDataBridge();
    dest.importSnapshot(snap);
    expect(dest.peek<{ name: string }>("user/42")).toMatchObject({
      kind: "value",
      value: { name: "Ryan" },
    });
    expect(dest.peek<{ theme: string }>("config")).toMatchObject({
      kind: "value",
      value: { theme: "dark" },
    });
  });

  it("export skips pending entries", () => {
    const bridge = new InMemoryDataBridge();
    void bridge.fetch("k", async () => "v"); // still pending
    expect(bridge.exportSnapshot()).toHaveLength(0);
  });

  it("export skips rejected entries", async () => {
    const bridge = new InMemoryDataBridge();
    await bridge.fetch("bad", () => Promise.reject(new Error("x"))).catch(() => {});
    expect(bridge.exportSnapshot()).toHaveLength(0);
  });

  it("import respects TTL — stale entries are skipped", () => {
    const bridge = new InMemoryDataBridge();
    bridge.importSnapshot([
      { key: "fresh", value: 1, fetchedAt: Date.now(), ttl: 60_000 },
      { key: "stale", value: 2, fetchedAt: Date.now() - 60_000, ttl: 1 },
    ]);
    expect(bridge.has("fresh")).toBe(true);
    expect(bridge.has("stale")).toBe(false);
  });

  it("invalidateTag works after import", async () => {
    const bridge = new InMemoryDataBridge();
    bridge.importSnapshot([
      { key: "a", value: 1, fetchedAt: Date.now(), tag: "group" },
      { key: "b", value: 2, fetchedAt: Date.now(), tag: "group" },
      { key: "c", value: 3, fetchedAt: Date.now(), tag: "other" },
    ]);
    bridge.invalidateTag("group");
    expect(bridge.has("a")).toBe(false);
    expect(bridge.has("b")).toBe(false);
    expect(bridge.has("c")).toBe(true);
  });
});

describe("KnobsHarness — snapshot/restore unit", () => {
  it("export → import round-trips all values + fires subscribers on changed ids", () => {
    const src = fakeKnobsHarness({ a: 1, b: 2 });
    expect(src.exportSnapshot()).toEqual({ a: 1, b: 2 });

    const dest = fakeKnobsHarness();
    let aChanges = 0;
    let cChanges = 0;
    dest.subscribe("a", () => aChanges++);
    dest.subscribe("c", () => cChanges++);
    dest.importSnapshot({ a: 1, b: 2, c: 3 });

    expect(dest.get("a")).toBe(1);
    expect(dest.get("c")).toBe(3);
    expect(aChanges).toBe(1);
    expect(cChanges).toBe(1);
  });
});

describe("ReconcilerHarness — snapshot/restore through the harness", () => {
  it("snapshot captures data cache + knob values; restore applies them", async () => {
    const harness = await makeHarness();
    const bridges = fakeBridges({ knobs: { mood: "curious" } });

    function App() {
      const [mood] = useKnob("mood", "curious");
      const name = useData("user", async () => "Ryan");
      return React.createElement("message", { role: "user" }, `${mood}-${name}`);
    }
    await harness.mount({
      mountId: "m_snap",
      sessionId: "s",
      element: React.createElement(App),
      bridges,
      elementVersion: "sha:v1",
    });
    await harness.renderTree({ mountId: "m_snap", sessionId: "s" });
    await flush();

    const snap = await harness.snapshot({ mountId: "m_snap" });
    expect(snap.bridges.knobs).toEqual({ mood: "curious" });
    expect(snap.dataCache).toHaveLength(1);
    expect(snap.dataCache[0]).toMatchObject({ key: "user", value: "Ryan" });
    expect(snap.elementVersion).toBe("sha:v1");

    // Cleanly survives JSON round-trip — the spec firewall.
    const round: ReconcilerSnapshot = JSON.parse(JSON.stringify(snap));
    expect(round).toEqual(snap);
  });

  it("restore on a fresh mount re-hydrates the data cache (no re-fetch needed)", async () => {
    // First mount: fetch data + take snapshot.
    const harness1 = await makeHarness("snap-h1");
    const bridges1 = fakeBridges();
    let fetches1 = 0;

    function App1() {
      const v = useData("user", async () => {
        fetches1++;
        return "Ryan";
      });
      return React.createElement("message", { role: "user" }, v);
    }
    await harness1.mount({
      mountId: "m_h1",
      sessionId: "s",
      element: React.createElement(App1),
      bridges: bridges1,
    });
    await harness1.renderTree({ mountId: "m_h1", sessionId: "s" });
    await flush();
    expect(fetches1).toBe(1);
    const snap = await harness1.snapshot({ mountId: "m_h1" });

    // Second mount on a fresh harness + fresh bridges, with restore.
    const harness2 = await makeHarness("snap-h2");
    const bridges2 = fakeBridges();
    let fetches2 = 0;

    function App2() {
      const v = useData("user", async () => {
        fetches2++;
        return "Ryan";
      });
      return React.createElement("message", { role: "user" }, v);
    }
    await harness2.mount({
      mountId: "m_h2",
      sessionId: "s",
      element: React.createElement(App2),
      bridges: bridges2,
      snapshot: snap,
    });
    // Apply the snapshot to the live mount — restore() pushes
    // dataCache + knobs into the bridges so the next render finds the
    // cached value immediately.
    await harness2.restore({ mountId: "m_h2", snapshot: snap });
    await harness2.renderTree({ mountId: "m_h2", sessionId: "s" });
    await flush();

    // The fetcher should NOT have been invoked on the restored mount —
    // the cache hit short-circuits the fetch.
    expect(fetches2).toBe(0);
  });

  it("restore on a fresh mount re-hydrates knob values", async () => {
    const harness1 = await makeHarness("knob-h1");
    const bridges1 = fakeBridges({ knobs: { mood: "curious" } });
    function App() {
      const [mood] = useKnob("mood", "fallback");
      return React.createElement("message", { role: "user" }, mood);
    }
    await harness1.mount({
      mountId: "m_k1",
      sessionId: "s",
      element: React.createElement(App),
      bridges: bridges1,
    });
    await bridges1.knobs.set({ id: "mood", value: "decisive" });
    await flush();
    const snap = await harness1.snapshot({ mountId: "m_k1" });
    expect((snap.bridges.knobs as { mood?: string }).mood).toBe("decisive");

    const harness2 = await makeHarness("knob-h2");
    const bridges2 = fakeBridges();
    await harness2.mount({
      mountId: "m_k2",
      sessionId: "s",
      element: React.createElement(App),
      bridges: bridges2,
    });
    await harness2.restore({ mountId: "m_k2", snapshot: snap });
    expect(bridges2.knobs.get("mood")).toBe("decisive");
  });

  it("snapshot JSON round-trip survives spec firewall", async () => {
    const harness = await makeHarness("firewall");
    // KnobPrimitive is string | number | boolean — nested objects are
    // intentionally rejected at the type level (snapshot wire format
    // requires JSON-primitive values).
    const bridges = fakeBridges({ knobs: { n: 42, s: "hi", b: true } });
    await harness.mount({
      mountId: "m_fw",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "ok"),
      bridges,
    });
    // `fetch(key, fetcher)` is the canonical entry point — `resolve`
    // was renamed during the bridge consolidation.
    await bridges.data.fetch("k", async () => ({ ok: true }));
    const snap = await harness.snapshot({ mountId: "m_fw" });
    const round = JSON.parse(JSON.stringify(snap));
    expect(round).toEqual(snap);
  });

  it("snapshot captures and restores StateBridge values", async () => {
    const harness = await makeHarness("state");
    const bridges = fakeBridges();
    await bridges.state.set({ key: "counter", value: 7 });
    await bridges.state.set({ key: "label", value: "hello" });
    await harness.mount({
      mountId: "m_s",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "ok"),
      bridges,
    });
    const snap = await harness.snapshot({ mountId: "m_s" });
    expect(snap.bridges.state).toEqual({ counter: 7, label: "hello" });

    // Round-trip JSON to confirm wire shape
    const wire = JSON.parse(JSON.stringify(snap));
    expect(wire.bridges.state).toEqual({ counter: 7, label: "hello" });

    // Mutate the live bridge, then restore — values should snap back.
    await bridges.state.set({ key: "counter", value: 99 });
    await harness.restore({ mountId: "m_s", snapshot: snap });
    expect(bridges.state.get("counter")).toBe(7);
  });

  it("custom (non-InMemory) data bridge does not export to snapshot", async () => {
    const harness = await makeHarness("custom-data");
    const bridges: HookBridges = {
      ...fakeBridges(),
      data: {
        peek: () => undefined,
        fetch: async <T,>(_k: string, _f: () => Promise<T>): Promise<T> => "x" as unknown as T,
        subscribe: () => () => {},
        invalidate: () => {},
        invalidateTag: () => {},
        has: () => true,
      },
    };
    await harness.mount({
      mountId: "m_cd",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "ok"),
      bridges,
    });
    const snap = await harness.snapshot({ mountId: "m_cd" });
    expect(snap.dataCache).toEqual([]);
  });
});
