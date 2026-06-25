/**
 * `LocalClusterRegistry` — shared in-memory routing state used by
 * the `localClusterTransport` and `localClusterMembership`
 * fixtures. Tests instantiate ONE registry and pass it to multiple
 * fake-node transports / memberships; the registry is the
 * cross-node "wire" they all talk to.
 *
 * Pure in-process. Routes synchronously via microtask scheduling
 * so observers in tests see deterministic ordering without real
 * I/O delays. NOT for production use — adapters like
 * `@agentick/cluster-ipc-next` do real IPC instead.
 *
 * @see local-cluster-transport.ts, local-cluster-membership.ts
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";

import type { AddressFilter, EventFilter, MembershipChange, NodeId } from "../types.js";

/**
 * Per-node entry in the registry. Holds the node's inbox + bus
 * subscriptions — each subscription pairs a filter with a callback
 * the registry invokes during routing.
 */
interface NodeEntry {
  readonly inboxSubs: Set<InboxSub>;
  readonly busSubs: Set<BusSub>;
  readonly membershipSubs: Set<(change: MembershipChange) => void>;
}

interface InboxSub {
  readonly filter: AddressFilter;
  readonly onMessage: (env: MessageEnvelope) => void;
}

interface BusSub {
  readonly filter: EventFilter;
  readonly onEvent: (env: EventEnvelope) => void;
}

/**
 * Shared cluster simulator state. Construct once per test; pass to
 * the per-node `localClusterTransport` / `localClusterMembership`
 * factories so they all route through the same simulated wire.
 */
export interface LocalClusterRegistry {
  /** Add a node to the simulated cluster. */
  registerNode(nodeId: NodeId): void;
  /** Remove a node from the simulated cluster. */
  unregisterNode(nodeId: NodeId): void;
  /** Snapshot of currently-registered node ids. */
  nodes(): readonly NodeId[];

  /** Add an inbox subscription for `nodeId`; returns unsubscribe. */
  subscribeInbox(nodeId: NodeId, sub: InboxSub): () => void;
  /** Add a bus subscription for `nodeId`; returns unsubscribe. */
  subscribeBus(nodeId: NodeId, sub: BusSub): () => void;
  /** Add a membership-change subscription for `nodeId`; returns unsubscribe. */
  subscribeMembership(nodeId: NodeId, handler: (change: MembershipChange) => void): () => void;

  /** Route an inbox message from `fromNode` to `toNode`. */
  routeMessage(fromNode: NodeId, toNode: NodeId, env: MessageEnvelope): Promise<void>;
  /** Broadcast a bus event from `fromNode` to every OTHER node. */
  routeBroadcast(fromNode: NodeId, env: EventEnvelope): Promise<void>;

  /** Diagnostic: number of currently-subscribed sinks for `nodeId`. */
  subscriberCount(nodeId: NodeId): { readonly inbox: number; readonly bus: number };
}

/**
 * Construct a fresh `LocalClusterRegistry`. Each test should
 * instantiate its own — sharing across tests creates cross-test
 * leakage as registrations accumulate.
 */
