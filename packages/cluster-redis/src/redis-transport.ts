/**
 * `ClusterTransport` impl backed by Redis pub/sub.
 *
 * Channel layout (with optional `keyPrefix`):
 *
 *   - `{prefix}bus` — broadcast channel; every node SUBSCRIBES if it
 *     has any bus subscriptions. Filter matching is client-side.
 *   - `{prefix}inbox:<nodeId>` — per-node inbox; only the owning
 *     node SUBSCRIBES. Senders PUBLISH directly to the target
 *     node's channel.
 *
 * Two ioredis connections per node:
 *   - The PUB connection (regular commands; PUBLISH + non-pub/sub).
 *   - The SUB connection (in subscriber mode; most commands blocked
 *     until UNSUBSCRIBE).
 *
 * Bytes-on-wire: codec.encode produces Uint8Array. ioredis binary
 * mode (return-buffers) preserves bytes through PUBLISH/MESSAGE.
 * Round-trip is opaque — Redis is just the dumb pipe.
 *
 * No server-side filtering. Redis pub/sub topics are flat strings.
 * We use ONE shared bus channel + per-node inbox channels;
 * subscription filters apply client-side via `matchesEventFilter` /
 * `matchesAddressFilter` from `@agentick/utils`. Tradeoff:
 * publishers send to all nodes that have ANY bus subscription;
 * non-matching subscribers drop the frame after decode. Cheap at
 * normal subscription density.
 *
 * Phase 4g.1 — transport only. Membership lands in 4g.2; factories
 * in 4g.3.
 */

import type {
  AddressFilter,
  ClusterCodec,
  ClusterTransport,
  EventFilter,
  NodeId,
} from "@agentick/cluster";
import type { EventEnvelope, MessageEnvelope } from "@agentick/spec";
import { matchesAddressFilter, matchesEventFilter } from "@agentick/utils";

import type { RedisLikeClient } from "./redis-client-shape.js";

