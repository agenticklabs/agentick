/**
 * Shared protocol types for `@agentick/cluster-next`.
 *
 * The cluster protocol's seams (transport, membership, partitioning,
 * codec, durable journal) all reference these. Adapter authors and
 * adopters writing custom seams import from here.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md
 */

/**
 * Stable identity of a cluster member. Adopter-provided at
 * construction (e.g., container hostname, `process.pid` slug,
 * Kubernetes pod name). Two members with the same `NodeId` are
 * indistinguishable to the cluster's routing layer; ids MUST be
 * unique within a cluster.
 *
 * Common values:
 *   - `"node-1"`, `"node-2"` — explicit
 *   - `${hostname}:${process.pid}` — pid-stamped
 *   - `${K8S_POD_NAME}` — Kubernetes-derived
 */
export type NodeId = string;

/**
 * Membership transition event surfaced by the
 * {@link ClusterMembership} seam. Subscribers see one event per
 * topology change; the membership stream is the source of truth for
 * partitioning rebalances and routing-table refreshes.
 */
export type MembershipChange =
  | {
      readonly kind: "joined";
      readonly node: NodeId;
      /**
       * Wall-clock timestamp from the issuing node, ISO-8601. Best-
       * effort; clocks across cluster members are NOT assumed
       * synchronized. Use for human display, not ordering decisions.
       */
      readonly at: string;
    }
  | {
      readonly kind: "lost";
      readonly node: NodeId;
      readonly at: string;
      /**
       * Cause hint:
       *   - `"graceful"`: the node called its membership impl's `close()`.
       *   - `"timeout"`: heartbeat timeout / health check failure.
       *   - `"unknown"`: cause not determined (e.g., transport drop).
       */
      readonly reason: "graceful" | "timeout" | "unknown";
    }
  | {
      readonly kind: "snapshot";
      /**
       * Full membership snapshot — emitted on subscribe so the
       * subscriber sees current state without needing to wait for
       * the next delta. Implementations MUST emit at least one
       * `snapshot` per subscription; subsequent deltas follow.
       */
      readonly nodes: ReadonlyArray<NodeId>;
      readonly at: string;
    };

/**
 * Filter applied at the {@link ClusterTransport} `subscribeInbox`
 * seam. Mirrors the address shape that `MessageInbox.register`
 * accepts in the substrate.
 *
 * An empty filter (no fields set) matches all addresses — used by
 * routing-layer subscribers that want every inbound message.
 *
 * For typical usage, harnesses subscribe via the framework; this
 * filter is the cluster-internal projection of the harness's
 * registered addresses.
 */
export interface AddressFilter {
  /** Match the surface prefix (e.g. `"tasks"`, `"elicitation"`, `"mcp"`). */
  readonly surface?: string;
  /** Match the exact scope id (e.g. `"session-abc-123"`). */
  readonly scopeId?: string;
  /** Match the full address verbatim. Most specific. */
  readonly address?: string;
}

/**
 * Filter applied at the {@link ClusterTransport} `subscribeBus`
 * seam. Mirrors `EventBus.subscribe()`'s filter shape — the cluster
 * transport projects the framework's existing event-subscription
 * predicates onto the wire.
 */
export interface EventFilter {
  readonly surface?: string;
  readonly name?: string | { readonly exact: string } | { readonly prefix: string };
  readonly scope?: {
    readonly appId?: string;
    readonly sessionId?: string;
    readonly nodeId?: NodeId;
  };
}

/**
 * Opaque checkpoint into a {@link DurableJournal}'s replay stream.
 * Implementations choose the concrete shape (Postgres LSN, Redis
 * Streams entry id, Kafka offset, etc.). The framework treats it
 * opaquely.
 *
 * `null` means "from the beginning" — replay every entry the
 * journal has retained.
 */
export type JournalOffset = string | null;

/**
 * One entry produced by a {@link DurableJournal} replay. Carries the
 * underlying journal record + the offset BEFORE this entry, so
 * adopters can resume mid-replay. Schema of `record` matches the
 * journal's append shape (`OperationJournal.append` from spec-next).
 */
export interface JournalEntry {
  readonly offset: JournalOffset;
  readonly record: unknown;
}
