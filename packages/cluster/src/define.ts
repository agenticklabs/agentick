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

import { Effect } from "effect";
import { ulid } from "@agentick/utils";

import { consistentHashPartitioning } from "./builtins/consistent-hash-partitioning.js";
import { jsonCodec } from "./builtins/json-codec.js";
import type { Cluster, ClusterFactory, ClusterParent } from "./cluster.js";
import { ClusterEventBus } from "./wrappers/cluster-event-bus.js";
import { ClusterInbox } from "./wrappers/cluster-inbox.js";
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
    // Effect; Phase 3 supports sync + Promise (Effect-returning
    // adapter factories will land alongside the Effect-Tag interface
    // exposed under the `/effect` subpath escape hatch).
    const transport = await resolveFactoryAsync(spec.transport, parent);
    const membership = await resolveFactoryAsync(spec.membership, parent);

    // Partitioning: explicit > default (consistent-hash on membership).
    const partitioning = spec.partitioning
      ? await resolveFactoryAsync(spec.partitioning, parent)
      : await resolveFactoryAsync(consistentHashPartitioning(membership), parent);

    // Codec: explicit > default (JSON). Realized here so adapters
    // that swap codecs (msgpack/protobuf) are visible at construction.
    // TODO(phase-4b): the codec is constructed but not yet routed
    // through this layer. @agentick/cluster-net / @agentick/cluster-redis will
    // consume `spec.codec` directly from their factories at the wire
    // boundary. Until then, configuring `codec: msgpackCodec()` is
    // observable-at-construction only — no actual serialization
    // change. Document the no-op clearly in the cluster README's
    // Quick Start so adopters don't expect performance gains yet.
    const _codec = spec.codec
      ? await resolveFactoryAsync(spec.codec, parent)
      : await resolveFactoryAsync(jsonCodec(), parent);

    // Journal: optional — defaults to parent's journal pass-through.
    // TODO(phase-7+): DurableJournal seam is wired but unused. Rung
    // (d) durability requires continuation primitives (idempotency
    // keys on tool dispatches, replay-safe side-effect markers) that
    // aren't in v2.0. The seam ships so adapters can be built
    // incrementally; the framework consumes the slot once
    // continuation primitives land.
    const journal = spec.journal ? await resolveFactoryAsync(spec.journal, parent) : parent.journal;

    // Phase 3: wrap the parent's local substrate with cluster-aware
    // bus + inbox. Locally registered subscribers / handlers see
    // events / messages from BOTH this node and the cluster (subject
    // to fanout mode for the bus; partitioning for the inbox).
    const fanoutMode = spec.fanoutMode ?? "node-local-default";
    const bus = new ClusterEventBus({
      local: parent.bus,
      transport,
      currentNode: nodeId,
      fanoutMode,
    });
    const inbox = new ClusterInbox({
      local: parent.inbox,
      transport,
      partitioning,
      currentNode: nodeId,
      // Wrap diagnostics on the LOCAL bus, not the cluster-wrapped one.
      // Emitting a "broadcast failed" diagnostic via the cluster bus
      // would itself trigger another broadcast attempt — feedback loop
      // and noise. Local bus is the source of truth for this node's
      // operational state.
      localBus: parent.bus,
    });

    // Phase 3.1: wire membership reactivity. defineCluster owns the
    // long-lived onChange subscription so topology changes emit on
    // the (LOCAL) bus regardless of which wrappers are present. Emit
    // to local — same rationale as inbox diagnostics. The subscription
    // is registered with parent.onClose so it tears down in the LIFO
    // chain.
    //
    // TODO(phase-4b): partitioning rebalance on topology change.
    // Currently consistent-hash partitioning reads `membership.nodes()`
    // on every `nodeFor()` call, which IS live but does mean a
    // mid-flight ask can resolve a different owner than it started
    // with. Custom partitioning impls that CACHE membership state
    // need an explicit signal here to refresh their cache. Consider
    // either: (a) ClusterPartitioning.onMembershipChange?(change),
    // or (b) require partitioning impls to always read live.
    const membershipUnsub = membership.onChange((change) => {
      void Effect.runPromise(
        parent.bus.append({
          id: membershipDiagId(),
          surface: "cluster",
          name:
            change.kind === "joined"
              ? "cluster:membership:joined"
              : change.kind === "lost"
                ? "cluster:membership:lost"
                : "cluster:membership:snapshot",
          phase: "terminal",
          timestamp: Date.now(),
          scope: { nodeId },
          payload: change,
        }),
      );
    });

    // Register wrapper closes with the parent so they tear down in
    // the same LIFO chain as the underlying seams. Order at teardown
    // (LIFO): membership-sub → inbox → bus → membership/transport
    // (via their own defineClusterX onClose). Transport and
    // membership impl close()s registered themselves earlier via
    // defineClusterTransport/defineClusterMembership.
    parent.onClose(() => bus.close());
    parent.onClose(() => inbox.close());
    parent.onClose(async () => {
      await membershipUnsub();
    });

    const cluster: Cluster = {
      bus,
      inbox,
      journal,
      currentNode: nodeId,
      nodes: () => membership.nodes(),
      async ownerOf(address) {
        return partitioning.nodeFor(partitioning.shardKeyFor(address));
      },
      async close() {
        // Defensive top-level close — fires the wrapper closes
        // synchronously even when the parent harness lifecycle
        // hasn't run. The wrappers are idempotent on double-close,
        // so this is safe whether or not parent.onClose has already
        // run.
        await inbox.close();
        await bus.close();
      },
    };

    return cluster;
  };
}

// Re-export Cluster so adopters importing from `@agentick/cluster`
// see the materialized type alongside the helpers.
export type { Cluster };

/** ULID-shaped id for membership diagnostic events. */
function membershipDiagId(): string {
  return ulid();
}

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
  factory: (parent: P) => R | Promise<R> | Effect.Effect<R, never, never>,
  parent: P,
): Promise<R> {
  const result = factory(parent);
  if (isEffectLike(result)) {
    throw new Error(
      "@agentick/cluster Phase 2: Effect-returning factories are not yet supported. " +
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
