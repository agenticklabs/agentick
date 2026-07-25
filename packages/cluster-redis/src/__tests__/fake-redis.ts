/**
 * In-memory Redis-like client for unit testing. Implements just
 * enough of the `RedisLikeClient` shape (pub/sub + SET ops) to
 * exercise `createRedisTransport` + `createRedisMembership` without
 * a real Redis instance.
 *
 * NOT a Redis emulator — semantics are simplified. Notably:
 *   - TTL respects time only on EXISTS check (key tracks
 *     expiresAt; not a real timer).
 *   - Pub/sub is process-local — all FakeRedisClient instances
 *     created from the same `createFakeRedis()` factory share the
 *     same hub.
 *
 * Use cases:
 *   - Unit tests of transport/membership logic.
 *   - Integration tests in CI without docker-compose.
 *
 * For real Redis verification — Phase 4g.5 wires a docker-compose
 * Redis service into the conformance suite.
 */

import type { RedisLikeClient } from "../redis-client-shape.js";

interface Subscription {
  readonly channel: string;
  readonly handler: (channel: Buffer, message: Buffer) => void;
}

export interface FakeRedisHub {
  readonly clients: Set<FakeRedisClient>;
  readonly subscriptions: Map<FakeRedisClient, Set<string>>;
  readonly kvStore: Map<string, { value: string; expiresAt?: number }>;
  readonly setStore: Map<string, Set<string>>;
}

export interface FakeRedisClient extends RedisLikeClient {
  readonly _hub: FakeRedisHub;
  readonly _subs: Subscription[];
}

export function createFakeRedis(): { newClient(): FakeRedisClient } {
  const hub: FakeRedisHub = {
    clients: new Set(),
    subscriptions: new Map(),
    kvStore: new Map(),
    setStore: new Map(),
  };

  function newClient(): FakeRedisClient {
    const subs: Subscription[] = [];

    const client: FakeRedisClient = {
      _hub: hub,
      _subs: subs,
      status: "ready",

      async publish(channel, message) {
        const bytes = typeof message === "string" ? Buffer.from(message) : Buffer.from(message);
        let count = 0;
        for (const c of hub.clients) {
          for (const s of c._subs) {
            if (s.channel === channel) {
              count += 1;
              // Match real ioredis — fires `messageBuffer` per subscriber.
              queueMicrotask(() => s.handler(Buffer.from(channel), bytes));
            }
          }
        }
        return count;
      },

      async subscribe(...channels) {
        const set = hub.subscriptions.get(client) ?? new Set<string>();
        for (const ch of channels) set.add(ch);
        hub.subscriptions.set(client, set);
        return set.size;
      },

      async unsubscribe(...channels) {
        const set = hub.subscriptions.get(client);
        if (!set) return 0;
        for (const ch of channels) {
          set.delete(ch);
          // Drop matching subscription handlers too.
          for (let i = subs.length - 1; i >= 0; i--) {
            if (subs[i]!.channel === ch) subs.splice(i, 1);
          }
        }
        return set.size;
      },

      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "messageBuffer") {
          // Register handler for every currently-subscribed channel
          // plus any future subscriptions on this client.
          const handler = listener as (channel: Buffer, message: Buffer) => void;
          // We approximate ioredis: store handlers + match by channel
          // at publish time. Since `subscribe` is called before any
          // publish, we add the handler entry per subscribed channel.
          const channels = hub.subscriptions.get(client);
          if (channels) {
            for (const ch of channels) subs.push({ channel: ch, handler });
          }
          // Also intercept future subscribes:
          const origSubscribe = client.subscribe;
          client.subscribe = async (...chs: string[]) => {
            for (const ch of chs) subs.push({ channel: ch, handler });
            return origSubscribe(...chs);
          };
        }
        // Other events (error) — no-op in the fake.
        return client;
      },

      off() {
        return client;
      },

      async sadd(key, ...members) {
        const set = hub.setStore.get(key) ?? new Set<string>();
        let added = 0;
        for (const m of members) {
          if (!set.has(m)) {
            set.add(m);
            added += 1;
          }
        }
        hub.setStore.set(key, set);
        return added;
      },

      async srem(key, ...members) {
        const set = hub.setStore.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const m of members) {
          if (set.delete(m)) removed += 1;
        }
        return removed;
      },

      async smembers(key) {
        const set = hub.setStore.get(key);
        return set ? [...set] : [];
      },

      async set(key, value, _mode, seconds) {
        hub.kvStore.set(key, {
          value,
          expiresAt: Date.now() + seconds * 1000,
        });
        return "OK";
      },

      async expire(key, seconds) {
        const entry = hub.kvStore.get(key);
        if (!entry) return 0;
        entry.expiresAt = Date.now() + seconds * 1000;
        return 1;
      },

      async del(...keys) {
        let count = 0;
        for (const k of keys) {
          if (hub.kvStore.delete(k)) count += 1;
          if (hub.setStore.delete(k)) count += 1;
        }
        return count;
      },

      async exists(...keys) {
        let count = 0;
        for (const k of keys) {
          const entry = hub.kvStore.get(k);
          if (entry && (entry.expiresAt === undefined || entry.expiresAt > Date.now())) {
            count += 1;
          } else if (entry) {
            // Expired — delete on access.
            hub.kvStore.delete(k);
          }
        }
        return count;
      },

      async quit() {
        hub.clients.delete(client);
        hub.subscriptions.delete(client);
        subs.length = 0;
        return "OK";
      },
    } as FakeRedisClient;

    hub.clients.add(client);
    hub.subscriptions.set(client, new Set());
    return client;
  }

  return { newClient };
}
