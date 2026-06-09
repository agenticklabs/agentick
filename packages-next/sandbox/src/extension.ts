/**
 * `withSandbox()` — `AppExtension` factory for the sandbox surface.
 *
 * Constructs a `SandboxBridge` wired to the AppHarness's shared
 * substrate at install time. The bridge's `createHarness(input)`
 * method closes over that substrate — React components that mount
 * `<Sandbox>` call into the bridge to materialize harnesses, and
 * those harnesses publish events into the app's bus + journal.
 *
 * This is the critical architectural point: the bridge is constructed
 * during `install()` (when substrate is reachable) and lives for the
 * lifetime of the app. Whether the `<Sandbox>` JSX is mounted or not
 * is irrelevant — the bridge is ready and usable.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md §Extension
 */

import type { AppExtension, AppInstaller } from "@agentick/spec-next";

import { createSandboxBridge, type SandboxBridge } from "./bridge.js";

export interface WithSandboxOptions {
  /**
   * Run at extension install time, with the bridge already
   * registered. Useful for pre-spinning sandboxes at app-init that
   * don't need to be driven by JSX `<Sandbox>` components.
   */
  readonly initialize?: (bridge: SandboxBridge, installer: AppInstaller) => void | Promise<void>;
}

export function withSandbox(options: WithSandboxOptions = {}): AppExtension {
  return {
    name: "@agentick/sandbox",
    target: "app",
    async install(installer) {
      const bridge = createSandboxBridge({ substrate: installer.substrate });
      installer.registerNamespace("sandbox", bridge);
      if (options.initialize) {
        await options.initialize(bridge, installer);
      }
    },
  };
}

// Adopters who want a custom bridge implementation write their own
// AppExtension that calls installer.registerNamespace("sandbox", customBridge)
// — same surface, same result, no `bridgeFactory` option needed.
