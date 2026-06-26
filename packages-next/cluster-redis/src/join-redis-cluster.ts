/**
 * High-level ergonomic facade for joining a Redis cluster.
 *
 * Brokerless: Redis IS the broker. Every node is symmetric — no
 * bind race, no role election, no broker process to start. Every
 * node is always `role: "client"` from {@link ClusterNode}'s
 * perspective; `localBrokerRunning()` always returns `false`.
 *
 * The wire-agnostic facade plumbing (bus,
 * membership.waitForPeers, lifecycle) lives in
 * `@agentick/cluster-next`'s {@link makeClusterNode} — this module
 * just wires the Redis-specific factory pair into it.
 *
 * Adopters supply pre-constructed ioredis clients (`pubClient` +
 * `subClient`). They own the client lifecycle; we own the
 * transport/membership lifecycle wrapped around them. We do NOT
 * call `client.quit()` in `node.close()` — adopters who want the
 * Redis connections torn down at the same time should do that in
 * their own teardown.
 *
 * @see ./redis-cluster.ts (raw factories)
 * @see @agentick/cluster-next `makeClusterNode` (the shared facade builder)
 */

import { makeClusterNode, type ClusterNode } from "@agentick/cluster-next";

import { redisClusterNode, type RedisClusterNodeOptions } from "./redis-cluster.js";

export interface JoinRedisClusterOptions extends RedisClusterNodeOptions {
  /**
   * Single diagnostic sink. Receives every diagnostic emitted by
   * the transport + membership layers. The `layer` tag is always
   * `"client"` for Redis (no broker process here).
   */
  readonly onDiagnostic?: (name: string, payload?: unknown, layer?: "broker" | "client") => void;
}

/**
 * Join a Redis cluster. Returns a {@link ClusterNode} with name-based
 * `bus.subscribe` / `bus.broadcast` and `membership.waitForPeers(n)`.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * const pub = new Redis(url);
 * const sub = new Redis(url);
 * await using node = await joinRedisCluster({
 *   nodeId: process.env.NODE_ID!,
 *   pubClient: pub,
 *   subClient: sub,
 * });
 * node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
 * await node.membership.waitForPeers(2);
 * await node.bus.broadcast("hello");
 * // Adopter still calls pub.quit() / sub.quit() in their teardown.
 * ```
 */
export async function joinRedisCluster(opts: JoinRedisClusterOptions): Promise<ClusterNode> {
  const { onDiagnostic, ...rest } = opts;

  // The Redis tier never starts a broker — fold the layer arg
  // away here for the underlying factory which only takes the
  // 2-arg shape.
  const innerOnDiag = onDiagnostic
    ? (name: string, payload?: unknown): void => onDiagnostic(name, payload, "client")
    : undefined;

  const factories = redisClusterNode({
    ...rest,
    ...(innerOnDiag !== undefined ? { onDiagnostic: innerOnDiag } : {}),
  });

  return makeClusterNode({
    nodeId: opts.nodeId,
    role: "client",
    transportFactory: factories.transport,
    membershipFactory: factories.membership,
    // No cleanup needed — adopter owns the Redis client lifecycle.
    // The transport/membership factories register their close()
    // handlers via parent.onClose, which makeClusterNode runs as
    // part of its standard teardown.
    localBrokerRunning: () => false,
  });
}
