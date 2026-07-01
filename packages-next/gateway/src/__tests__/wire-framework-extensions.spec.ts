/**
 * Framework wire extensions (#295 Phase C) — verifies that every
 * GatewayHarness ships with `gatewayWireExtension`, `appWireExtension`,
 * and `sessionWireExtension` pre-registered, and that adopter attempts
 * to claim those namespaces fail at construction (framework registers
 * FIRST so its namespaces are already taken when adopter registration
 * fires).
 *
 * See ADR 46 §"The framework's own wire methods ARE wire extensions".
 */

import { describe, expect, it } from "vitest";
import { defineWireExtension, WireExtensionDefinitionError } from "@agentick/spec-next";

import { GatewayHarness } from "../harness.js";
import { appWireExtension, gatewayWireExtension, sessionWireExtension } from "../wire/index.js";

describe("GatewayHarness — framework wire extensions", () => {
  it("registers gatewayWireExtension, appWireExtension, sessionWireExtension by default", async () => {
    const gw = new GatewayHarness();
    await gw.ready;

    const registry = gw.wireExtensions();
    const entries = registry.enumerate();

    const names = entries.map((e) => e.name);
    expect(names).toContain("@agentick/gateway-next#gateway");
    expect(names).toContain("@agentick/gateway-next#app");
    expect(names).toContain("@agentick/gateway-next#session");

    // Every framework method resolves.
    expect(registry.resolve("gateway/listApps")?.extension).toBe(gatewayWireExtension);
    expect(registry.resolve("gateway/getApp")?.extension).toBe(gatewayWireExtension);
    expect(registry.resolve("app/createSession")?.extension).toBe(appWireExtension);
    expect(registry.resolve("app/getSession")?.extension).toBe(appWireExtension);
    expect(registry.resolve("app/listSessions")?.extension).toBe(appWireExtension);
    expect(registry.resolve("session/dispatch")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/abort")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/close")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/respondToElicitation")?.extension).toBe(sessionWireExtension);

    await gw.closeGateway();
  });

  it("rejects adopter attempts to claim the `gateway` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-gateway",
      namespace: "gateway",
      methods: {
        "gateway/listApps": async () => ({ apps: [] }),
      },
    });
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      WireExtensionDefinitionError,
    );
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      /namespace "gateway" already registered by extension "@agentick\/gateway-next#gateway"/,
    );
  });

  it("rejects adopter attempts to claim the `app` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-app",
      namespace: "app",
      methods: {
        "app/listSessions": async () => ({ sessions: [] }),
      },
    });
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      /namespace "app" already registered/,
    );
  });

  it("rejects adopter attempts to claim the `session` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-session",
      namespace: "session",
      methods: {
        "session/dispatch": async () => ({ content: [] }),
      },
    });
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      /namespace "session" already registered/,
    );
  });

  it("accepts adopter extensions on non-framework namespaces", async () => {
    const adopterExt = defineWireExtension({
      name: "@adopter/crm",
      namespace: "crm",
      methods: {
        // Fake method — WireMethods is declaration-merged for this test only.
        "crm/listContacts": async () => ({ contacts: [] }),
      },
    });
    const gw = new GatewayHarness({ wireExtensions: [adopterExt] });
    await gw.ready;

    const registry = gw.wireExtensions();
    expect(registry.resolve("crm/listContacts")?.extension).toBe(adopterExt);

    // Framework extensions still register.
    expect(registry.resolve("gateway/listApps")).toBeDefined();

    // Enumerate lists framework FIRST, adopter AFTER.
    const names = registry.enumerate().map((e) => e.name);
    expect(names.indexOf("@agentick/gateway-next#gateway")).toBeLessThan(
      names.indexOf("@adopter/crm"),
    );

    await gw.closeGateway();
  });
});

// Synthetic type for the adopter-namespace test.
declare module "@agentick/spec-next" {
  interface WireMethods {
    "crm/listContacts": { params: object; result: { contacts: readonly string[] } };
  }
}
