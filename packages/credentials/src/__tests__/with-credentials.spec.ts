/**
 * `withCredentials` unit test — pins the extension's contract against
 * a stub `AppInstaller`.
 *
 * Why not a full app integration test: the cross-session-sharing
 * behavior we'd want to verify is a property of `AppHarness`'s
 * `extensionBridges` map (covered by @agentick/app's own test suite),
 * NOT of `withCredentials` itself. The extension's job is exactly
 * three things — construct a harness from the substrate, register
 * it under `"credentials"`, schedule `harness.close()` on host close.
 * That's what this spec verifies.
 *
 * Pulling in `@agentick/app` + react + `@agentick/*-executor` as dev
 * deps just to walk through `createApp` would couple the test to
 * the React compiler (the only fleshed-out one today) and would
 * actually be exercising AppHarness, not withCredentials.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";
import type { AppInstaller } from "@agentick/spec";

import { CredentialsHarness, inMemoryCredentialsStore, withCredentials } from "../index.js";

// TODO(adr-93): six packages now hand-roll an installer stub
// (credentials/resources/prompts/skills×3). They should share ONE
// `stubAppInstaller` / `stubSessionInstaller` double typed against the spec
// interfaces — see the test-doubles convention — so a spec change breaks them at
// compile time in one place instead of drifting silently behind `as` casts. Home:
// `@agentick/spec-conformance` (substrate passed in, so it needs no runtime dep).
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
    // ADR 93 landmine 11 — a real host hands its resolved cascade here; this
    // stub contributes none, which is what an isolated extension test wants.
    interceptors: {},
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
    expect(await store.get<{ access_token: string }>("mcp", "srv-a", stubStoreCtx())).toEqual({
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
