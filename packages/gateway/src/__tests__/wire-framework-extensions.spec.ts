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
import { defineWireExtension, WireExtensionDefinitionError } from "@agentick/spec";

import { GatewayHarness } from "../harness.js";
import {
  appWireExtension,
  gatewayWireExtension,
  sessionWireExtension,
  subscriptionsWireExtension,
} from "../wire/index.js";

describe("GatewayHarness — framework wire extensions", () => {
  it("registers gateway/app/session/subscriptions extensions by default", async () => {
    const gw = new GatewayHarness();
    await gw.ready;

    const registry = gw.wireExtensions();
    const entries = registry.enumerate();

    const names = entries.map((e) => e.name);
    expect(names).toContain("@agentick/gateway#gateway");
    expect(names).toContain("@agentick/gateway#app");
    expect(names).toContain("@agentick/gateway#session");
    expect(names).toContain("@agentick/gateway#subscriptions");

    // Every framework method resolves.
    expect(registry.resolve("gateway/list_apps")?.extension).toBe(gatewayWireExtension);
    expect(registry.resolve("gateway/get_app")?.extension).toBe(gatewayWireExtension);
    expect(registry.resolve("gateway/destroy_session")?.extension).toBe(gatewayWireExtension);
    expect(registry.resolve("app/create_session")?.extension).toBe(appWireExtension);
    expect(registry.resolve("app/get_session")?.extension).toBe(appWireExtension);
    expect(registry.resolve("app/list_sessions")?.extension).toBe(appWireExtension);
    expect(registry.resolve("app/destroy_session")?.extension).toBe(appWireExtension);
    // No per-method journal override on either destroy verb: both ride the
    // DEFAULT disposition and land in the journal as real commands.
    expect(appWireExtension.journal?.["app/destroy_session"]).toBeUndefined();
    expect(gatewayWireExtension.journal?.["gateway/destroy_session"]).toBeUndefined();
    // session extension covers non-streaming AND streaming methods post-#303.
    expect(registry.resolve("session/send")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/dispatch")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/abort")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/close")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/respond_to_elicitation")?.extension).toBe(
      sessionWireExtension,
    );
    // Client-tool wire verbs (stage 2) — session-namespace, so they ride the
    // gateway's session extension alongside respond_to_elicitation.
    expect(registry.resolve("session/set_client_tools")?.extension).toBe(sessionWireExtension);
    expect(registry.resolve("session/respond_to_tool_call")?.extension).toBe(sessionWireExtension);
    // sub/* namespace (renamed from bare subscribe/unsubscribe per #300).
    expect(registry.resolve("sub/subscribe")?.extension).toBe(subscriptionsWireExtension);
    expect(registry.resolve("sub/unsubscribe")?.extension).toBe(subscriptionsWireExtension);

    await gw.close();
  });

  it("registers built-in harness wire-extensions (knobs/set, tasks/cancel) by default", async () => {
    // `knobs/set` and `tasks/cancel` ride `builtinWireExtensions` (owned by
    // `@agentick/app`, which depends on the built-in harness packages),
    // registered in the gateway's bundled tier. Asserted by namespace/name so
    // this test needs no knobs/tasks dep.
    const gw = new GatewayHarness();
    await gw.ready;

    const knobs = gw.wireExtensions().resolve("knobs/set");
    expect(knobs).toBeDefined();
    expect(knobs?.extension.namespace).toBe("knobs");
    expect(knobs?.extension.name).toBe("@agentick/knobs#wire");

    const tasks = gw.wireExtensions().resolve("tasks/cancel");
    expect(tasks).toBeDefined();
    expect(tasks?.extension.namespace).toBe("tasks");
    expect(tasks?.extension.name).toBe("@agentick/tasks#wire");

    await gw.close();
  });

  it("rejects adopter attempts to claim the `gateway` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-gateway",
      namespace: "gateway",
      methods: {
        "gateway/list_apps": async () => ({ apps: [] }),
      },
    });
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      WireExtensionDefinitionError,
    );
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      /namespace "gateway" already registered by extension "@agentick\/gateway#gateway"/,
    );
  });

  it("rejects adopter attempts to claim the `app` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-app",
      namespace: "app",
      methods: {
        "app/list_sessions": async () => ({ sessions: [] }),
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

  it("rejects adopter attempts to claim the `sub` namespace", () => {
    const collision = defineWireExtension({
      name: "@adopter/rogue-sub",
      namespace: "sub",
      methods: {
        "sub/subscribe": async () => ({ subscriptionId: "x" }),
      },
    });
    expect(() => new GatewayHarness({ wireExtensions: [collision] })).toThrow(
      /namespace "sub" already registered/,
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
    expect(registry.resolve("gateway/list_apps")).toBeDefined();

    // Enumerate lists framework FIRST, adopter AFTER.
    const names = registry.enumerate().map((e) => e.name);
    expect(names.indexOf("@agentick/gateway#gateway")).toBeLessThan(names.indexOf("@adopter/crm"));

    await gw.close();
  });
});

// Synthetic type for the adopter-namespace test.
declare module "@agentick/spec" {
  interface WireMethods {
    "crm/listContacts": { params: object; result: { contacts: readonly string[] } };
  }
}
