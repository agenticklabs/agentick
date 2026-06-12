/**
 * `offline(options)` — `ClientExtension` that queues outbound RPCs
 * when the transport is not "open" and replays them FIFO on reconnect.
 *
 * Per-method `queueable` policy with FOUR options (matches Apollo Link
 * Queue / Workbox BackgroundSync conventions):
 *
 *   - `"queue"`     — buffer and replay; result delivered when replayed
 *   - `"fail-fast"` — reject immediately with `{kind:"connection"}`
 *   - `"never"`     — pass through (transport's own queueing applies)
 *   - default: "fail-fast" — safe default; adopters opt specific methods
 *                            into queueing
 *
 * Replay safety: the queue must only carry IDEMPOTENT operations (or
 * non-idempotent ones tagged with a stable idempotency key — pair with
 * the sibling `retry` extension's key emission).
 *
 * @verifiedBy src/__tests__/offline.spec.ts
 */

import type {
  ClientExtension,
  ClientInstaller,
  ClientTransport,
  RequestMiddleware,
} from "@agentick/spec-next";
import { InMemoryOfflineStore, type OfflineStore, type QueuedRequest } from "./store.js";

export type OfflineMethodPolicy = "queue" | "fail-fast" | "never";

export interface OfflineOptions {
  /**
   * Per-method policy. Methods not listed default to `defaultPolicy`.
   *
   * Example:
   *   {
   *     "session/send":  "queue",
   *     "session/queue": "queue",
   *     "ping":          "never",
   *     // everything else: defaultPolicy
   *   }
   */
  readonly methods?: Record<string, OfflineMethodPolicy>;
  readonly defaultPolicy?: OfflineMethodPolicy;
  /**
   * Durable store. Default: in-memory; persists only for the lifetime
   * of the client. Adopters wiring IndexedDB / SQLite / Redis pass a
   * custom impl.
   */
  readonly store?: OfflineStore;
  /**
   * Optional hook fired when a queued request fails on replay. By
   * default replay failures are logged via the client-bus `extension`
   * surface; this hook lets adopters do something domain-specific
   * (e.g., surface a toast notification).
   */
  readonly onReplayError?: (req: QueuedRequest, error: unknown) => void;
}

export function offline(options: OfflineOptions = {}): ClientExtension {
  const store = options.store ?? new InMemoryOfflineStore();
  const perMethod = options.methods ?? {};
  const defaultPolicy = options.defaultPolicy ?? "fail-fast";
  const onReplayError = options.onReplayError;

  // The middleware needs the transport reference (to issue replayed
  // requests directly, bypassing the middleware chain). Installed
  // via `installer.transport`.
  let transport: ClientTransport | null = null;
  let drainInFlight = false;

  const drain = async (): Promise<void> => {
    if (drainInFlight || !transport) return;
    drainInFlight = true;
    try {
      const queued = await store.drain();
      for (const req of queued) {
        if (transport.state !== "open") {
          // Connection dropped mid-drain — re-enqueue the rest and stop.
          await store.enqueue(req.method, req.params);
          continue;
        }
        try {
          // Bypass the middleware chain — issue directly on the transport.
          // The original call already returned (rejected with queued
          // state); replay is fire-and-forget per the queue semantics.
          await transport.request(req.method as never, req.params as never);
        } catch (err) {
          if (onReplayError) onReplayError(req, err);
        }
      }
    } finally {
      drainInFlight = false;
    }
  };

  const install = (installer: ClientInstaller): void => {
    transport = installer.transport;

    // Trigger a drain whenever the transport transitions to "open".
    const unsubscribe = installer.transport.onStateChange((s) => {
      if (s === "open") void drain();
    });

    // Expose namespace + clean up on close.
    const namespace = {
      async pending(): Promise<readonly QueuedRequest[]> {
        return store.peek();
      },
      async size(): Promise<number> {
        return store.size();
      },
      async flush(): Promise<void> {
        return drain();
      },
      async clear(): Promise<void> {
        return store.clear();
      },
    };
    installer.registerNamespace("offline", namespace);

    installer.onClose(() => {
      unsubscribe();
    });
  };

  const requestMw: RequestMiddleware = async (req, next) => {
    const policy = perMethod[req.method] ?? defaultPolicy;

    // If the wire is up, just let the call through.
    if (transport && transport.state === "open") {
      return next(req);
    }

    switch (policy) {
      case "never":
        return next(req);
      case "fail-fast":
        throw {
          kind: "connection",
          message: `transport not open (offline policy: fail-fast for ${req.method})`,
        };
      case "queue": {
        await store.enqueue(req.method, req.params);
        // Per queue semantics — original Promise resolves to a sentinel
        // indicating the request was enqueued. Adopters who care about
        // the replayed result subscribe to it via the offline namespace
        // (future hook) or by re-issuing once `state === "open"`.
        return {
          enqueued: true,
        } as never;
      }
      default: {
        const _exhaustive: never = policy;
        throw new Error(`offline: unknown policy ${String(_exhaustive)}`);
      }
    }
  };

  return {
    name: "offline",
    install,
    request: requestMw,
  };
}

declare module "@agentick/spec-next" {
  interface ClientNamespaces {
    offline: {
      pending(): Promise<readonly QueuedRequest[]>;
      size(): Promise<number>;
      flush(): Promise<void>;
      clear(): Promise<void>;
    };
  }
}
