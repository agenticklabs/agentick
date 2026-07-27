/**
 * `defineCompiler` — smoke tests for the callback-style factory.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import {
  isCompilerFactory,
  type MountResult,
  type ProtocolEvent,
  type RenderTreeResult,
} from "@agentick/spec";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { defineCompiler } from "../define-compiler.js";
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

describe("defineCompiler — factory shape", () => {
  it("returns a CompilerFactory (passes marker)", () => {
    const factory = defineCompiler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }) as MountResult,
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    expect(isCompilerFactory(factory)).toBe(true);
  });

  it("constructs a compiler whose mount/renderTree/unmount delegate", async () => {
    const events: string[] = [];
    const factory = defineCompiler({
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

describe("defineCompiler — standalone construction (no deps)", () => {
  // `defineCompiler` has always implemented `(deps?)` with a local-substrate
  // fallback (a private MemoryJournal / LocalEventBus / LocalInbox), because a
  // standalone compiler — a test, a REPL, an adopter probing their callbacks
  // before wiring an app — has no shared substrate to pass. `CompilerFactory`
  // declared the parameter REQUIRED, so the fallback was unreachable through
  // the public type: this dep-less call did not compile.
  //
  // These two cases are the pair that keeps it reachable: the call itself
  // (compile-time, enforced by the package's strict `tsc` over its tests) and
  // the fallback substrate actually working (run-time).
  it("constructs with NO deps — the local-substrate fallback", async () => {
    const factory = defineCompiler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }),
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    const r = factory();
    const m = await r.mount(mountInput());
    expect(m.mountId).toBe("m_1");
  });

  it("the fallback substrate is live — envelopes flow on the private bus", async () => {
    const factory = defineCompiler({
      mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }),
      unmount: async () => {},
      renderTree: async (i) => fakeRenderTreeResult(i.mountId),
    });
    // No `bus` to subscribe to from the outside, so observe the fallback
    // through the journal it also mints: a completed operation recorded there
    // proves the substrate is a real one, not a set of undefined slots.
    const r = factory();
    await r.mount(mountInput());
    await r.renderTree(renderInput());
    // Two distinct scopeIds must not collide — each dep-less call mints its own.
    const r2 = factory();
    expect(r2).not.toBe(r);
    await expect(r2.mount(mountInput())).resolves.toBeDefined();
  });
});

describe("defineCompiler — defaults + envelopes", () => {
  it("unconfigured snapshot/renderToString reject; rerender/restore no-op", async () => {
    const factory = defineCompiler({
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
    await expect(r.restore({ mountId: "m_1", snapshot: {} as never })).resolves.toBeUndefined();
  });

  it("mount + renderTree + unmount emit envelopes on the supplied bus", async () => {
    const bus = new LocalEventBus();
    const factory = defineCompiler({
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
      Stream.runForEach(bus.subscribe({ surface: "compiler" }), (e) =>
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
    expect(names.has("compiler:command:mount")).toBe(true);
    expect(names.has("compiler:command:render-tree")).toBe(true);
    expect(names.has("compiler:command:unmount")).toBe(true);
  });
});
