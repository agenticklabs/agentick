/**
 * `defineCluster*` adapter-authoring helpers — Phase 2 impls.
 *
 * Per ADR 36: every `defineX` returns a factory shape. Adapter
 * authors supply Promise-flavored implementations; the helpers
 * here wrap them in `Factory<X, ClusterParent>` shapes the
 * framework consumes.
 *
 * Phase 2 lands the bridge — Phase 3 will wire ClusterEventBus /
 * ClusterInbox wrappers; Phase 5 hooks into createGateway /
 * createApp's substrate construction.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2, §4
 * @see docs/proposals/v2/blueprint/36-define-vs-create-convention.md
 */

import { consistentHashPartitioning } from "./builtins/consistent-hash-partitioning.js";
import { jsonCodec } from "./builtins/json-codec.js";
import type { Cluster, ClusterFactory, ClusterParent } from "./cluster.js";
import type { ClusterCodec } from "./codec.js";
import type {
  ClusterCodecFactory,
  ClusterMembershipFactory,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
} from "./factories.js";
import type { DurableJournal } from "./journal.js";
import type { ClusterMembership } from "./membership.js";
import type { ClusterPartitioning } from "./partitioning.js";
import type { ClusterTransport } from "./transport.js";
import type { NodeId } from "./types.js";

// ============================================================================
// Top-level cluster spec
// ============================================================================

/**
 * Adopter-facing config for {@link defineCluster}. The factory
 * returned wraps the parent harness's substrate at the substrate
 * seam (see ADR 35 §1).
 */
export interface DefineClusterConfig {
  /**
   * Identity for THIS node. Static or lazy. Lazy thunk is resolved
   * at construction; common pattern is to derive from an env var.
   *
   *   nodeId: "node-1"                                  // static
   *   nodeId: () => process.env.NODE_ID ?? "default"    // lazy
   */
  readonly nodeId: NodeId | (() => NodeId | Promise<NodeId>);

  /** Required: cross-node wire. */
  readonly transport: ClusterTransportFactory;

  /** Required: who's in the cluster. */
  readonly membership: ClusterMembershipFactory;

  /**
   * Optional: address → owning node mapping. Defaults to consistent
   * hash on the scopeId extracted from each address. Adopters
   * override to shard by tenant / user / custom topology.
   */
  readonly partitioning?: ClusterPartitioningFactory;

  /**
   * Optional: durable journal for rung (d) deployments. Absent →
   * the parent's local journal is used (in-memory or whatever the
   * adopter wired). When present, the cluster's effective journal
   * is this one.
   */
  readonly journal?: DurableJournalFactory;

  /**
   * Optional: wire serialization codec. Defaults to JSON (bundled
   * in this package). Swap for MessagePack (perf), protobuf
   * (schemas), or a custom codec for non-standard wires.
   */
  readonly codec?: ClusterCodecFactory;

