# `@agentick/client-extensions/cache`

Read-through cache extension for `@agentick/client-core`.
**Method-explicit-allowlist by default** — most agentick methods are
stateful (sessions, executions); adopters opt specific read-shaped
methods into the cache with per-method TTL.

Subpath of [`@agentick/client-extensions`](../../README.md) — the
first-party client-extension bundle. Adopters import individual
behaviors via their subpath for tree-shaking + dependency isolation.

## Prior art

| Library                        | What it does                                 | Where we match it                                                        |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| React Query / TanStack Query   | Keyed cache with TTL + GC                    | TTL per method; LRU eviction                                             |
| SWR                            | Stale-while-revalidate, focus revalidate     | Roadmap (see below) — not in MVP                                         |
| Apollo Client normalized cache | Cache-and-network, event-driven invalidation | LRU + adopter-supplied event-driven invalidation via `store.delete(key)` |
| HTTP caching (RFC 7234)        | `Cache-Control: max-age`                     | Per-method `ttlMs`                                                       |
| LRU-cache (npm)                | LRU container with eviction                  | `LruCacheStore` impl                                                     |

## Why an explicit allowlist (default = nothing cached)

Most agentick methods mutate state or return per-call-distinct results:

- `session/send` — runs an execution; result is unique per call
- `session/dispatch` — invokes a tool; side effects matter
- `app/create_session` — creates state
- `session/snapshot` — returns current state (changes constantly)

Caching these silently would corrupt adopter applications. The cache
is opt-in per method so adopters think about each one explicitly:

```ts
import { cache } from "@agentick/client-extensions/cache";

cache({
  methods: {
    "gateway/list_apps": { ttlMs: 60_000 }, // 1 minute
    "gateway/get_app": { ttlMs: 30_000 },
    "app/list_sessions": { ttlMs: 5_000 }, // 5 seconds (sessions churn)
  },
});
```

## Quick start

```ts
import { createClient } from "@agentick/client-core";
import { cache } from "@agentick/client-extensions/cache";

const client = await createClient({
  transport: ...,
  extensions: [
    cache({
      methods: {
        "gateway/list_apps": { ttlMs: 60_000 },
      },
    }),
  ],
});

await client.gateway().listApps();  // hits network
await client.gateway().listApps();  // returns from cache
```

## API

```ts
cache({
  methods: {
    [methodName: string]: {
      ttlMs: number;              // required
      key?: (params) => string;   // optional custom key derivation
    },
  },
  store?: CacheStore;             // default: LruCacheStore(1000)
});
```

### Custom store

For Redis-backed or other durable / cross-process caches, implement
the `CacheStore` interface:

```ts
import type { CacheStore, CacheEntry } from "@agentick/client-extensions/cache";

class RedisCacheStore implements CacheStore {
  get(key: string): CacheEntry | undefined { ... }
  set(key: string, entry: CacheEntry): void { ... }
  delete(key: string): void { ... }
  clear(): void { ... }
  size(): number { ... }
}
```

### Key derivation

Default key: `${method}:${JSON.stringify(params_without_meta)}`. The
`_meta` field is stripped before keying so trace context / progress
tokens / idempotency keys don't fragment the cache.

Custom `key: (params) => string` for non-deterministic param ordering
or domain-specific keys.

### Invalidation

Cache invalidation is adopter-driven via direct store mutation +
client-bus event subscription. Example:

```ts
const store = new LruCacheStore(1000);
const client = await createClient({
  ...
  extensions: [
    cache({ methods: { "gateway/list_apps": { ttlMs: 60_000 } }, store }),
    {
      name: "invalidate-on-app-created",
      install(installer) {
        // ADR 33 client-bus: subscribe to 'gateway:app-created' from server
        // and invalidate gateway/list_apps cache entries.
        installer.bus.subscribe(/* surface: "wire", filter for app-created */);
        // ... call store.delete("gateway/list_apps:...") on event ...
      },
    },
  ],
});
```

A built-in `invalidateOnEvent({ event, methods })` helper is on the
roadmap.

## Status

Phase 33.F of the v2 implementation plan.

## Verified by

| Concern                                      | Test                          |
| -------------------------------------------- | ----------------------------- |
| Method allowlist — only listed methods cache | `src/__tests__/cache.spec.ts` |
| TTL — expired entries refetch                | `src/__tests__/cache.spec.ts` |
| Keys differentiate by params                 | `src/__tests__/cache.spec.ts` |
| `_meta` stripped before keying               | `src/__tests__/cache.spec.ts` |
| LRU eviction on capacity                     | `src/__tests__/cache.spec.ts` |
| Custom key fn override                       | `src/__tests__/cache.spec.ts` |
| Adopter-supplied store used end-to-end       | `src/__tests__/cache.spec.ts` |

## Roadmap & known gaps

- **`invalidateOnEvent({ event, methods })` helper** — adopters
  currently wire bus → cache invalidation by hand. The pattern is
  small enough to ship as a helper.
- **Stale-while-revalidate** — return cached + fire background
  refresh. Complicates the response contract (caller sees stale
  result; refresh may fail silently). Worth shipping behind a
  per-method `staleWhileRevalidateMs?: number` flag once a real
  use case surfaces.
- **Background refresh / prefetch** — TanStack-Query-style "warm the
  cache before it expires." Deferred.
- **Cache stats namespace** — `client.cache.stats()` exposing hit/miss
  rate, eviction count. Worth a `client.cache` namespace via
  `installer.registerNamespace` once observability is wired through
  client-bus.
- **Negative caching** — caching errors (e.g., `AppNotFound` for 30s
  to avoid re-querying). Not implemented; pattern is "cache the result
  type, including errors" but it's tricky to get right.
