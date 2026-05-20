/**
 * `withSandbox()` — `AppExtension` factory for the sandbox surface.
 *
 * Registers an in-memory `SandboxBridge` with the AppHarness's
 * installer. The `<Sandbox provider={...}>` JSX component (in
 * `@agentick/sandbox/v2/react`) populates the bridge at mount time by
 * constructing a `SandboxHarness` per `<Sandbox>` instance and
 * registering it.
 *
 * Adopters who want pre-configured sandboxes at app-init (not driven
 * by JSX) can use `withSandbox({ initialize })` to spin them up in
 * the `install()` hook.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §AppExtension
 */

import type { AppExtension, AppInstaller } from "@agentick/spec";

import { inMemorySandboxBridge, type SandboxBridge } from "./bridge.js";

export interface WithSandboxOptions {
  /**
   * Provide a pre-built bridge instance. Default: a fresh
   * `inMemorySandboxBridge()`. Override when you want to share a
   * bridge across multiple apps (rare) or implement a custom
   * registry shape.
   */
  readonly bridge?: SandboxBridge;
  /**
   * Run at extension install time, with the bridge already
   * registered. Useful for pre-spinning sandboxes at app-init that
   * don't need to be driven by JSX `<Sandbox>` components.
   */
  readonly initialize?: (bridge: SandboxBridge, installer: AppInstaller) => void | Promise<void>;
}

export function withSandbox(options: WithSandboxOptions = {}): AppExtension {
  const bridge = options.bridge ?? inMemorySandboxBridge();
  return {
    name: "@agentick/sandbox",
    async install(installer) {
      installer.registerBridge("sandbox", bridge);
      if (options.initialize) {
        await options.initialize(bridge, installer);
      }
    },
  };
}
