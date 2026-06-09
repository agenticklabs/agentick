/**
 * `@agentick/subscriptions-next` — long-lived subscription primitive.
 *
 * The agnostic surface (bridge, types, augmentation, extension factory,
 * default scheduler driver). React JSX components live at
 * `@agentick/subscriptions-next/react`.
 *
 * Subscriptions are the foundation for any external trigger that
 * should wake up a session — cron, webhook, event listener, and
 * eventually connectors (Slack, Telegram, etc.).
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import "./augment.js";

export {
  createSubscriptionBridge,
  type SubscriptionBridge,
  type SubscriptionCtx,
  type SubscriptionHandler,
  type CreateSubscriptionBridgeOptions,
} from "./bridge.js";

export { attachInProcessScheduler } from "./scheduler.js";

export { withSubscriptions, type WithSubscriptionsOptions } from "./extension.js";
