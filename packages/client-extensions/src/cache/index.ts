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
// Re-exported, not owned: the store moved to `@agentick/utils` when a second
// consumer appeared, and a copy is how two subsystems come to disagree about
// eviction. Kept on this subpath so an adopter already importing it here is
// undisturbed.
export { LruCacheStore, type CacheStore, type CacheEntry } from "@agentick/utils";
