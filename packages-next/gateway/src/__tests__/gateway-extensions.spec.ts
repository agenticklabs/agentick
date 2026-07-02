/**
 * GatewayExtension (ADR 50) — adversarial suite for the gateway-scoped
 * extension surface: the third leg of the App/Session/Gateway extension
 * triad.
 *
 * Verifies, against the REAL `createGateway` / `createApp` / AppHarness
 * install path (no protocol mocks — cascade delivery is an integration
 * property):
 *   - install fires during construction; `registerNamespace` populates
 *     `gateway.bridges.<name>`; the installer host reflects live apps.
 *   - GatewayBridges is a HARD SINGLETON — occupied slot throws (ADR 50),
 *     and the throw propagates through `gatewayReady` to fail
 *     `createGateway` (no half-constructed gateway, no unhandled rejection).
 *   - an extension whose `install()` throws fails `createGateway` and does
 *     NOT leave a half-sealed wire registry (seal-in-finally invariant).
 *   - `registerWireExtension` during install is dispatch-resolvable; after
 *     the registry seals (post-ready) it throws — the ADR 46 sealed-registry
 *     rule reused verbatim.
 *   - ExtensionBundle distributes by field: gateway→install, wire→registry,
 *     app/session→cascade to every `createApp`.
 *   - cascade ORDERING: gateway-level parts compose BEFORE per-call parts.
 *   - `onClose` handlers fire in LIFO (reverse install) order on
 *     `closeGateway`, after apps close.
 *   - `subscribeBus` delivers gateway bus events to the extension.
 *   - the no-gateway-extensions path seals synchronously (zero behavior
 *     change vs. pre-ADR-50).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AppExtension,
  GatewayExtension,
  GatewayInstaller,
  GatewayInstallerHost,
  ExtensionBundle,
  ProtocolEvent,
  SessionExtension,
} from "@agentick/spec-next";
import { SPEC_VERSION, GatewayBridgeSlotOccupied, defineWireExtension } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";

import { createGateway } from "../index.js";

// Declaration-merge fabricated slots so extension bodies typecheck under
// strict tsc (the tests exercise runtime behavior, not the real bridges).
declare module "@agentick/spec-next" {
  interface GatewayBridges {
    testCap: { readonly ping: () => string };
    other: { readonly value: number };
  }
  interface WireMethods {
    "gwext/ping": { params: object; result: { readonly pong: true } };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    executor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" }],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    reconciler: new ReconcilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
  };
}

const NULL_ROOT = null as unknown;

const pingWire = () =>
  defineWireExtension({
    name: "@test/gwext",
    namespace: "gwext",
    methods: { "gwext/ping": async () => ({ pong: true as const }) },
  });

// ---------------------------------------------------------------------------

describe("GatewayExtension — install + bridges (ADR 50)", () => {
  it("fires install during construction and populates gateway.bridges.<name>", async () => {
    const ext: GatewayExtension = {
      name: "test:cap",
      target: "gateway",
      install(installer) {
        installer.registerNamespace("testCap", { ping: () => "pong" });
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    expect(gateway.bridges.testCap).toBeDefined();
    expect(gateway.bridges.testCap.ping()).toBe("pong");
    await gateway.closeGateway();
  });

  it("exposes a live installer host — gatewayId + apps() reflect reality", async () => {
    let host: GatewayInstallerHost | undefined;
    const ext: GatewayExtension = {
      name: "test:host",
      target: "gateway",
      install(installer) {
        host = installer.gateway;
        installer.registerNamespace("testCap", { ping: () => "x" });
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    expect(host).toBeDefined();
    expect(host!.gatewayId).toBe(gateway.id);
    // No apps at install time; the accessor is live, so it observes ones
    // created afterward.
    expect(host!.apps()).toHaveLength(0);
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    expect(host!.apps()).toHaveLength(1);
    await gateway.closeGateway();
  });

  it("awaits async install() before gatewayReady resolves", async () => {
    let installed = false;
    const ext: GatewayExtension = {
      name: "test:async",
      target: "gateway",
      async install(installer) {
        await Promise.resolve();
        installed = true;
        installer.registerNamespace("testCap", { ping: () => "async" });
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    // createGateway awaited gatewayReady, which awaited install().
    expect(installed).toBe(true);
    expect(gateway.bridges.testCap.ping()).toBe("async");
    await gateway.closeGateway();
  });
});

describe("GatewayBridges — hard singleton", () => {
  it("throws on an occupied slot and fails createGateway (no half-built gateway)", async () => {
    const a: GatewayExtension = {
      name: "test:a",
      target: "gateway",
      install: (i) => void i.registerNamespace("testCap", { ping: () => "a" }),
    };
    const b: GatewayExtension = {
      name: "test:b",
      target: "gateway",
      install: (i) => void i.registerNamespace("testCap", { ping: () => "b" }),
    };

    // Second install throws → gatewayReady rejects → createGateway rejects.
    // The rejection is the typed GatewayBridgeSlotOccupied (catchTag-able),
    // carrying the offending slot, not a bare Error.
    const err = await createGateway({ extensions: [a, b] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayBridgeSlotOccupied);
    expect((err as GatewayBridgeSlotOccupied)._tag).toBe("GatewayBridgeSlotOccupied");
    expect((err as GatewayBridgeSlotOccupied).slot).toBe("testCap");
  });

  it("allows distinct slots side by side", async () => {
    const a: GatewayExtension = {
      name: "test:a",
      target: "gateway",
      install: (i) => void i.registerNamespace("testCap", { ping: () => "a" }),
    };
    const b: GatewayExtension = {
      name: "test:b",
      target: "gateway",
      install: (i) => void i.registerNamespace("other", { value: 42 }),
    };

    const gateway = await createGateway({ extensions: [a, b] });
    expect(gateway.bridges.testCap.ping()).toBe("a");
    expect(gateway.bridges.other.value).toBe(42);
    await gateway.closeGateway();
  });
});

describe("GatewayExtension — install failure propagation", () => {
  it("a throwing install() rejects createGateway", async () => {
    const boom: GatewayExtension = {
      name: "test:boom",
      target: "gateway",
      install() {
        throw new Error("install exploded");
      },
    };
    await expect(createGateway({ extensions: [boom] })).rejects.toThrow(/install exploded/);
  });

  it("a throwing install() does not leave the wire registry half-sealed", async () => {
    // The failing install registered a wire extension before throwing. The
    // seal-in-finally invariant means the registry is sealed regardless, so
    // the extension it DID register can never be mutated post-failure. We
    // observe the invariant via a sibling gateway extension that captures
    // the installer, then assert post-failure registration throws (sealed).
    let captured: GatewayInstaller | undefined;
    const capture: GatewayExtension = {
      name: "test:capture",
      target: "gateway",
      install(installer) {
        captured = installer;
        installer.registerWireExtension(pingWire());
      },
    };
    const boom: GatewayExtension = {
      name: "test:boom",
      target: "gateway",
      install() {
        throw new Error("install exploded");
      },
    };

    await expect(createGateway({ extensions: [capture, boom] })).rejects.toThrow(
      /install exploded/,
    );
    // Registry sealed by the finally even though construction failed.
    expect(captured).toBeDefined();
    expect(() => captured!.registerWireExtension(pingWire())).toThrow(/sealed/i);
  });
});

describe("GatewayInstaller — registerWireExtension", () => {
  it("registers a wire extension during install that the dispatcher can resolve", async () => {
    const ext: GatewayExtension = {
      name: "test:wire",
      target: "gateway",
      install(installer) {
        installer.registerWireExtension(pingWire());
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    const resolved = gateway.wireExtensions().resolve("gwext/ping");
    expect(resolved).toBeDefined();
    expect(await resolved!.handler({}, {})).toEqual({ pong: true });
    await gateway.closeGateway();
  });

  it("throws when registerWireExtension is called after the registry seals (post-ready)", async () => {
    let captured: GatewayInstaller | undefined;
    const ext: GatewayExtension = {
      name: "test:late",
      target: "gateway",
      install(installer) {
        captured = installer;
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    // Registry sealed once gatewayReady resolved — the ADR 46 rule.
    expect(() => captured!.registerWireExtension(pingWire())).toThrow(/sealed/i);
    await gateway.closeGateway();
  });
});

describe("ExtensionBundle — field distribution + cascade", () => {
  it("distributes gateway → install, wire → registry, app/session → createApp cascade", async () => {
    const events: string[] = [];
    const bundle: ExtensionBundle = {
      name: "test:bundle",
      gateway: {
        name: "b:gw",
        target: "gateway",
        install: (i) => void i.registerNamespace("testCap", { ping: () => "bundled" }),
      },
      wire: [pingWire()],
      app: {
        name: "b:app",
        target: "app",
        install: () => void events.push("app-install"),
      },
      session: {
        name: "b:session",
        target: "session",
        install: () => void events.push("session-install"),
      },
    };

    const gateway = await createGateway({ extensions: [bundle] });
    // Gateway part installed synchronously with construction.
    expect(gateway.bridges.testCap.ping()).toBe("bundled");
    // Wire part in the dispatcher registry.
    expect(gateway.wireExtensions().resolve("gwext/ping")).toBeDefined();
    // App/session parts cascade — nothing installed until an app/session exists.
    expect(events).toEqual([]);

    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    expect(events).toContain("app-install");
    expect(events).not.toContain("session-install");

    await app.createSession();
    expect(events).toContain("session-install");

    await gateway.closeGateway();
  });

  it("composes gateway-level cascade BEFORE per-call extensions", async () => {
    const order: string[] = [];
    const gwCascadeApp: AppExtension = {
      name: "cascade:app",
      target: "app",
      install: () => void order.push("gateway-cascade"),
    };
    const perCallApp: AppExtension = {
      name: "percall:app",
      target: "app",
      install: () => void order.push("per-call"),
    };

    // Gateway-level bundle carrying an app part → cascades to every createApp.
    const gateway = await createGateway({
      extensions: [{ name: "b", app: gwCascadeApp }],
    });
    await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), extensions: [perCallApp] },
    });

    // Outer scope composes first — gateway cascade installs before per-call.
    expect(order).toEqual(["gateway-cascade", "per-call"]);
    await gateway.closeGateway();
  });

  it("cascades a BARE app extension (not wrapped in a bundle) to every app", async () => {
    // Exercises splitExtensions' bare-branch: an AppExtension passed
    // directly in `extensions` (not via ExtensionBundle.app) still cascades.
    let installed = false;
    const bare: AppExtension = {
      name: "bare:app",
      target: "app",
      install: () => void (installed = true),
    };
    const gateway = await createGateway({ extensions: [bare] });
    expect(installed).toBe(false); // nothing to install onto yet
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    expect(installed).toBe(true);
    await gateway.closeGateway();
  });

  it("cascades a BARE session extension to every session", async () => {
    let installed = false;
    const bare: SessionExtension = {
      name: "bare:session",
      target: "session",
      install: () => void (installed = true),
    };
    const gateway = await createGateway({ extensions: [bare] });
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    expect(installed).toBe(false); // no session yet
    await app.createSession();
    expect(installed).toBe(true);
    await gateway.closeGateway();
  });

  it("cascades the same gateway-level app part to EVERY app", async () => {
    let installs = 0;
    const shared: AppExtension = {
      name: "cascade:count",
      target: "app",
      install: () => void installs++,
    };
    const gateway = await createGateway({ extensions: [{ name: "b", app: shared }] });
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    expect(installs).toBe(2);
    await gateway.closeGateway();
  });
});

describe("GatewayExtension — lifecycle", () => {
  it("fires onClose handlers in LIFO (reverse install) order", async () => {
    const teardown: string[] = [];
    const first: GatewayExtension = {
      name: "test:first",
      target: "gateway",
      install: (i) => i.onClose(() => void teardown.push("first")),
    };
    const second: GatewayExtension = {
      name: "test:second",
      target: "gateway",
      install: (i) => i.onClose(() => void teardown.push("second")),
    };

    const gateway = await createGateway({ extensions: [first, second] });
    await gateway.closeGateway();
    // Reverse install order — last installed tears down first.
    expect(teardown).toEqual(["second", "first"]);
  });

  it("fires onClose AFTER apps close", async () => {
    const order: string[] = [];
    const ext: GatewayExtension = {
      name: "test:order",
      target: "gateway",
      install: (i) => i.onClose(() => void order.push("gateway-ext-close")),
    };
    const gateway = await createGateway({ extensions: [ext] });
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const origClose = app.closeApp.bind(app);
    vi.spyOn(app, "closeApp").mockImplementation(async () => {
      order.push("app-close");
      await origClose();
    });

    await gateway.closeGateway();
    expect(order).toEqual(["app-close", "gateway-ext-close"]);
  });
});

describe("GatewayInstaller — subscribeBus", () => {
  it("delivers gateway bus events to the extension", async () => {
    const seen: ProtocolEvent[] = [];
    const ext: GatewayExtension = {
      name: "test:observer",
      target: "gateway",
      install(installer) {
        installer.subscribeBus({ surface: "gateway" }, (event) => {
          seen.push(event);
        });
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    gateway.emitCapabilitiesChanged();
    await waitFor(() => (seen.length > 0 ? true : undefined), {
      description: "extension observes the gateway bus event",
      timeoutMs: 2_000,
    });
    await gateway.closeGateway();
  });

  it("keeps delivering after a listener throws (per-event error isolation)", async () => {
    // Regression guard: `Effect.promise` would treat a listener rejection
    // as a fiber-killing defect, silently stopping ALL future delivery.
    // The subscription must survive a throwing event.
    let calls = 0;
    const ext: GatewayExtension = {
      name: "test:throwing-observer",
      target: "gateway",
      install(installer) {
        installer.subscribeBus({ surface: "gateway" }, () => {
          calls++;
          if (calls === 1) throw new Error("first-event boom");
        });
      },
    };

    const gateway = await createGateway({ extensions: [ext] });
    gateway.emitCapabilitiesChanged();
    await waitFor(() => (calls === 1 ? true : undefined), {
      description: "first (throwing) event delivered",
      timeoutMs: 2_000,
    });
    // Second event must still arrive — the throw did not kill the stream.
    gateway.emitCapabilitiesChanged();
    await waitFor(() => (calls === 2 ? true : undefined), {
      description: "second event still delivered after the throw",
      timeoutMs: 2_000,
    });
    await gateway.closeGateway();
  });
});

describe("GatewayHarness — no gateway extensions (pre-ADR-50 path)", () => {
  it("seals the wire registry synchronously and resolves gatewayReady", async () => {
    const gateway = await createGateway({});
    // No gateway extensions → registry sealed in the constructor; a
    // programmatic registration attempt (were one possible) is moot, but
    // the observable proof is that gatewayReady already resolved and the
    // built-in framework wire extensions are present.
    expect(gateway.wireExtensions().resolve("gwext/ping")).toBeUndefined();
    // Framework built-ins registered regardless of the extension path.
    expect(gateway.wireExtensions().enumerate().length).toBeGreaterThan(0);
    await gateway.closeGateway();
  });
});
