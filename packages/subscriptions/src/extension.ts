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
 *
 * Every fire runs as an OPERATION (ADR 92 Family 1 §2): the extension
 * constructs a {@link SubscriptionsHarness} against the installer substrate
 * and injects its `runDispatch` into the bridge, so a cron tick or a webhook
 * POST goes through `subscriptions:command:dispatch` — guardable, hookable,
 * and journaled — instead of landing as a bare callback.
 */

import type { AppExtension, AppInstaller } from "@agentick/spec";

import { createSubscriptionBridge, type SubscriptionBridge } from "./bridge.js";
import { SubscriptionsHarness } from "./harness.js";
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
      // Construction order is forced: the harness's registry lookup reads the
      // bridge, and the bridge's dispatch runner reads the harness. The lookup
      // is a CLOSURE (evaluated per fire, long after install), so a `let` seam
      // resolves the cycle without a mutable field on either object.
      //
      // TODO(adr-92): thread `inheritedInterceptors` + `interceptorParent` from
      // the host AppHarness so an app-scope `app.guard()` / `app.use()` wraps
      // subscription fires (ADR 83 §4 live inheritance). Blocked on
      // `AppInstaller` exposing the host harness — no `AppExtension` in the
      // tree can do this today, so this is a cross-package gap, not a local
      // omission. Until then, register on `bridge.harness` directly.
      let bridge: SubscriptionBridge | undefined;
      const harness = new SubscriptionsHarness(
        installer.hostId,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        { resolveInvoker: (id) => bridge?.invoker(id) },
      );
      await harness.ready;
      installer.onClose(() => harness.close());

      bridge = createSubscriptionBridge({ runDispatch: harness.runDispatch, harness });
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
