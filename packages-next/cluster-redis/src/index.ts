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
