/**
 * `withCredentials` unit test — pins the extension's contract against
 * a stub `AppInstaller`.
 *
 * Why not a full app integration test: the cross-session-sharing
 * behavior we'd want to verify is a property of `AppHarness`'s
 * `extensionBridges` map (covered by app-next's own test suite),
 * NOT of `withCredentials` itself. The extension's job is exactly
 * three things — construct a harness from the substrate, register
 * it under `"credentials"`, schedule `harness.close()` on host close.
 * That's what this spec verifies.
 *
 * Pulling in `@agentick/app-next` + react + executor-next as dev
 * deps just to walk through `createApp` would couple the test to
 * the React reconciler (the only fleshed-out one today) and would
 * actually be exercising AppHarness, not withCredentials.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { AppInstaller } from "@agentick/spec-next";

import { CredentialsHarness, inMemoryCredentialsStore, withCredentials } from "../index.js";

function stubAppInstaller(hostId = "app-test"): {
  readonly installer: AppInstaller;
  readonly bridges: Map<string, unknown>;
  readonly closeHandlers: Array<() => void | Promise<void>>;
} {
  const bridges = new Map<string, unknown>();
  const closeHandlers: Array<() => void | Promise<void>> = [];
  const installer: AppInstaller = {
    kind: "app",
    hostId,
    substrate: {
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    },
    registerNamespace: (name, harness) => {
      bridges.set(name, harness);
      return () => {
        bridges.delete(name);
      };
    },
    getNamespace: <T>(name: string): T | undefined => bridges.get(name) as T | undefined,
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
    registerContributor: () => () => {},
    registerToolHandler: () => () => {},
    registerExtensionTool: () => () => {},
    subscribeBus: () => () => {},
    app: {
      appId: hostId,
      metadata: {},
      getSession: () => undefined,
    },
  };
  return { installer, bridges, closeHandlers };
}

describe("withCredentials", () => {
  it("is an AppExtension with the canonical name + target", () => {
    const ext = withCredentials({ store: inMemoryCredentialsStore() });
    expect(ext.target).toBe("app");
    expect(ext.name).toBe("@agentick/credentials");
  });

  it("registers a CredentialsHarness under the 'credentials' slot", async () => {
    const ext = withCredentials({ store: inMemoryCredentialsStore() });
    const { installer, bridges } = stubAppInstaller();

    await ext.install(installer);

    const harness = bridges.get("credentials");
    expect(harness).toBeInstanceOf(CredentialsHarness);
  });

  it("scopes the harness id under the host id", async () => {
    const ext = withCredentials({ store: inMemoryCredentialsStore() });
    const { installer, bridges } = stubAppInstaller("my-app");

    await ext.install(installer);

    const harness = bridges.get("credentials") as CredentialsHarness;
    expect(harness.id).toBe("my-app:credentials");
    expect(harness.address).toBe("credentials:my-app:credentials");
  });

  it("wires the harness over the supplied store", async () => {
    const store = inMemoryCredentialsStore();
    const ext = withCredentials({ store });
    const { installer, bridges } = stubAppInstaller();

    await ext.install(installer);

    const harness = bridges.get("credentials") as CredentialsHarness;
    await harness.set("mcp", "srv-a", { access_token: "via-harness" });

    // Round-trip through the underlying store proves the harness is
    // wired to the adopter-supplied adapter (not to some internal one).
    expect(await store.get<{ access_token: string }>("mcp", "srv-a")).toEqual({
      access_token: "via-harness",
    });
  });

  it("schedules harness.close() on host shutdown", async () => {
    const ext = withCredentials({ store: inMemoryCredentialsStore() });
    const { installer, bridges, closeHandlers } = stubAppInstaller();

    await ext.install(installer);

    const harness = bridges.get("credentials") as CredentialsHarness;
    const closeSpy = vi.spyOn(harness, "close");

    expect(closeHandlers).toHaveLength(1);
    await Promise.all(closeHandlers.map((h) => h()));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
