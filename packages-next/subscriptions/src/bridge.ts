/**
 * `SubscriptionBridge` — registry of long-lived subscription intents.
 *
 * Components in the JSX tree (`<Cron>`, `<Webhook>`, `<EventListener>`)
 * declare an intent + handler at mount; external drivers (the
 * scheduler for cron, an HTTP server for webhooks, a bus subscriber
 * for event listeners) call `dispatch(id, event)` when their trigger
 * fires. The bridge invokes the handler with a `SubscriptionCtx`
 * carrying an AbortSignal that re-declarations cancel.
 *
 * Snapshot/restore: intents are JSON-serializable; handlers are not.
 * On restore, the bridge re-imports the intent list as "pending"
 * (no handler yet) and components re-declare with freshly-bound
 * handlers on the next render — pending intents get promoted to
 * live.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import type { SubscriptionIntent, Unsubscribe } from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";

// ============================================================================
// Surface
// ============================================================================

export interface SubscriptionCtx {
  readonly id: string;
  /**
   * Session id when the subscription is declared inside a session's
   * JSX tree. `"app"` when declared at the app level (extensions).
   */
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /**
   * Free-form metadata propagated by the driver — tenant id for
   * connector subscriptions, source-protocol for cross-protocol
   * routers, etc.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type SubscriptionHandler = (event: unknown, ctx: SubscriptionCtx) => void | Promise<void>;

export interface SubscriptionBridge {
  declare(intent: SubscriptionIntent, handler: SubscriptionHandler): Unsubscribe;
  /** All currently-declared intents. Drivers read this. */
  list(): readonly SubscriptionIntent[];
  /** Fire the handler bound to `id`. Driver-side. */
  dispatch(
    id: string,
    event: unknown,
    options?: { readonly metadata?: Readonly<Record<string, unknown>> },
  ): Promise<void>;
  subscribe(listener: () => void): Unsubscribe;
  exportSnapshot(): readonly SubscriptionIntent[];
  importSnapshot(intents: readonly SubscriptionIntent[]): void;
}

// ============================================================================
// In-memory implementation
// ============================================================================

interface LiveEntry {
  readonly intent: SubscriptionIntent;
  readonly handler: SubscriptionHandler;
  readonly controller: AbortController;
}

export interface CreateSubscriptionBridgeOptions {
  /** Session id stamped onto the ctx — defaults to "app". */
  readonly sessionId?: string;
}

export function createSubscriptionBridge(
  options: CreateSubscriptionBridgeOptions = {},
): SubscriptionBridge {
  const live = new Map<string, LiveEntry>();
  const pending = new Map<string, SubscriptionIntent>();
  const listeners = createNotifier();
  const sessionId = options.sessionId ?? "app";

  const notify = (): void => listeners.notify();

  return {
    declare(intent, handler): Unsubscribe {
      // Re-declaration aborts any prior controller.
      const prior = live.get(intent.id);
      if (prior) prior.controller.abort();
      pending.delete(intent.id);
      const controller = new AbortController();
      const entry: LiveEntry = { intent, handler, controller };
      live.set(intent.id, entry);
      notify();
      return () => {
        const current = live.get(intent.id);
        if (current && current.handler === handler) {
          current.controller.abort();
          live.delete(intent.id);
          notify();
        }
      };
    },
    list(): readonly SubscriptionIntent[] {
      const out: SubscriptionIntent[] = [];
      for (const e of live.values()) out.push(e.intent);
      for (const i of pending.values()) out.push(i);
      return out;
    },
    async dispatch(id, event, opts): Promise<void> {
      const entry = live.get(id);
      if (!entry) {
        throw new Error(`SubscriptionBridge: no handler declared for id=${id}`);
      }
      const ctx: SubscriptionCtx = {
        id,
        sessionId,
        signal: entry.controller.signal,
        metadata: opts?.metadata ?? {},
      };
      await entry.handler(event, ctx);
    },
    subscribe(listener): Unsubscribe {
      return listeners.subscribe(listener);
    },
    exportSnapshot(): readonly SubscriptionIntent[] {
      const seen = new Set<string>();
      const out: SubscriptionIntent[] = [];
      for (const e of live.values()) {
        if (!seen.has(e.intent.id)) {
          seen.add(e.intent.id);
          out.push(e.intent);
        }
      }
      for (const i of pending.values()) {
        if (!seen.has(i.id)) {
          seen.add(i.id);
          out.push(i);
        }
      }
      return out;
    },
    importSnapshot(intents): void {
      pending.clear();
      for (const intent of intents) {
        if (live.has(intent.id)) continue;
        pending.set(intent.id, intent);
      }
      notify();
    },
  };
}
