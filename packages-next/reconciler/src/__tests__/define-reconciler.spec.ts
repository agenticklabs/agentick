/**
 * `defineReconciler` — smoke tests for the callback-style factory.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import {
  isReconcilerFactory,
  type MountResult,
  type ProtocolEvent,
  type RenderTreeResult,
} from "@agentick/spec-next";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { defineReconciler } from "../define-reconciler.js";
import { fakeBridges } from "../testing/fake-bridges.js";

// Minimum-required input fixtures for the current spec. Each spec
// change that adds a required field surfaces here at typecheck time —
// that's the point of running these inputs through strict tsc.
const mountInput = () =>
  ({
    mountId: "m_1",
    sessionId: "test-session",
    element: null,
    bridges: fakeBridges(),
  }) as const;
const renderInput = () =>
  ({
    mountId: "m_1",
    sessionId: "test-session",
  }) as const;

const fakeRenderTreeResult = (_mountId: string): RenderTreeResult => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: { context: { entries: [] }, declarations: {} } as any,
  diagnostics: [],
  iterations: 1,
});

describe("defineReconciler — factory shape", () => {
  it("returns a ReconcilerFactory (passes marker)", () => {
    const factory = defineReconciler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }) as MountResult,
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    expect(isReconcilerFactory(factory)).toBe(true);
  });

  it("constructs a reconciler whose mount/renderTree/unmount delegate", async () => {
    const events: string[] = [];
    const factory = defineReconciler({
      mount: async () => {
        events.push("mount");
        return { mountId: "m_1", restoredFromSnapshot: false };
      },
      unmount: async () => {
        events.push("unmount");
      },
      renderTree: async (i) => {
        events.push("renderTree");
        return fakeRenderTreeResult(i.mountId);
      },
    });
    const r = factory({
      scopeId: "test-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const m = await r.mount(mountInput());
    expect(m.mountId).toBe("m_1");
    expect(m.restoredFromSnapshot).toBe(false);
    const tree = await r.renderTree(renderInput());
    expect(tree.iterations).toBe(1);
    await r.unmount({ mountId: m.mountId });
    expect(events).toEqual(["mount", "renderTree", "unmount"]);
  });
});

describe("defineReconciler — defaults + envelopes", () => {
  it("unconfigured snapshot/renderToString reject; rerender/notifyLifecycle/restore no-op", async () => {
    const factory = defineReconciler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }),
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    const r = factory({
      scopeId: "defaults-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await expect(r.renderToString({ mountId: "m_1" })).rejects.toBeDefined();
    await expect(r.snapshot({ mountId: "m_1" })).rejects.toBeDefined();
    // No-op defaults resolve without error.
    await expect(r.rerender({ mountId: "m_1", element: null })).resolves.toBeUndefined();
    await expect(
      r.notifyLifecycle({ mountId: "m_1", event: { kind: "tick:start" } } as never),
    ).resolves.toBeUndefined();
    await expect(r.restore({ mountId: "m_1", snapshot: {} as never })).resolves.toBeUndefined();
  });

  it("mount + renderTree + unmount emit envelopes on the supplied bus", async () => {
    const bus = new LocalEventBus();
    const factory = defineReconciler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }),
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    const r = factory({
      scopeId: "env-1",
      journal: new MemoryJournal(),
      bus,
      inbox: new LocalInbox(),
    });

    const events: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "reconciler" }), (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ),
    );
    await new Promise((rs) => setImmediate(rs));

    await r.mount(mountInput());
    await r.renderTree(renderInput());
    await r.unmount({ mountId: "m_1" });
    await new Promise((rs) => setTimeout(rs, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const names = new Set(events.map((e) => e.name));
    expect(names.has("reconciler:command:mount")).toBe(true);
    expect(names.has("reconciler:command:render-tree")).toBe(true);
    expect(names.has("reconciler:command:unmount")).toBe(true);
  });
});
