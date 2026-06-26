/**
 * `ClusterMembership` impl backed by Redis SET + per-node TTL keys.
 *
 * Layout (with optional `keyPrefix`):
 *
 *   - `{prefix}members` (SET) — every nodeId that's claimed
 *     membership. Joiners SADD; leavers SREM.
 *   - `{prefix}member:<nodeId>:alive` (key with TTL) — heartbeat
 *     liveness probe. Joiner SETs with `EX heartbeatTtlSec`; renews
 *     every `heartbeatIntervalMs`. Reader filters SMEMBERS by
 *     which `:alive` keys still EXIST.
 *
 * Failure detection latency: a node that crashes (no graceful
 * SREM) stays in the SET until its `:alive` key TTLs out. Dead-node
 * removal latency = `heartbeatTtlSec` (default 30s). Tune via
 * `heartbeatTtlSec` + `heartbeatIntervalMs`.
 *
 * Membership-change detection: polls `live members` every
 * `pollIntervalMs` (default 5s) and diffs against the prior
 * snapshot. New nodes → `joined`; missing nodes → `lost`. The
 * first poll emits `snapshot` carrying the full current set.
 *
 * No Redis pub/sub for membership deltas — polling is simpler,
 * cheaper at the scales Agentick targets (<100 nodes), and
 * survives transient pub/sub disconnects more gracefully.
 */

import type { ClusterMembership, MembershipChange, NodeId } from "@agentick/cluster-next";

import type { RedisLikeClient } from "./redis-client-shape.js";

export interface RedisMembershipOptions {
  readonly nodeId: NodeId;
  /** Already-constructed ioredis client (regular, non-pub/sub). */
  readonly client: RedisLikeClient;
  readonly keyPrefix?: string;
  /**
   * Liveness key TTL (seconds). Dead nodes age out this long after
   * their last heartbeat. Default: 30.
   */
  readonly heartbeatTtlSec?: number;
  /**
   * Heartbeat renewal interval (ms). MUST be < `heartbeatTtlSec *
   * 1000` to avoid spurious dropouts. Default: 10000 (10s).
   */
  readonly heartbeatIntervalMs?: number;
  /**
   * Member-change poll interval (ms). Lower = faster delta detection
   * + more Redis load. Default: 5000 (5s).
   */
  readonly pollIntervalMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function createRedisMembership(opts: RedisMembershipOptions): ClusterMembership {
  const prefix = opts.keyPrefix ?? "agentick:";
  const membersKey = `${prefix}members`;
  const aliveKey = (nodeId: NodeId): string => `${prefix}member:${nodeId}:alive`;
  const myAliveKey = aliveKey(opts.nodeId);

  const ttlSec = opts.heartbeatTtlSec ?? 30;
  const intervalMs = opts.heartbeatIntervalMs ?? 10_000;
  const pollMs = opts.pollIntervalMs ?? 5000;

  const handlers = new Set<(change: MembershipChange) => void>();
  let lastSnapshot: ReadonlySet<NodeId> = new Set();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let started = false;

  async function joinAndStart(): Promise<void> {
    if (started || closed) return;
    started = true;
    try {
      await opts.client.sadd(membersKey, opts.nodeId);
      await opts.client.set(myAliveKey, "1", "EX", ttlSec);
    } catch (cause) {
      opts.onDiagnostic?.("cluster:redis:membership:join-failed", {
        nodeId: opts.nodeId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    // Heartbeat loop — renew the TTL.
    heartbeatTimer = setInterval(() => {
      void renewHeartbeat();
    }, intervalMs);
    // Member-change poll loop.
    pollTimer = setInterval(() => {
      void pollMembers();
    }, pollMs);
    // Initial poll (fires `snapshot`).
    await pollMembers();
  }

  async function renewHeartbeat(): Promise<void> {
    if (closed) return;
    try {
      await opts.client.expire(myAliveKey, ttlSec);
    } catch (cause) {
      opts.onDiagnostic?.("cluster:redis:membership:heartbeat-failed", {
        nodeId: opts.nodeId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function pollMembers(): Promise<void> {
    if (closed) return;
    let allMembers: string[];
    try {
      allMembers = await opts.client.smembers(membersKey);
    } catch (cause) {
      opts.onDiagnostic?.("cluster:redis:membership:poll-failed", {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (allMembers.length === 0) {
      // No registered members at all (Redis flushed or fresh cluster).
      // The snapshot will be empty for an instant before our own
      // join's SADD completes; safe to skip the diff.
      return;
    }
    // Check liveness of each in parallel via pipeline. We could SCAN
    // for surviving keys instead, but EXISTS is more direct.
    const aliveChecks = await Promise.all(
      allMembers.map(async (nodeId) => {
        try {
          const ex = await opts.client.exists(aliveKey(nodeId));
          return ex > 0 ? nodeId : null;
        } catch {
          return null;
        }
      }),
    );
    const live = new Set<NodeId>(aliveChecks.filter((n): n is string => n !== null));
    // Lazily clean up the SET for nodes that have aged out — keeps
    // the membership set small over time. Best-effort; failures are
    // logged but not fatal.
    const stale = allMembers.filter((n) => !live.has(n));
    if (stale.length > 0) {
      try {
        await opts.client.srem(membersKey, ...stale);
      } catch {
        // ignore
      }
    }
    // Compute deltas vs last snapshot.
    const at = new Date().toISOString();
    if (lastSnapshot.size === 0) {
      // First poll — emit `snapshot` carrying current set.
      emit({ kind: "snapshot", nodes: [...live], at });
    } else {
      for (const n of live) {
        if (!lastSnapshot.has(n)) emit({ kind: "joined", node: n, at });
      }
      for (const n of lastSnapshot) {
        if (!live.has(n)) emit({ kind: "lost", node: n, at, reason: "timeout" });
      }
    }
    lastSnapshot = live;
  }

  function emit(change: MembershipChange): void {
    for (const h of handlers) {
      try {
        h(change);
      } catch (cause) {
        opts.onDiagnostic?.("cluster:redis:membership:handler-threw", {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  // Kick off join + polling on construction. Errors surface via
  // onDiagnostic; transport keeps trying.
  void joinAndStart();

  return {
    currentNode: opts.nodeId,
    async nodes() {
      // Trigger a fresh poll if we haven't snapshot yet, otherwise
      // return cached live set.
      if (lastSnapshot.size === 0 && started && !closed) {
        await pollMembers();
      }
      return [...lastSnapshot];
    },
    onChange(handler) {
      handlers.add(handler);
      // Replay current snapshot to new subscriber.
      if (lastSnapshot.size > 0) {
        try {
          handler({
            kind: "snapshot",
            nodes: [...lastSnapshot],
            at: new Date().toISOString(),
          });
        } catch {
          // ignore
        }
      }
      return async () => {
        handlers.delete(handler);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (pollTimer) clearInterval(pollTimer);
      handlers.clear();
      // Graceful leave: remove from SET + drop alive key.
      try {
        await opts.client.srem(membersKey, opts.nodeId);
        await opts.client.del(myAliveKey);
      } catch (cause) {
        opts.onDiagnostic?.("cluster:redis:membership:leave-failed", {
          nodeId: opts.nodeId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  };
}
