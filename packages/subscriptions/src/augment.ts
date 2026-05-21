/**
 * Module augmentation — `HookBridges.subscriptions`.
 *
 * Side-effect-only file. Anything that imports from
 * `@agentick/subscriptions` (or `/react`) brings this augmentation in
 * and `useBridges().subscriptions` is typed correctly.
 */

import type { SubscriptionBridge } from "./bridge.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly subscriptions?: SubscriptionBridge;
  }
}
