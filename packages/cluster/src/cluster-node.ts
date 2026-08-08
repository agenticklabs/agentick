/**
 * `ClusterNode` — the wire-agnostic ergonomic facade.
 *
 * Every concrete `joinXCluster(...)` factory in a wire package
 * (`@agentick/cluster-net`, `@agentick/cluster-ws`,
 * `@agentick/cluster-redis`) does its own wire-specific setup
 * (bind race, server start, Redis pub/sub channels) and then hands
 * a `{transport, membership}` factory pair to {@link makeClusterNode}.
 *
 * What the facade adds on top of the raw seams:
 *
 *   - **Name-based bus** — `node.bus.subscribe(name, handler)` /
 *     `node.bus.broadcast(name, payload?)` auto-stamps the envelope
 *     (`id`, `timestamp`, `phase`, `surface`, `scope.nodeId`).
 *   - **`membership.waitForPeers(n)`** — resolves when N peer nodes
 *     are visible in membership; replaces the hand-rolled
 *     subscribe-and-count pattern.
 *   - **Self-managed lifecycle** — the facade owns the internal
 *     `ClusterParent` so adopters never have to fake one. Supports
 *     `await using node = ...` via `Symbol.asyncDispose`.
 *   - **Unified diagnostic sink** — wire packages fan diagnostics
 *     from listener / broker / client into a single callback.
 *
 * Power users that need full `EventFilter` shape, raw `transport.send`,
 * or other primitive surface area still get them via
 * `node.transport` — the facade is additive, not restrictive.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md
 */

import type { EventEnvelope, EventPhase, EventSurface } from "@agentick/spec";
import { omitUndefined, generateId } from "@agentick/utils";

import type { ClusterParent } from "./cluster.js";
import type { ClusterMembershipFactory, ClusterTransportFactory } from "./factories.js";
import type { ClusterMembership } from "./membership.js";
import type { ClusterTransport } from "./transport.js";
import type { EventFilter, MembershipChange, NodeId } from "./types.js";

// ============================================================================
// Bus facade
// ============================================================================

/**
 * Ergonomic bus surface — name-based subscribe + auto-stamped
 * broadcast. Wraps the raw `ClusterTransport.subscribeBus` /
 * `broadcast` with sensible defaults.
 *
 * Power users can still call `node.transport.subscribeBus(filter, ...)`
 * for full `EventFilter` shape (prefix matches, scope filters).
 */
export interface BusFacade {
  /**
   * Subscribe by event name. Pass `"*"` to receive every broadcast
   * (equivalent to an empty filter). The handler receives the full
   * `EventEnvelope`; reach for `env.payload` for application data.
   *
   * Returns an async unsubscribe.
   */
  subscribe(name: string, handler: (env: EventEnvelope) => void): () => Promise<void>;
  /**
   * Broadcast an event by name. The envelope is auto-stamped with:
   *   - `id`: ULID
   *   - `timestamp`: `Date.now()`
   *   - `phase`: `"terminal"` (discrete-event convention)
   *   - `surface`: the segment before the first `:` in `name`
   *     (e.g. `"otto:hello"` → `"otto"`). Override via `opts.surface`.
   *   - `scope.nodeId`: this node's id.
   *
   * Awaits the underlying `transport.broadcast`, which throws if the
   * client isn't connected.
   */
  broadcast(
    name: string,
    payload?: unknown,
    opts?: {
      readonly surface?: EventSurface;
      readonly phase?: EventPhase;
      readonly tags?: readonly string[];
      readonly scope?: Omit<EventEnvelope["scope"], "nodeId">;
    },
  ): Promise<void>;
}

function deriveSurface(name: string): EventSurface {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(0, colon)) as EventSurface;
}

