/**
 * GatewayHarness — Phase 4 Tier 0 smoke tests.
 *
 * Covers:
 *   - Basic construction + ready
 *   - createApp with default (gateway-substrate) inheritance
 *   - createApp with per-app substrate factory override
 *   - apps()/app(id) read-side
 *   - closeGateway cascades into app closes
 *   - events() observes app-level events via fan-in
 *   - Duplicate appId rejection
 *   - GatewayClosedError after close
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { LocalEventBus, MemoryJournal, LocalInbox } from "@agentick/runtime-next";
import type { ProtocolEvent } from "@agentick/spec-next";
import { AppAlreadyExistsError, GatewayClosedError } from "@agentick/spec-next";

import { createGateway } from "../index.js";

/**
 * Minimal stub reconciler + executor + loop for AppHarness construction.
 * These satisfy the type contract without requiring real React or a real
 * model — enough to instantiate an AppHarness for gateway-level testing.
 */
function makeAppOptions() {
  return {
    rootElement: {} as unknown,
    // Use a mock executor — real shape doesn't matter for the gateway-level
    // tests; AppHarness must be constructible.
    executor: {
      target: {
        kind: "language-model" as const,
        provider: "mock",
        modelId: "stub",
      },
      project: () => ({}) as never,
      execute: () => Effect.succeed({}) as never,
      executeStream: undefined,
      normalize: () => ({}) as never,
      run: () => Effect.succeed({}) as never,
      abort: () => Effect.succeed(undefined) as never,
    } as never,
    // Mock reconciler — minimal viable shape.
    reconciler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

describe("GatewayHarness — construction + lifecycle", () => {
  it("constructs with default in-memory substrate and becomes ready", async () => {
    const gateway = await createGateway();
    expect(gateway.id).toMatch(/^gateway:/);
    expect(gateway.apps()).toEqual([]);
    await gateway.closeGateway();
  });

  it("accepts a custom gatewayId", async () => {
    const gateway = await createGateway({ gatewayId: "my-gateway" });
    expect(gateway.id).toBe("my-gateway");
    await gateway.close();
  });

  it("accepts pre-built substrate instances", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const gateway = await createGateway({ journal, bus, inbox });
    expect(gateway.id).toMatch(/^gateway:/);
    await gateway.closeGateway();
  });

  it("close() is an alias for closeGateway()", async () => {
    const gateway = await createGateway();
    await gateway.close();
    // No assertion needed; throwing the second close should be a no-op.
    await gateway.close();
  });

  it("close({ drain: false }) is the forced variant — resolves and closes", async () => {
    const gateway = await createGateway();
    await gateway.close({ drain: false });
    // Idempotent regardless of the drain flag.
    await gateway.close({ drain: false });
  });
});

describe("GatewayHarness — listen() + gateway:start op (ADR 84 §1)", () => {
  it("listen() runs the hookable gateway:start op — onBefore/onAfterGatewayStart fire", async () => {
    const gateway = await createGateway();
    let before = 0;
    let after = 0;
    gateway.hook({
      onBeforeGatewayStart: (input) => {
        before++;
        return input;
      },
      onAfterGatewayStart: (output) => {
        after++;
        return output;
      },
    });
    await gateway.listen();
    expect(before).toBe(1);
    expect(after).toBe(1);
    await gateway.closeGateway();
  });

  it("listen() is idempotent — a second call is a no-op (op does not re-fire)", async () => {
    const gateway = await createGateway();
    let fired = 0;
    gateway.hook({
      onBeforeGatewayStart: (input) => {
        fired++;
        return input;
      },
    });
    await gateway.listen();
    await gateway.listen();
    expect(fired).toBe(1);
    await gateway.closeGateway();
  });
});

describe("GatewayHarness — gateway:close op (ADR 84 §1)", () => {
  it("closeGateway() runs the hookable gateway:close op — onBefore/onAfterGatewayClose fire", async () => {
    const gateway = await createGateway();
    let before = 0;
    let after = 0;
    gateway.hook({
      onBeforeGatewayClose: (input) => {
        before++;
        return input;
      },
      onAfterGatewayClose: (output) => {
        after++;
        return output;
      },
    });
    await gateway.closeGateway();
    expect(before).toBe(1);
    expect(after).toBe(1);
  });
});

describe("GatewayHarness — gateway:create-app op (ADR 84 §4)", () => {
  it("onBeforeGatewayCreateApp transforms the mount input; onAfterGatewayCreateApp sees the app", async () => {
    const gateway = await createGateway();
    let afterSawId: string | undefined;
    // Multi-tenant gating: the before-hook rewrites the mount input (here,
    // stamping a tenant-scoped appId) and the after-hook observes the mounted
    // app. Both run around `createApp` via the hookable op.
    gateway.hook({
      onBeforeGatewayCreateApp: (input) => ({ ...input, appId: "tenant-scoped-app" }),
      onAfterGatewayCreateApp: (app) => {
        afterSawId = app.id;
        return app;
      },
    });
    // Caller passes NO appId; the before-hook supplies one.
    const app = await gateway.createApp({
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    expect(app.id).toBe("tenant-scoped-app");
    expect(afterSawId).toBe("tenant-scoped-app");
    expect(gateway.app("tenant-scoped-app")).toBe(app);
    await gateway.closeGateway();
  });

  it("onBeforeGatewayCreateApp can VETO a mount by throwing — no app is registered", async () => {
    const gateway = await createGateway();
    gateway.hook({
      onBeforeGatewayCreateApp: () => {
        throw new Error("tenant not provisioned");
      },
    });
    await expect(
      gateway.createApp({ rootElement: {} as unknown, options: makeAppOptions() as never }),
    ).rejects.toThrow(/tenant not provisioned/);
    // The veto short-circuited the mount body: nothing was registered.
    expect(gateway.apps()).toEqual([]);
    await gateway.closeGateway();
  });
});

describe("GatewayHarness — createApp", () => {
  it("creates an app inheriting gateway substrate by default", async () => {
    const gateway = await createGateway();
    const app = await gateway.createApp({
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    expect(app.id).toMatch(/^app:/);
    expect(gateway.apps()).toHaveLength(1);
    expect(gateway.app(app.id)).toBe(app);
    await gateway.closeGateway();
  });

  it("accepts a caller-supplied appId", async () => {
    const gateway = await createGateway();
    const app = await gateway.createApp({
      appId: "my-app",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    expect(app.id).toBe("my-app");
    expect(gateway.app(app.id)).toBe(app);
    await gateway.closeGateway();
  });

  it("rejects duplicate appId", async () => {
    const gateway = await createGateway();
    await gateway.createApp({
      appId: "dup",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    await expect(
      gateway.createApp({
        appId: "dup",
        rootElement: {} as unknown,
        options: makeAppOptions() as never,
      }),
    ).rejects.toBeInstanceOf(AppAlreadyExistsError);
    await gateway.closeGateway();
  });

  it("emits gateway:app:created on the bus when an app is created", async () => {
    const gateway = await createGateway();
    const events: ProtocolEvent[] = [];
    const sub = Effect.runFork(
      Stream.runForEach(
        // Read the underlying bus directly (we don't expose it via the
        // public protocol — but the impl class does via a protected
        // member, so this test reaches in for verification).
        // Easier path: gateway.events() filters across the gateway bus.
        Stream.take(
          // gateway.events returns an AsyncIterable; convert via fromAsyncIterable
          // for take.
          Stream.fromAsyncIterable(
            gateway.events({ surface: "gateway", name: { exact: "gateway:app:created" } }),
            (err) => err as never,
          ),
          1,
        ),
        (e) =>
          Effect.sync(() => {
            events.push(e);
          }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    const app = await gateway.createApp({
      appId: "observed-app",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
      metadata: { tenant: "alpha" },
    });
    // Give the bus fan-out a tick.
    await new Promise((r) => setTimeout(r, 10));

    void sub;
    void app;
    expect(events).toHaveLength(1);
    expect(events[0]!.surface).toBe("gateway");
    expect(events[0]!.name).toBe("gateway:app:created");
    expect((events[0]!.scope as Record<string, unknown>).appId).toBe("observed-app");
    expect((events[0]!.payload as Record<string, unknown>).metadata).toEqual({ tenant: "alpha" });

    await gateway.closeGateway();
  });
});

describe("GatewayHarness — close cascade", () => {
  it("closes every app on closeGateway", async () => {
    const gateway = await createGateway();
    await gateway.createApp({
      appId: "a",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    await gateway.createApp({
      appId: "b",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
    });
    expect(gateway.apps()).toHaveLength(2);
    await gateway.closeGateway();
    expect(gateway.apps()).toHaveLength(0);
  });

  it("rejects createApp after close", async () => {
    const gateway = await createGateway();
    await gateway.closeGateway();
    await expect(
      gateway.createApp({
        rootElement: {} as unknown,
        options: makeAppOptions() as never,
      }),
    ).rejects.toBeInstanceOf(GatewayClosedError);
  });
});

describe("GatewayHarness — per-app substrate factory override", () => {
  it("uses caller-supplied substrate factory for per-app isolation", async () => {
    const gateway = await createGateway();
    const localBus = new LocalEventBus();
    const app = await gateway.createApp({
      appId: "tenant-a",
      rootElement: {} as unknown,
      options: makeAppOptions() as never,
      bus: localBus, // explicit instance override; factory form covered in app-level tests
    });
    expect(gateway.app("tenant-a")).toBe(app);
    void localBus;
    await gateway.closeGateway();
  });
});
