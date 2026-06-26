/**
 * `@agentick/cluster-redis-next` — Redis cluster transport for Agentick
 * v2. The production multi-host story.
 *
 * Adopters reach for Redis (or Valkey / KeyDB / Dragonfly — all
 * RESP-protocol-compatible, the same `ioredis` client works against all)
 * for clustering instead of running our own broker process. We get
 * battle-tested HA (Sentinel / Cluster), monitoring, ops familiarity,
 * and zero new deploy units to manage.
 *
 * Three concrete seams provided:
 *
 *   - `redisTransport(opts)`   — {@link ClusterTransport} via Redis pub/sub
 *   - `redisMembership(opts)`  — {@link ClusterMembership} via SET + TTL heartbeats
 *   - `redisClusterNode(opts)` — multiplexed `{transport, membership}` factory
 *   - `defineRedisCluster(opts)` — top-level convenience wrapping `defineCluster`
 *
 * Symmetric — every node speaks the same protocol; no broker/client
 * role distinction. Redis IS the broker.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §10 (Phase 4f)
 */

// Public API surface — implementations land in Phase 4f.2 / 4f.3 / 4f.4.
// Stub re-exports for now so the package shape is wired and typedoc /
// vitepress can index it.
export const __PHASE_4F_PENDING__ = true as const;
