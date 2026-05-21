/**
 * Subscription JSX components.
 *
 * Each component is a thin wrapper that:
 *   1. Pulls `bridges.subscriptions` from `useBridges()`.
 *   2. Calls `bridge.declare(intent, handler)` on mount.
 *   3. Returns the unsubscribe handle via `useOnUnmount`.
 *
 * The bridge owns intent storage. The snapshot picks intents up via
 * `bridge.exportSnapshot()`. Hibernate-resume restores intents via
 * `importSnapshot`; the JSX rerenders, components re-declare with
 * freshly-bound handlers, pending intents are promoted to live.
 *
 * Components render nothing visible — they're declarative side-effects
 * over the bridge surface.
 */

import * as React from "react";
import { useBridges, useOnUnmount } from "@agentick/reconciler-react";
import type { SubscriptionIntent } from "@agentick/spec";

import "../augment.js";
import type { SubscriptionBridge, SubscriptionCtx, SubscriptionHandler } from "../bridge.js";

// ============================================================================
// Helpers
// ============================================================================

function useSubscriptionBridge(): SubscriptionBridge {
  const bridges = useBridges();
  const sub = bridges.subscriptions;
  if (!sub) {
    throw new Error(
      "Subscription components require the subscriptions extension. " +
        "Add `withSubscriptions()` to `AppHarnessOptions.extensions`.",
    );
  }
  return sub;
}

/**
 * Declare an intent + handler with the bridge on mount; unsubscribe
 * on unmount. The handler always reads the latest props via a ref so
 * re-renders pick up new closures without re-declaration thrash.
 */
function useDeclareSubscription(intent: SubscriptionIntent, handler: SubscriptionHandler): void {
  const bridge = useSubscriptionBridge();
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  // Stable wrapper so re-renders don't cause re-declaration.
  const stableHandler = React.useCallback<SubscriptionHandler>(
    (event, ctx) => handlerRef.current(event, ctx),
    [],
  );

  // Re-declare when the intent identity / config changes. The handler
  // is stable (wrapped via ref); intent prop changes flow through
  // because the `intent` object reference is new on each render that
  // changes id / kind / config (see useMemo in the components).
  React.useEffect(() => {
    const unsub = bridge.declare(intent, stableHandler);
    return unsub;
  }, [bridge, intent, stableHandler]);

  useOnUnmount(() => {
    /* declare's unsubscribe already runs via effect cleanup */
  });
}

// ============================================================================
// <Cron>
// ============================================================================

export interface CronProps {
  /** Stable subscription id within the session. */
  readonly id: string;
  /**
   * Cron expression — 5-field (`min hour dom month dow`) or one of
   * the standard macros (`@hourly`, `@daily`, `@weekly`, `@monthly`,
   * `@yearly`).
   */
  readonly expr: string;
  readonly onTick: (event: { firedAt: number }, ctx: SubscriptionCtx) => void | Promise<void>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function Cron(props: CronProps): null {
  const intent: SubscriptionIntent = React.useMemo(
    () => ({
      id: props.id,
      kind: "cron",
      config: {
        expr: props.expr,
        ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
      },
    }),
    [props.id, props.expr, props.metadata],
  );
  useDeclareSubscription(intent, props.onTick as SubscriptionHandler);
  return null;
}

// ============================================================================
// <Webhook>
// ============================================================================

export interface WebhookProps {
  readonly id: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Fires when an external HTTP driver dispatches a request matching
   * this intent. The adopter wires HTTP routes (Express, Hono, Next.js
   * — whatever) to `bridge.dispatch(id, request)`.
   */
  readonly onRequest: (event: unknown, ctx: SubscriptionCtx) => void | Promise<void>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function Webhook(props: WebhookProps): null {
  const intent: SubscriptionIntent = React.useMemo(
    () => ({
      id: props.id,
      kind: "webhook",
      config: {
        path: props.path,
        ...(props.method !== undefined ? { method: props.method } : {}),
        ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
      },
    }),
    [props.id, props.path, props.method, props.metadata],
  );
  useDeclareSubscription(intent, props.onRequest as SubscriptionHandler);
  return null;
}

// ============================================================================
// <EventListener>
// ============================================================================

export interface EventListenerProps {
  readonly id: string;
  /** Bus channel id, queue name, or other driver-specific selector. */
  readonly channel: string;
  readonly onEvent: (event: unknown, ctx: SubscriptionCtx) => void | Promise<void>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function EventListener(props: EventListenerProps): null {
  const intent: SubscriptionIntent = React.useMemo(
    () => ({
      id: props.id,
      kind: "event-listener",
      config: {
        channel: props.channel,
        ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
      },
    }),
    [props.id, props.channel, props.metadata],
  );
  useDeclareSubscription(intent, props.onEvent as SubscriptionHandler);
  return null;
}
