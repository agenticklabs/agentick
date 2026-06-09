/**
 * `@agentick/subscriptions-next/react` — React bindings for the
 * subscription bridge.
 *
 * Importing from here brings the `HookBridges.subscriptions`
 * augmentation in. Adopters who only need the bridge (e.g., from
 * inside a driver) import from `@agentick/subscriptions-next` directly.
 */

import "../augment.js";

export {
  Cron,
  Webhook,
  EventListener,
  type CronProps,
  type WebhookProps,
  type EventListenerProps,
} from "./components.js";

export { useSubscriptionBridge } from "./hook.js";

// Re-export from /v2 root for ergonomic single-import adoption.
export { withSubscriptions } from "../extension.js";
export type { WithSubscriptionsOptions } from "../extension.js";
export {
  createSubscriptionBridge,
  type SubscriptionBridge,
  type SubscriptionCtx,
  type SubscriptionHandler,
} from "../bridge.js";
