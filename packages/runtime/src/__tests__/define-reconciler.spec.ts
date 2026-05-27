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
} from "@agentick/spec";

import { defineReconciler } from "../define-reconciler.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

const fakeRenderTreeResult = (mountId: string): RenderTreeResult => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: { context: { entries: [] }, declarations: {} } as any,
  diagnostics: { warnings: [], errors: [] },
  version: 1,
  mountId,
});

describe("defineReconciler — factory shape", () => {
  it("returns a ReconcilerFactory (passes marker)", () => {
    const factory = defineReconciler({
      mount: async () => ({ mountId: "m_1" }) as MountResult,
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
        return { mountId: "m_1" };
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
    const m = await r.mount({ element: null });
    expect(m.mountId).toBe("m_1");
    const tree = await r.renderTree({ mountId: m.mountId });
    expect(tree.mountId).toBe("m_1");
    await r.unmount({ mountId: m.mountId });
    expect(events).toEqual(["mount", "renderTree", "unmount"]);
  });
});

describe("defineReconciler — defaults + envelopes", () => {
  it("unconfigured snapshot/renderToString reject; rerender/notifyLifecycle/restore no-op", async () => {
    const factory = defineReconciler({
      mount: async () => ({ mountId: "m_1" }),
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    const r = factory({
      scopeId: "defaults-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await expect(r.renderToString({ element: null })).rejects.toBeDefined();
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
      mount: async () => ({ mountId: "m_1" }),
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

    await r.mount({ element: null });
    await r.renderTree({ mountId: "m_1" });
    await r.unmount({ mountId: "m_1" });
    await new Promise((rs) => setTimeout(rs, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const names = new Set(events.map((e) => e.name));
    expect(names.has("reconciler:command:mount")).toBe(true);
    expect(names.has("reconciler:command:render-tree")).toBe(true);
    expect(names.has("reconciler:command:unmount")).toBe(true);
  });
});