function makeBusFacade(
  transport: ClusterTransport,
  nodeId: NodeId,
  unsubs: Set<() => Promise<void>>,
): BusFacade {
  return {
    subscribe(name, handler) {
      const filter: EventFilter = name === "*" ? {} : { name: { exact: name } };
      const unsub = transport.subscribeBus(filter, handler);
      unsubs.add(unsub);
      return async () => {
        unsubs.delete(unsub);
        await unsub();
      };
    },
    async broadcast(name, payload, opts) {
      const env: EventEnvelope = {
        id: generateId(),
        surface: opts?.surface ?? deriveSurface(name),
        name,
        phase: opts?.phase ?? "terminal",
        timestamp: Date.now(),
        scope: { ...(opts?.scope ?? {}), nodeId },
        ...omitUndefined({ payload, tags: opts?.tags }),
      };
      await transport.broadcast(env);
    },
  };
}

// ============================================================================
// Membership facade
// ============================================================================

/**
 * `ClusterMembership` + a `waitForPeers(n)` convenience. Adopters
 * routinely need to wait until the cluster has N peers before
 * issuing work (e.g. broadcasting hello to N-1 known peers); this
 * folds the membership.onChange + counter pattern into one call.
 */
export interface MembershipFacade extends ClusterMembership {
  /**
   * Resolve when this node sees AT LEAST `n` peers in membership
   * (peers = members other than self). Resolves immediately if the
   * threshold is already met when called.
   *
   * Useful for setup-phase coordination ("wait until everyone has
   * joined before issuing the first broadcast"). Don't use it as a
   * steady-state primitive — membership churn after the threshold
   * doesn't re-fire it.
   */
  waitForPeers(n: number, opts?: { readonly timeoutMs?: number }): Promise<readonly NodeId[]>;
}

function makeMembershipFacade(
  membership: ClusterMembership,
  selfNodeId: NodeId,
  signalAborted: () => boolean,
): MembershipFacade {
  return {
    currentNode: membership.currentNode,
    nodes: () => membership.nodes(),
    onChange: (handler) => membership.onChange(handler),
    close: () => membership.close(),
    async waitForPeers(n, opts) {
      if (n <= 0) return [];
      return new Promise<readonly NodeId[]>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let detach: (() => Promise<void>) | null = null;
        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (detach) void detach();
          action();
        };
        // Track the live member set locally from change events. We
        // CANNOT poll `membership.nodes()` inside a `joined` handler:
        // most impls (Redis, in-particular) emit the joined event
        // BEFORE updating their internal snapshot, so a same-tick
        // `nodes()` returns the pre-join value. Building the snapshot
        // ourselves from snapshot/joined/lost deltas avoids the race.
        const live = new Set<NodeId>();
        const evalNow = (): void => {
          const peers = [...live].filter((id) => id !== selfNodeId);
          if (peers.length >= n) {
            settle(() => resolve(peers));
          }
        };
        if (opts?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            settle(() =>
              reject(
                new Error(`cluster-node: waitForPeers(${n}) timed out after ${opts.timeoutMs}ms`),
              ),
            );
          }, opts.timeoutMs);
        }
        const off = membership.onChange((change: MembershipChange) => {
          if (signalAborted()) {
            settle(() => reject(new Error("cluster-node: cluster closed during waitForPeers")));
            return;
          }
          if (change.kind === "snapshot") {
            live.clear();
            for (const id of change.nodes) live.add(id);
          } else if (change.kind === "joined") {
            live.add(change.node);
          } else {
            live.delete(change.node);
          }
          evalNow();
        });
        detach = () => Promise.resolve(off()).then(() => {});
      });
    },
  };
}

// ============================================================================
// ClusterNode handle
// ============================================================================

/**
 * Wire-agnostic cluster handle returned by every wire package's
 * `joinXCluster(...)` factory. Implements `Symbol.asyncDispose` so
 * adopters can write:
 *
 * ```ts
 * await using node = await joinUnixCluster({ socketPath, nodeId });
 * node.bus.subscribe("hello", (env) => { ... });
 * await node.membership.waitForPeers(2);
 * await node.bus.broadcast("hello");
 * // node disposes automatically at scope exit.
 * ```
 */
