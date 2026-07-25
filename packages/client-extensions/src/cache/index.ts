/**
 * `@agentick/client-extensions/cache` — read-through cache
 * extension for `@agentick/client-core`.
 *
 * Method-explicit-allowlist by default — most agentick methods are
 * stateful (sessions, executions) and MUST NOT be cached. Adopters opt
 * specific read-shaped methods (`gateway/list_apps`, `app/get_session`)
 * into the cache with per-method TTL.
 *
 * Same family as React Query / TanStack Query / SWR / Apollo Client
 * normalized cache (read-through with TTL + invalidation).
 */

export { cache, type CacheOptions, type CacheMethodPolicy } from "./cache.js";
export { LruCacheStore, type CacheStore, type CacheEntry } from "./lru.js";
