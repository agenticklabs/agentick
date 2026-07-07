import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AlreadyMounted,
  BridgeUnavailable,
  DataFetchFailed,
  FormatterFailed,
  InvalidElement,
  isLifecycleTickStart,
  MaxIterationsExceeded,
  NotMounted,
  RenderFailed,
  SnapshotIncompatible,
  UnstableTree,
} from "../index.js";

import type {
  DataBridge,
  DataResolveOptions,
  HookBridges,
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
  UnmountInput,
} from "../index.js";

describe("@agentick/spec-next — reconciler protocol", () => {
  describe("MountInput / MountResult", () => {
    it("accepts a minimal mount", () => {
      const input: MountInput = {
        mountId: "m_1",
        sessionId: "s_1",
        element: { type: "section", props: {} } as unknown,
        bridges: fakeBridges(),
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
      // The discriminator `kind` is `string & {}` on LifecycleCustom,
      // which prevents literal-narrowing across the union. The
      // `isLifecycleTickStart` guard is the canonical way to narrow.
      const first = inputs[0]!.event;
      if (isLifecycleTickStart(first)) {
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
      // Per ADR 27, per-bridge state lives in `bridges` (an opaque map
      // keyed by HookBridges slot). Knobs/state/timeline payloads land
      // here at runtime via SnapshotCapable feature-detection. Spec's
      // own typecheck only sees the foundational slots, so the test
      // exercises the un-augmented shape.
      const snap: ReconcilerSnapshot = {
        specVersion: "2026-05-01",
        mountId: "m_1",
        elementVersion: "v1",
        bridges: {},
        dataCache: [{ key: "user/42", value: { name: "x" }, fetchedAt: 1 }],
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
      expect(round.dataCache[0]?.key).toBe("user/42");
    });
  });

  describe("ReconcileError taxonomy", () => {
    it("discriminates by _tag", () => {
      const errs: ReconcileError[] = [
        new NotMounted({ mountId: "x" }),
        new AlreadyMounted({ mountId: "x" }),
        new RenderFailed({ cause: new Error("bad") }),
        new DataFetchFailed({ key: "user/42", cause: "timeout" }),
        new MaxIterationsExceeded({ iterations: 10 }),
        new UnstableTree({ iterations: 10 }),
        new InvalidElement({ reason: "not a react element" }),
        new SnapshotIncompatible({ specVersion: "2025-01-01" }),
        new BridgeUnavailable({ bridge: "mcp", hook: "useMCP" }),
        new FormatterFailed({ cause: "missing renderer" }),
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
        "error-boundary-active",
      ];
      expect(codes).toHaveLength(9);
    });
  });

  describe("HookBridges — DataBridge contract", () => {
    it("peek returns undefined when no entry exists; fetch initiates and resolves", async () => {
      const cache = new Map<string, unknown>();
      const data: DataBridge = {
        peek<T>(key: string) {
          if (!cache.has(key)) return undefined;
          return { kind: "value" as const, value: cache.get(key) as T };
        },
        async fetch<T>(key: string, fetcher: () => Promise<T>) {
          if (cache.has(key)) return cache.get(key) as T;
          const value = await fetcher();
          cache.set(key, value);
          return value;
        },
        subscribe: () => () => {},
        invalidate(key) {
          cache.delete(key);
        },
        invalidateTag: () => {},
        has(key) {
          return cache.has(key);
        },
      };
      expect(data.peek("uncached")).toBeUndefined();
      const value = await data.fetch("k", async () => "v");
      expect(value).toBe("v");
      expect(data.peek("k")).toEqual({ kind: "value", value: "v" });
    });

    it("DataResolveOptions allows ttl + tag", () => {
      const opts: DataResolveOptions = { ttl: 60_000, tag: "user-profile" };
      expect(opts.ttl).toBe(60_000);
    });
  });

  describe("HookBridges — Loop / Session", () => {
    // Knob / Timeline / State are full harnesses now (ADR 26). Their
    // conformance suites live with their packages (`@agentick/knobs-next`,
    // `@agentick/timeline-next`, `@agentick/state-next`) — see
    // `runKnobsHarnessConformance`, `runTimelineHarnessConformance`,
    // `runStateHarnessConformance`.

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

function fakeBridges(): HookBridges {
  // Spec-side HookBridges only declares the foundational slots
  // (data, loop, session, tools). Other slots — timeline, knobs,
  // state, sandbox, mcp, ... — are added by their respective
  // packages via module augmentation per ADR 27. Spec's own tests
  // only exercise the pre-augmentation surface; conformance for
  // augmented slots lives with the packages that own them.
  return {
    data: {
      peek: () => undefined,
      fetch: <T>(_k: string, fetcher: () => Promise<T>) => fetcher(),
      subscribe: () => () => {},
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
    bridges: {},
    dataCache: [],
    subscriptions: [],
  };
}