export interface ClusterNode {
  readonly nodeId: NodeId;
  /**
   * `"broker"` if this process is currently serving the broker for
   * the cluster, `"client"` otherwise.
   *
   * For wires with a broker-process model (TCP, Unix, WS), this is
   * the role at join time — a Unix-cluster client process can later
   * be promoted via re-election; check `localBrokerRunning()` for
   * the live state.
   *
   * For brokerless wires (Redis), every node is always `"client"`.
   */
  readonly role: "broker" | "client";
  readonly transport: ClusterTransport;
  readonly membership: MembershipFacade;
  readonly bus: BusFacade;
  /**
   * `true` if this process is currently hosting a broker — either
   * because it won the initial bind race or because it was promoted
   * via re-election after the broker died. Always `false` on
   * brokerless wires (Redis).
   */
  localBrokerRunning(): boolean;
  /**
   * Tear down: unsubscribe every active bus handler, close the
   * cluster client (graceful GOODBYE if the wire supports it),
   * close any locally-elected broker, run wire-specific cleanup.
   * Idempotent.
   */
  close(): Promise<void>;
  /** `await using` support — same as {@link close}. */
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// makeClusterNode
// ============================================================================

export interface MakeClusterNodeOptions {
  readonly nodeId: NodeId;
  /**
   * Role this process is taking. Wire packages decide based on their
   * election scheme (bind-race for Unix, explicit broker/client for
   * TCP/WS, always `"client"` for brokerless wires).
   */
  readonly role: "broker" | "client";
  readonly transportFactory: ClusterTransportFactory;
  readonly membershipFactory: ClusterMembershipFactory;
  /**
   * Wire-specific tear-down — runs AFTER the parent.onClose chain
   * (which closes the multiplexed client). Use for: closing a
   * locally-elected broker, releasing wire-specific server handles,
   * disposing Redis pub/sub channels.
   *
   * Errors are caught + swallowed; the facade is best-effort during
   * teardown.
   */
  readonly cleanup?: () => Promise<void>;
  /**
   * Wire-specific introspection — returns whether this process is
   * currently serving as broker. Wired into
   * `ClusterNode.localBrokerRunning()`. Defaults to `() => false`
   * (brokerless wires).
   */
  readonly localBrokerRunning?: () => boolean;
}

/**
 * Wrap a `{transport, membership}` factory pair into a
 * {@link ClusterNode} with bus/membership facades + managed
 * lifecycle.
 *
 * This is the seam wire packages compose against. Each wire's
 * `joinXCluster` does its wire-specific setup (bind race, server
 * start, channel subscribe) and then calls this — keeps the
 * facade plumbing out of every wire package.
 */
export async function makeClusterNode(opts: MakeClusterNodeOptions): Promise<ClusterNode> {
  const { nodeId, role, transportFactory, membershipFactory, cleanup, localBrokerRunning } = opts;

  // The facade owns the parent lifecycle — adopters never see it.
  const closeHandlers: Array<() => void | Promise<void>> = [];
  const parent: ClusterParent = {
    onClose: (h) => {
      closeHandlers.push(h);
    },
  } as ClusterParent;

  // Factories may return `T | Promise<T>` per the Factory<R, P>
  // primitive — collapse via Promise.resolve so callers don't care.
  const transport = await Promise.resolve(transportFactory(parent));
  const membership = await Promise.resolve(membershipFactory(parent));

  const unsubs = new Set<() => Promise<void>>();
  const bus = makeBusFacade(transport, nodeId, unsubs);

  let closed = false;
  const membershipFacade = makeMembershipFacade(membership, nodeId, () => closed);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // 1. Drop every active facade subscription. Errors during
    //    teardown are non-fatal — we're closing anyway.
    for (const unsub of unsubs) {
      try {
        await unsub();
      } catch {
        // ignore
      }
    }
    unsubs.clear();
    // 2. Run parent.onClose handlers in registration order. Flushes
    //    GOODBYE + closes the multiplexed connection.
    for (const h of closeHandlers) {
      try {
        await h();
      } catch {
        // ignore
      }
    }
    // 3. Wire-specific tear-down (e.g. close locally-elected broker).
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // ignore
      }
    }
  };

  return {
    nodeId,
    role,
    transport,
    membership: membershipFacade,
    bus,
    localBrokerRunning: localBrokerRunning ?? (() => false),
    close,
    [Symbol.asyncDispose]: close,
  };
}