  /**
   * Default delivery mode for bus subscriptions. Adopters can
   * override per-subscription. Most adopters want node-local;
   * management dashboards explicitly subscribe cluster-wide.
   *
   *   "node-local-default" (default) — subscribers see only events
   *     published on the current node.
   *   "cluster-wide-default" — subscribers see events from all
   *     nodes.
   */
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

// ============================================================================
// Adapter-authoring helpers — one per seam
// ============================================================================

/**
 * Wrap a Promise-flavored {@link ClusterTransport} implementation
 * into a `ClusterTransportFactory` the framework consumes.
 *
 * Adapter authors typically wrap this in a configurable factory:
 *
 *   export function redisTransport(opts: RedisOptions): ClusterTransportFactory {
 *     return defineClusterTransport({
 *       async send(toNode, env) { ... },
 *       async broadcast(env) { ... },
 *       subscribeInbox(filter, onMessage) { ... return async () => {}; },
 *       subscribeBus(filter, onEvent) { ... return async () => {}; },
 *       async close() { ... },
 *     });
 *   }
 *
 * The helper's job is small and uniform across all seam helpers:
 * given the parent harness, register `impl.close()` for cleanup at
 * `parent.onClose(...)` and return the impl. The Promise / callback
 * surface stays adopter-facing; the framework's internal
 * consumption decides how to compose Effect supervision around it
 * (Phase 3+ work).
 */
export function defineClusterTransport(impl: ClusterTransport): ClusterTransportFactory {
  return (parent) => {
    parent.onClose(() => impl.close());
    return impl;
  };
}

/**
 * Wrap a Promise-flavored {@link ClusterMembership} implementation
 * into a `ClusterMembershipFactory`. Same authoring pattern as
 * {@link defineClusterTransport}.
 */
export function defineClusterMembership(impl: ClusterMembership): ClusterMembershipFactory {
  return (parent) => {
    parent.onClose(() => impl.close());
    return impl;
  };
}

/**
 * Wrap a {@link ClusterPartitioning} implementation into a factory.
 * `shardKeyFor` is pure; `nodeFor` is async — the helper preserves
 * both shapes for the framework's internal consumers.
 *
 * Partitioning has no lifecycle of its own — `shardKeyFor` is pure
 * and `nodeFor` consults state externally (typically membership) —
 * so no `onClose` registration is needed.
 */
export function defineClusterPartitioning(impl: ClusterPartitioning): ClusterPartitioningFactory {
  return () => impl;
}

/**
 * Wrap a {@link DurableJournal} implementation into a factory.
 * Optional seam — only adopters opting into rung (d) durability
 * need to provide one.
 *
 * Journal lifecycle (flushing pending writes, closing connections)
 * happens through the underlying `OperationJournal`'s own
 * mechanisms; adapters wire that into `parent.onClose(...)` inside
 * the impl as needed. The helper here just exposes the impl.
 */
export function defineClusterJournal(impl: DurableJournal): DurableJournalFactory {
  return () => impl;
}

/**
 * Wrap a {@link ClusterCodec} implementation into a factory. The
 * bundled JSON codec ({@link jsonCodec}) is the default when no
 * codec is supplied to {@link defineCluster}.
 *
 * Codecs are stateless — no lifecycle registration.
 */
export function defineClusterCodec(impl: ClusterCodec): ClusterCodecFactory {
  return () => impl;
}

// ============================================================================
// Top-level composition
// ============================================================================

/**
 * Compose seam factories into a top-level {@link ClusterFactory}.
 * The framework calls the returned factory at substrate-setup time
 * inside `createGateway` / `createApp`; the returned {@link Cluster}
 * wraps the parent's local substrate.
 *
 * Phase 2 scope: the factory composes the seams, resolves the
 * (optionally-lazy) nodeId, and returns a Cluster value with the
 * transport / membership / partitioning / codec / journal wired up.
 * The `bus` and `inbox` slots are PASS-THROUGH from parent for now
 * — Phase 3 will land the `ClusterEventBus` / `ClusterInbox`
 * wrappers that add cross-node routing.
 */
export function defineCluster(spec: DefineClusterConfig): ClusterFactory {
  return async (parent: ClusterParent): Promise<Cluster> => {
    // Resolve nodeId (static or lazy).
    const nodeId = typeof spec.nodeId === "function" ? await spec.nodeId() : spec.nodeId;

    // Construct seams. Each factory may return sync / Promise /
    // Effect; for Phase 2 we only support sync + Promise (Effect
    // returns from adapter factories land in Phase 3 alongside the
    // wrapper impls that need them).
    // Transport constructed for its onClose side-effect (registered
    // via parent.onClose by defineClusterTransport); Phase 3's wrapper
    // impls (ClusterEventBus / ClusterInbox) will read it for actual
    // cross-node routing. For Phase 2 the construction itself is the
    // load-bearing observable behavior.
    const _transport = await resolveFactoryAsync(spec.transport, parent);
    const membership = await resolveFactoryAsync(spec.membership, parent);

    // Partitioning: explicit > default (consistent-hash on membership).
    const partitioning = spec.partitioning
      ? await resolveFactoryAsync(spec.partitioning, parent)
      : await resolveFactoryAsync(consistentHashPartitioning(membership), parent);

    // Codec: explicit > default (JSON). Constructed here so the
    // chosen codec is realized before the cluster value resolves.
    // Phase 3's wrapper impls read it from the spec when wiring
    // ClusterEventBus / ClusterInbox; for Phase 2 the construction
    // itself is the load-bearing observable behavior.
    const _codec = spec.codec
      ? await resolveFactoryAsync(spec.codec, parent)
      : await resolveFactoryAsync(jsonCodec(), parent);

    // Journal: optional — defaults to parent's journal pass-through.
    const journal = spec.journal ? await resolveFactoryAsync(spec.journal, parent) : parent.journal;

    // For Phase 2, bus and inbox are PASS-THROUGH. Phase 3 lands
    // ClusterEventBus / ClusterInbox wrappers that consult the
    // transport / membership / partitioning to route cross-node.
    const cluster: Cluster = {
      bus: parent.bus,
      inbox: parent.inbox,
      journal,
      currentNode: nodeId,
      nodes: () => membership.nodes(),
      async ownerOf(address) {
        return partitioning.nodeFor(partitioning.shardKeyFor(address));
      },
      async close() {
        // Seam close()s register via parent.onClose during each
        // factory call; this aggregator just runs the top-level
        // teardown (no-op for Phase 2 since all close registration
        // is already in parent.onClose).
        // Codec is stateless; partitioning has no lifecycle.
        // Membership and transport closes are registered via
        // parent.onClose so they fire from the LIFO close chain
        // naturally when the parent harness closes.
        await Promise.resolve();
      },
    };

    return cluster;
  };
}

// Re-export Cluster so adopters importing from `@agentick/cluster-next`
// see the materialized type alongside the helpers.
export type { Cluster };

// ============================================================================
// Internal: factory invocation
// ============================================================================

/**
 * Run a `Factory<R, P>` and resolve its return shape (sync, Promise,
 * or Effect) to a Promise<R>. Phase 2 supports sync + Promise; Effect
 * support lands in Phase 3 alongside the framework-internal Effect
 * supervision that consumes the cluster.
 *
 * Per ADR 31, factory return type is `R | Promise<R> | Effect<R>`.
 * Detecting Effect at runtime: Effect values have a `[Symbol.iterator]`
 * AND a `pipe` method (the latter is the distinguishing feature versus
 * regular iterables). For Phase 2 we throw on Effect returns rather
 * than depending on `effect` at this layer.
 */
async function resolveFactoryAsync<R, P>(
  factory: (parent: P) => R | Promise<R> | unknown,
  parent: P,
): Promise<R> {
  const result = factory(parent);
  if (isEffectLike(result)) {
    throw new Error(
      "cluster-next Phase 2: Effect-returning factories are not yet supported. " +
        "Use Promise/sync returns; Effect support lands in Phase 3.",
    );
  }
  return Promise.resolve(result as R | Promise<R>);
}

function isEffectLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipe" in value &&
    typeof (value as { pipe: unknown }).pipe === "function" &&
    Symbol.iterator in value
  );
}
