/**
 * `withSubscriptions()` — install the SubscriptionBridge into an
 * AppHarness.
 *
 * The bridge is constructed at install time, registered on every
 * session's HookBridges, and lives for the app's lifetime. Whether
 * any `<Cron>`/`<Webhook>`/`<EventListener>` JSX is mounted is
 * irrelevant — the bridge is ready and usable.
 *
 * Drivers (the scheduler for cron, an HTTP server for webhooks, an
 * event-bus subscriber) consume `bridge.list()` and call
 * `bridge.dispatch(id, event)` when their trigger fires. The default
 * in-process scheduler ships in `./scheduler.ts` and is opt-in via
 * `withSubscriptions({ scheduler: true })`.
 */

import type { AppExtension, AppInstaller } from "@agentick/spec";

import { createSubscriptionBridge, type SubscriptionBridge } from "./bridge.js";
import { attachInProcessScheduler } from "./scheduler.js";

export interface WithSubscriptionsOptions {
  /**
   * Attach the default in-process cron scheduler driver. Default:
   * `true`. Set `false` if you supply your own scheduler driver out
   * of band (k8s CronJobs, an external scheduler service, etc.).
   */
  readonly scheduler?: boolean;
  /**
   * Run at extension install time, with the bridge already
   * registered. Useful for pre-declaring intents (e.g., feeding a
   * persisted intent list from a previous session).
   */
  readonly initialize?: (
    bridge: SubscriptionBridge,
    installer: AppInstaller,
  ) => void | Promise<void>;
}

export function withSubscriptions(options: WithSubscriptionsOptions = {}): AppExtension {
  return {
    name: "@agentick/subscriptions",
    target: "app",
    async install(installer) {
      const bridge = createSubscriptionBridge();
      installer.registerNamespace("subscriptions", bridge);

      if (options.scheduler !== false) {
        const detach = attachInProcessScheduler(bridge);
        // Detach the scheduler when the app closes so timers don't
        // outlive the harness (per ADR 26 — installer.onClose replaces
        // the AppExtension.uninstall lifecycle).
        installer.onClose(() => detach());
      }

      if (options.initialize) {
        await options.initialize(bridge, installer);
      }
    },
  };
}
