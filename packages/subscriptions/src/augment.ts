/**
 * Module augmentation — `HookBridges.subscriptions` +
 * `EventScopeExtensions.subscriptionId`.
 *
 * Side-effect-only file. Anything that imports from
 * `@agentick/subscriptions` (or `/react`) brings this augmentation in
 * and `useBridges().subscriptions` is typed correctly.
 *
 * The top-level `import type` below is what makes this file a MODULE — a
 * `declare module` file with no top-level import/export is a script that
 * SHADOWS the target module instead of augmenting it. Keep at least one
 * top-level import or export here.
 */

import type { SubscriptionBridge } from "./bridge.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly subscriptions?: SubscriptionBridge;
  }

  interface EventScopeExtensions {
    /**
     * Subscription identifier — the per-intent routing dimension for the
     * subscription surface (ADR 92 Family 1 §2). Stamped on every
     * `subscriptions:command:dispatch` envelope so an observer filters one
     * intent's fires out of the stream:
     *
     *     app.events({ scope: { subscriptionId: "nightly-report" } })
     *
     * The id is the adopter-chosen `SubscriptionIntent.id` (`<Cron id="…">`),
     * unique within one bridge — it is the same key `bridge.dispatch(id, …)`
     * routes on, so an audit record joins straight back to the declaration.
     *
     * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
     * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
     */
    readonly subscriptionId?: string;
  }
}
