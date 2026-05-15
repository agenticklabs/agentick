import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  DataBridge,
  DataResolveOptions,
  HookBridges,
  KnobBridge,
  LifecycleEvent,
  LoopBridge,
  MountInput,
  MountResult,
  NotifyLifecycleInput,
  ReconcileDiagnostic,
  ReconcileError,
  ReconcilerInboxMessage,
  ReconcilerProtocol,
  ReconcilerSnapshot,
  RenderTreeInput,
  RenderTreeResult,
  RenderToStringInput,
  RenderToStringPayload,
  RenderToStringResult,
  RerenderInput,
  RestoreInput,
  SessionBridge,
  SnapshotInput,
  SubscriptionIntent,
  TimelineBridge,
  TimelineSnapshot,
  UnmountInput,
} from "../index.js";

describe("@agentick/spec — reconciler protocol", () => {
  describe("MountInput / MountResult", () => {
    it("accepts a minimal mount", () => {
      const input: MountInput = {
        mountId: "m_1",
        sessionId: "s_1",
        element: { type: "section", props: {} } as unknown,
        bridges: stubBridges(),
      };
      expect(input.mountId).toBe("m_1");
    });

    it("MountResult reports restore status", () => {
      const result: MountResult = { mountId: "m_1", restoredFromSnapshot: true };
      expect(result.restoredFromSnapshot).toBe(true);
    });
  });

  describe("RenderTreeInput / Result", () => {
    it("RenderTreeInput accepts purpose + maxIterations", () => {
      const input: RenderTreeInput = {
        mountId: "m_1",
        sessionId: "s_1",
        purpose: "tick",
        maxIterations: 5,
      };
      expect(input.purpose).toBe("tick");
    });

    it("RenderTreeResult bundles tree + diagnostics + iterations", () => {
      const result: RenderTreeResult = {
        tree: {
          specVersion: "2026-05-01",
          context: { entries: [] },
        },
        diagnostics: [],
        iterations: 1,
      };
      expect(result.iterations).toBe(1);
    });
  });

  describe("RenderToString", () => {
    it("RenderToStringInput is mountId-only by default", () => {
      const input: RenderToStringInput = { mountId: "m_1" };
      expect(input.mountId).toBe("m_1");
    });

    it("RenderToStringInput accepts a formatter override", () => {
      const input: RenderToStringInput = {
        mountId: "m_1",
        formatter: { id: "xml", format: "xml" },
      };
      expect(input.formatter?.id).toBe("xml");
    });

    it("RenderToStringResult carries a string payload + mime", () => {
      const result: RenderToStringResult = {
        payload: { text: "# Hi", mimeType: "text/markdown" },
        diagnostics: [],
        iterations: 1,
      };
      const payload: RenderToStringPayload = result.payload;
      expect(payload.text).toBe("# Hi");
    });
  });

  describe("rerender / notifyLifecycle / unmount / snapshot / restore", () => {
    it("RerenderInput carries new element + optional version", () => {
      const input: RerenderInput = {
        mountId: "m_1",
        element: {} as unknown,
        elementVersion: "sha:abc",
      };
      expect(input.elementVersion).toBe("sha:abc");
    });

    it("NotifyLifecycleInput discriminates on event.kind", () => {
      const events: LifecycleEvent[] = [
        { kind: "tick-start", tickId: "t_1", executionId: "e_1" },
        { kind: "tick-end", tickId: "t_1", result: { stopReason: "end" } },
        { kind: "execution-start", executionId: "e_1" },
        { kind: "execution-end", executionId: "e_1", outcome: "succeeded" },
        {
          kind: "error",
          phase: "tick",
          error: { name: "Error", message: "boom" },
        },
      ];
      const inputs: NotifyLifecycleInput[] = events.map((event) => ({
        mountId: "m_1",
        event,
      }));
      expect(inputs).toHaveLength(5);
      const first = inputs[0]!.event;
      if (first.kind === "tick-start") {
        expect(first.tickId).toBe("t_1");
      }
    });

    it("LifecycleEvent tick-end carries an opaque result payload", () => {
      const event: LifecycleEvent = {
        kind: "tick-end",
        tickId: "t_1",
        result: { stopReason: "end", toolCalls: [] },
      };
      if (event.kind === "tick-end") {
        expect((event.result as { stopReason: string }).stopReason).toBe("end");
      }
    });

    it("UnmountInput / SnapshotInput / RestoreInput are mount-scoped", () => {
      const u: UnmountInput = { mountId: "m_1" };
      const s: SnapshotInput = { mountId: "m_1" };
      const r: RestoreInput = {
        mountId: "m_1",
        snapshot: emptySnapshot("m_1"),
      };
      expect([u, s, r].map((x) => x.mountId)).toEqual(["m_1", "m_1", "m_1"]);
    });
  });

  describe("ReconcilerSnapshot", () => {
    it("survives JSON round-trip", () => {
      const snap: ReconcilerSnapshot = {
        specVersion: "2026-05-01",
        mountId: "m_1",
        elementVersion: "v1",
        hookStates: [{ path: "0.1", hookIndex: 0, type: "state", value: 42 }],
        dataCache: [{ key: "user/42", value: { name: "x" }, fetchedAt: 1 }],
        knobs: { mood: "curious" },
        subscriptions: [
          {
            id: "cron.daily",
            kind: "cron",
            config: { expr: "0 0 * * *" },
          } satisfies SubscriptionIntent,
        ],
      };
      const round = JSON.parse(JSON.stringify(snap)) as ReconcilerSnapshot;
      expect(round.mountId).toBe(snap.mountId);
      expect(round.knobs.mood).toBe("curious");
    });
  });

  describe("ReconcileError taxonomy", () => {
    it("discriminates by _tag", () => {
      const errs: ReconcileError[] = [
        { _tag: "NotMounted", mountId: "x" },
        { _tag: "AlreadyMounted", mountId: "x" },
        { _tag: "RenderFailed", cause: new Error("bad") },
        { _tag: "DataFetchFailed", key: "user/42", cause: "timeout" },
        { _tag: "MaxIterationsExceeded", iterations: 10 },
        { _tag: "UnstableTree", iterations: 10 },
        { _tag: "InvalidElement", reason: "not a react element" },
        { _tag: "SnapshotIncompatible", specVersion: "2025-01-01" },
        { _tag: "BridgeUnavailable", bridge: "mcp", hook: "useMCP" },
        { _tag: "FormatterFailed", cause: "missing renderer" },
      ];
      expect(errs).toHaveLength(10);
    });
  });

  describe("ReconcilerInboxMessage", () => {
    it("supports recompile / unmount / invalidate", () => {
      const ms: ReconcilerInboxMessage[] = [
        { type: "recompile", mountId: "m_1", reason: "knob changed" },
        { type: "unmount", mountId: "m_1" },
        { type: "invalidate", mountId: "m_1", keys: ["user/42"] },
        { type: "invalidate", mountId: "m_1", tags: ["mutable"] },
      ];
      expect(ms[0]!.type).toBe("recompile");
    });
  });

  describe("ReconcileDiagnostic", () => {
    it("includes the documented codes", () => {
      const codes: ReconcileDiagnostic["code"][] = [
        "max-iterations",
        "use-data-failed",
        "missing-contributor",
        "missing-bridge",
        "formatter-error",
        "render-error",
        "snapshot-incompatible",
        "unstable-tree",
        "suspense-boundary-active",
        "error-boundary-active",
      ];
      expect(codes).toHaveLength(10);
    });
  });

  describe("MountInput.strictNoSuspense", () => {
    it("opts into hard-fail-on-suspense behavior", () => {
      const input: MountInput = {
        mountId: "m_1",
        sessionId: "s_1",
        element: {} as unknown,
        bridges: stubBridges(),
        strictNoSuspense: true,
      };
      expect(input.strictNoSuspense).toBe(true);
    });

    it("defaults to undefined (warn-only)", () => {
      const input: MountInput = {
        mountId: "m_1",
        sessionId: "s_1",
        element: {} as unknown,
        bridges: stubBridges(),
      };
      expect(input.strictNoSuspense).toBeUndefined();
    });
  });

  describe("HookBridges — DataBridge no-Suspense contract", () => {
    it("resolve returns T synchronously when cached", () => {
      const data: DataBridge = {
        resolve<T>(key: string, fetcher: () => Promise<T>): T {
          if (key === "cached") return ("hit" as unknown) as T;
          throw fetcher();
        },
        invalidate() {},
        invalidateTag() {},
        has(key) {
          return key === "cached";
        },
      };
      const value = data.resolve("cached", async () => "should-not-run");
      expect(value).toBe("hit");
    });

    it("resolve throws a Promise to signal pending data (not Suspense)", async () => {
      let thrown: unknown;
      const data: DataBridge = {
        resolve<T>(key: string, fetcher: () => Promise<T>): T {
          throw fetcher();
        },
        invalidate() {},
        invalidateTag() {},
        has() {
          return false;
        },
      };
      try {
        data.resolve("uncached", async () => "value");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Promise);
      const resolved = await (thrown as Promise<string>);
      expect(resolved).toBe("value");
    });

    it("resolve throws the underlying error on prior fetch rejection", () => {
      const err = new Error("network down");
      const data: DataBridge = {
        resolve<T>(key: string): T {
          if (key === "failed") throw err;
          throw new Promise(() => {});
        },
        invalidate() {},
        invalidateTag() {},
        has(key) {
          return key === "failed";
        },
      };
      expect(() => data.resolve("failed", async () => "x")).toThrow("network down");
    });

    it("DataResolveOptions allows ttl + tag", () => {
      const opts: DataResolveOptions = { ttl: 60_000, tag: "user-profile" };
      expect(opts.ttl).toBe(60_000);
    });
  });

  describe("HookBridges — Knob / Timeline / Loop / Session", () => {
    it("KnobBridge get/set/list/subscribe", () => {
      const k: KnobBridge = {
        get: () => 1,
        set: () => {},
        list: () => [{ id: "x", value: 1 }],
        subscribe: () => () => {},
      };
      expect(k.get("x")).toBe(1);
      expect(k.list()).toHaveLength(1);
    });

    it("TimelineBridge read returns a snapshot with version", () => {
      const t: TimelineBridge = {
        read: () => ({ entries: [], version: 0 }),
        subscribe: () => () => {},
      };
      const snap: TimelineSnapshot = t.read();
      expect(snap.version).toBe(0);
    });

    it("LoopBridge has continue / stop", () => {
      const l: LoopBridge = {
        continueAfterTick: () => {},
        stopAfterTick: () => {},
      };
      expectTypeOf(l.continueAfterTick).toBeFunction();
      expectTypeOf(l.stopAfterTick).toBeFunction();
    });

    it("SessionBridge exposes identity + status", () => {
      const s: SessionBridge = { id: "s_1", status: "running", currentTick: 3 };
      expect(s.status).toBe("running");
    });
  });

  describe("ReconcilerProtocol shape", () => {
    it("requires the documented methods", () => {
      // Compile-time check via a structural type guard.
      type Required = keyof ReconcilerProtocol;
      const required: Required[] = [
        "mount",
        "rerender",
        "renderTree",
        "renderToString",
        "notifyLifecycle",
        "unmount",
        "snapshot",
        "restore",
      ];
      expect(required).toHaveLength(8);
    });
  });
});

// ============================================================================
// helpers
// ============================================================================

function stubBridges(): HookBridges {
  return {
    timeline: {
      read: () => ({ entries: [], version: 0 }),
      subscribe: () => () => {},
    },
    knobs: {
      get: () => undefined,
      set: () => {},
      list: () => [],
      subscribe: () => () => {},
    },
    data: {
      resolve: <T>(_k: string, _f: () => Promise<T>): T => undefined as unknown as T,
      invalidate: () => {},
      invalidateTag: () => {},
      has: () => false,
    },
    loop: {
      continueAfterTick: () => {},
      stopAfterTick: () => {},
    },
    session: { id: "s_1", status: "running" },
  };
}

function emptySnapshot(mountId: string): ReconcilerSnapshot {
  return {
    specVersion: "2026-05-01",
    mountId,
    hookStates: [],
    dataCache: [],
    knobs: {},
    subscriptions: [],
  };
}