export function createLocalClusterRegistry(): LocalClusterRegistry {
  const nodes = new Map<NodeId, NodeEntry>();

  function ensure(nodeId: NodeId): NodeEntry {
    let entry = nodes.get(nodeId);
    if (!entry) {
      entry = {
        inboxSubs: new Set<InboxSub>(),
        busSubs: new Set<BusSub>(),
        membershipSubs: new Set<(change: MembershipChange) => void>(),
      };
      nodes.set(nodeId, entry);
    }
    return entry;
  }

  function emitMembership(change: MembershipChange): void {
    // Fire on every node's membership subscribers. The snapshot
    // kind is emitted to a NEW subscriber separately at subscribe
    // time; this path handles deltas.
    for (const entry of nodes.values()) {
      for (const handler of entry.membershipSubs) {
        // Queue via microtask so callers don't observe synchronous
        // re-entry during the registration callback.
        queueMicrotask(() => handler(change));
      }
    }
  }

  return {
    registerNode(nodeId) {
      if (nodes.has(nodeId)) return;
      ensure(nodeId);
      emitMembership({
        kind: "joined",
        node: nodeId,
        at: new Date().toISOString(),
      });
    },
    unregisterNode(nodeId) {
      if (!nodes.has(nodeId)) return;
      nodes.delete(nodeId);
      emitMembership({
        kind: "lost",
        node: nodeId,
        at: new Date().toISOString(),
        reason: "graceful",
      });
    },
    nodes() {
      return Array.from(nodes.keys());
    },
    subscribeInbox(nodeId, sub) {
      const entry = ensure(nodeId);
      entry.inboxSubs.add(sub);
      return () => {
        entry.inboxSubs.delete(sub);
      };
    },
    subscribeBus(nodeId, sub) {
      const entry = ensure(nodeId);
      entry.busSubs.add(sub);
      return () => {
        entry.busSubs.delete(sub);
      };
    },
    subscribeMembership(nodeId, handler) {
      const entry = ensure(nodeId);
      entry.membershipSubs.add(handler);
      // Emit initial snapshot to this new subscriber (membership
      // subscribers MUST see the current state via a `snapshot`
      // event per the seam contract).
      const snapshot: MembershipChange = {
        kind: "snapshot",
        nodes: Array.from(nodes.keys()),
        at: new Date().toISOString(),
      };
      queueMicrotask(() => handler(snapshot));
      return () => {
        entry.membershipSubs.delete(handler);
      };
    },
    async routeMessage(_fromNode, toNode, env) {
      const entry = nodes.get(toNode);
      if (!entry) return;
      for (const sub of entry.inboxSubs) {
        if (matchesAddress(sub.filter, env)) {
          // Microtask schedule for deterministic ordering and so
          // the sender can `await send()` and have it resolve only
          // after delivery is at least queued.
          queueMicrotask(() => sub.onMessage(env));
        }
      }
    },
    async routeBroadcast(fromNode, env) {
      for (const [nodeId, entry] of nodes) {
        if (nodeId === fromNode) continue;
        for (const sub of entry.busSubs) {
          if (matchesEvent(sub.filter, env)) {
            queueMicrotask(() => sub.onEvent(env));
          }
        }
      }
    },
    subscriberCount(nodeId) {
      const entry = nodes.get(nodeId);
      return {
        inbox: entry?.inboxSubs.size ?? 0,
        bus: entry?.busSubs.size ?? 0,
      };
    },
  };
}

// ============================================================================
// Filter matching — applied at routing time
// ============================================================================

function matchesAddress(filter: AddressFilter, env: MessageEnvelope): boolean {
  if (filter.address !== undefined && filter.address !== env.addressedTo) return false;
  if (filter.scopeId !== undefined) {
    const idx = env.addressedTo.indexOf(":");
    const scopeId = idx >= 0 ? env.addressedTo.slice(idx + 1) : env.addressedTo;
    if (scopeId !== filter.scopeId) return false;
  }
  if (filter.surface !== undefined) {
    const idx = env.addressedTo.indexOf(":");
    const surface = idx >= 0 ? env.addressedTo.slice(0, idx) : env.addressedTo;
    if (surface !== filter.surface) return false;
  }
  return true;
}

function matchesEvent(filter: EventFilter, env: EventEnvelope): boolean {
  if (filter.surface !== undefined && filter.surface !== env.surface) return false;
  if (filter.name !== undefined) {
    if (typeof filter.name === "string") {
      if (env.name !== filter.name) return false;
    } else if ("exact" in filter.name) {
      if (env.name !== filter.name.exact) return false;
    } else if ("prefix" in filter.name) {
      if (!env.name.startsWith(filter.name.prefix)) return false;
    }
  }
  if (filter.scope !== undefined) {
    if (filter.scope.appId !== undefined && env.scope.appId !== filter.scope.appId) return false;
    if (filter.scope.sessionId !== undefined && env.scope.sessionId !== filter.scope.sessionId) {
      return false;
    }
    if (
      filter.scope.nodeId !== undefined &&
      (env.scope as { nodeId?: string }).nodeId !== filter.scope.nodeId
    ) {
      return false;
    }
  }
  return true;
}
