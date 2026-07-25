/**
 * `@agentick/cluster-redis` — Redis cluster transport for Agentick
 * v2. The production multi-host story.
 *
 * Adopters reach for Redis (or Valkey / KeyDB / Dragonfly — all
 * RESP-protocol-compatible, the same `ioredis` client works against all)
 * for clustering instead of running our own broker process. We get
 * battle-tested HA (Sentinel / Cluster), monitoring, ops familiarity,
 * and zero new deploy units to manage.
 *
 * Symmetric — every node speaks the same protocol; no broker/client
 * role distinction. Redis IS the broker.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §10
 */

export { createRedisTransport, type RedisTransportOptions } from "./redis-transport.js";
export { createRedisMembership, type RedisMembershipOptions } from "./redis-membership.js";
export {
  defineRedisCluster,
  redisClusterNode,
  redisMembership,
  redisTransport,
  type DefineRedisClusterOptions,
  type RedisClusterNode,
  type RedisClusterNodeOptions,
} from "./redis-cluster.js";

// High-level ergonomic facade. Wire-agnostic plumbing (bus,
// membership.waitForPeers, lifecycle) lives in
// `@agentick/cluster` as `makeClusterNode`; this is the
// Redis-specific compose-and-go entry point. Brokerless tier —
// every node is `role: "client"`.
export { joinRedisCluster, type JoinRedisClusterOptions } from "./join-redis-cluster.js";

// Re-export wire-agnostic facade types from cluster-next so adopters
// don't need to reach across two packages just to type a returned
// `ClusterNode`.
export type { BusFacade, ClusterNode, MembershipFacade } from "@agentick/cluster";
