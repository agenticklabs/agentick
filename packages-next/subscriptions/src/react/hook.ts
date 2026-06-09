/**
 * `useSubscriptionBridge()` — escape hatch to the bridge from inside
 * components. Most adopters use `<Cron>` / `<Webhook>` /
 * `<EventListener>`; this hook is for advanced custom subscription
 * shapes the standard components don't cover.
 */

import { useBridges } from "@agentick/reconciler-react-next";

import type { SubscriptionBridge } from "../bridge.js";

export function useSubscriptionBridge(): SubscriptionBridge | undefined {
  return useBridges().subscriptions;
}
