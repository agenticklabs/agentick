/**
 * In-memory reference implementation of `SubscriptionBridge`.
 *
 * Tracks long-lived subscription intents declared by framework
 * components (`<Cron>` / `<Webhook>` / `<EventListener>`). External
 * drivers (a scheduler for cron, an HTTP server for webhooks, a bus
 * subscription for event listeners) call `dispatch(id, event)` to
 * fire the bound handler with a fresh {@link SubscriptionCtx}.
 *
 * Intents survive snapshot/restore; handlers do not. On restore, the
 * component re-declares with the same intent + a freshly-bound
 * handler from the post-restore render tree.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §SubscriptionBridge
 */

import type {
  SubscriptionBridge,
  SubscriptionCtx,
  SubscriptionHandler,
  SubscriptionIntent,
  Unsubscribe,
} from "@agentick/spec";

interface Entry {
  readonly intent: SubscriptionIntent;
  readonly handler: SubscriptionHandler;
  readonly controller: AbortController;
}

export interface InMemorySubscriptionBridgeOptions {
  /**
   * Provide the current session id when dispatching. Defaults to
   * `"s_unknown"` — the bridge cannot infer it from the substrate.
   */
  readonly sessionId?: () => string;
}

export function inMemorySubscriptionBridge(
  options: InMemorySubscriptionBridgeOptions = {},
): SubscriptionBridge {
  const entries = new Map<string, Entry>();
  // Snapshot-only intents (no handler yet — restored from a prior
  // snapshot, waiting for a component to re-declare).
  const pendingIntents = new Map<string, SubscriptionIntent>();
  const listeners = new Set<() => void>();
  const sessionIdFn = options.sessionId ?? (() => "s_unknown");

  const notify = (): void => {
    listeners.forEach((l) => l());
  };

  return {
    declare(intent, handler): Unsubscribe {
      const existing = entries.get(intent.id);
      if (existing) existing.controller.abort();
      pendingIntents.delete(intent.id);
      const controller = new AbortController();
      entries.set(intent.id, { intent, handler, controller });
      notify();
      return () => {
        const current = entries.get(intent.id);
        if (current && current.handler === handler) {
          current.controller.abort();
          entries.delete(intent.id);
          notify();
        }
      };
    },
    list(): readonly SubscriptionIntent[] {
      const out: SubscriptionIntent[] = [];
      for (const e of entries.values()) out.push(e.intent);
      for (const i of pendingIntents.values()) out.push(i);
      return out;
    },
    async dispatch(id, event): Promise<void> {
      const entry = entries.get(id);
      if (!entry) {
        throw new Error(
          `SubscriptionBridge: no handler declared for id=${id}`,
        );
      }
      const ctx: SubscriptionCtx = {
        id,
        sessionId: sessionIdFn(),
        signal: entry.controller.signal,
      };
      await entry.handler(event, ctx);
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    exportSnapshot(): readonly SubscriptionIntent[] {
      // Live intents take precedence over pending; we ship a single
      // de-duplicated list so importSnapshot is idempotent.
      const seen = new Set<string>();
      const out: SubscriptionIntent[] = [];
      for (const e of entries.values()) {
        if (!seen.has(e.intent.id)) {
          seen.add(e.intent.id);
          out.push(e.intent);
        }
      }
      for (const i of pendingIntents.values()) {
        if (!seen.has(i.id)) {
          seen.add(i.id);
          out.push(i);
        }
      }
      return out;
    },
    importSnapshot(intents): void {
      pendingIntents.clear();
      for (const intent of intents) {
        // If a component already re-declared with a handler, skip —
        // the live entry wins.
        if (entries.has(intent.id)) continue;
        pendingIntents.set(intent.id, intent);
      }
      notify();
    },
  };
}