export interface RedisTransportOptions {
  /** Current node identity — used to derive per-node inbox channel. */
  readonly nodeId: NodeId;
  /** Already-constructed ioredis publish client. */
  readonly pubClient: RedisLikeClient;
  /** Already-constructed ioredis subscribe client. */
  readonly subClient: RedisLikeClient;
  /** Wire codec — used to encode/decode envelope bytes on both directions. */
  readonly codec: ClusterCodec;
  /**
   * Prefix for all Redis keys + channels (e.g., "agentick:prod:").
   * Allows multiple Agentick clusters to share one Redis instance
   * without colliding. Default: `"agentick:"`.
   */
  readonly keyPrefix?: string;
  /** Diagnostic emitter. */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

interface InboxSub {
  readonly filter: AddressFilter;
  readonly onMessage: (env: MessageEnvelope) => void;
}

interface BusSub {
  readonly filter: EventFilter;
  readonly onEvent: (env: EventEnvelope) => void;
}

export function createRedisTransport(opts: RedisTransportOptions): ClusterTransport {
  const prefix = opts.keyPrefix ?? "agentick:";
  const busChannel = `${prefix}bus`;
  const inboxChannel = (nodeId: NodeId): string => `${prefix}inbox:${nodeId}`;
  const myInbox = inboxChannel(opts.nodeId);

  const inboxSubs = new Set<InboxSub>();
  const busSubs = new Set<BusSub>();
  let subscribedToBus = false;
  let subscribedToInbox = false;
  let closed = false;

  // Pending subscribe ops for flush(). The protocol contract: flush()
  // resolves after every in-flight SUBSCRIBE has been acknowledged.
  const pendingSubscribes = new Set<Promise<unknown>>();

  // Single inbound dispatcher — `messageBuffer` event fires for every
  // channel we've subscribed to. We route by channel name.
  const messageHandler = (channelBuf: Buffer, payloadBuf: Buffer): void => {
    if (closed) return;
    const channel = channelBuf.toString();
    let env: MessageEnvelope | EventEnvelope;
    try {
      env = opts.codec.decode(payloadBuf);
    } catch (cause) {
      opts.onDiagnostic?.("cluster:redis:decode-failed", {
        channel,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (channel === myInbox) {
      // Inbox delivery — envelope is a MessageEnvelope.
      const msg = env as MessageEnvelope;
      for (const sub of inboxSubs) {
        try {
          if (matchesAddressFilter(sub.filter, msg.addressedTo)) {
            sub.onMessage(msg);
          }
        } catch (cause) {
          opts.onDiagnostic?.("cluster:redis:inbox-handler-threw", {
            address: msg.addressedTo,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return;
    }
    if (channel === busChannel) {
      const evt = env as EventEnvelope;
      for (const sub of busSubs) {
        try {
          if (matchesEventFilter(sub.filter, evt)) {
            sub.onEvent(evt);
          }
        } catch (cause) {
          opts.onDiagnostic?.("cluster:redis:bus-handler-threw", {
            eventName: evt.name,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    // Unknown channel — ignore. Shouldn't happen unless adopter
    // PUBLISHes directly into our prefix namespace.
  };

  opts.subClient.on("messageBuffer", messageHandler);
  opts.subClient.on("error", (err) => {
    opts.onDiagnostic?.("cluster:redis:sub-error", {
      reason: err instanceof Error ? err.message : String(err),
    });
  });
  opts.pubClient.on("error", (err) => {
    opts.onDiagnostic?.("cluster:redis:pub-error", {
      reason: err instanceof Error ? err.message : String(err),
    });
  });

  function ensureBusSubscribed(): void {
    if (subscribedToBus || closed) return;
    subscribedToBus = true;
    const p = opts.subClient.subscribe(busChannel).catch((err) => {
      subscribedToBus = false;
      opts.onDiagnostic?.("cluster:redis:subscribe-failed", {
        channel: busChannel,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
    pendingSubscribes.add(p);
    void p.finally(() => pendingSubscribes.delete(p));
  }

  function ensureInboxSubscribed(): void {
    if (subscribedToInbox || closed) return;
    subscribedToInbox = true;
    const p = opts.subClient.subscribe(myInbox).catch((err) => {
      subscribedToInbox = false;
      opts.onDiagnostic?.("cluster:redis:subscribe-failed", {
        channel: myInbox,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
    pendingSubscribes.add(p);
    void p.finally(() => pendingSubscribes.delete(p));
  }

  return {
    async send(toNode, env) {
      if (closed) throw new Error("cluster-redis: send on closed transport");
      const bytes = opts.codec.encode(env);
      try {
        await opts.pubClient.publish(inboxChannel(toNode), Buffer.from(bytes));
      } catch (cause) {
        opts.onDiagnostic?.("cluster:redis:publish-failed", {
          channel: inboxChannel(toNode),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },

    async broadcast(env) {
      if (closed) throw new Error("cluster-redis: broadcast on closed transport");
      const bytes = opts.codec.encode(env);
      try {
        await opts.pubClient.publish(busChannel, Buffer.from(bytes));
      } catch (cause) {
        opts.onDiagnostic?.("cluster:redis:publish-failed", {
          channel: busChannel,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },

    subscribeInbox(filter, onMessage) {
      if (closed) {
        return async () => {};
      }
      const sub: InboxSub = { filter, onMessage };
      inboxSubs.add(sub);
      ensureInboxSubscribed();
      return async () => {
        inboxSubs.delete(sub);
        // We don't UNSUBSCRIBE from Redis when local subs drain —
        // re-subscribing on next add() is more expensive than
        // continued subscription. If the node has no more inbox
        // subs, transport.close() will UNSUBSCRIBE.
      };
    },

    subscribeBus(filter, onEvent) {
      if (closed) {
        return async () => {};
      }
      const sub: BusSub = { filter, onEvent };
      busSubs.add(sub);
      ensureBusSubscribed();
      return async () => {
        busSubs.delete(sub);
      };
    },

    async flush() {
      // Wait for any in-flight SUBSCRIBE to ack.
      if (pendingSubscribes.size === 0) return;
      await Promise.all([...pendingSubscribes]);
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        if (subscribedToInbox) await opts.subClient.unsubscribe(myInbox);
        if (subscribedToBus) await opts.subClient.unsubscribe(busChannel);
      } catch {
        // Best-effort.
      }
      inboxSubs.clear();
      busSubs.clear();
      opts.subClient.off("messageBuffer", messageHandler as (...args: unknown[]) => void);
      // Quit BOTH clients. Cooperative close; ioredis flushes pending
      // commands before disconnect.
      try {
        await Promise.all([opts.pubClient.quit(), opts.subClient.quit()]);
      } catch {
        // Best-effort during shutdown.
      }
    },
  };
}
