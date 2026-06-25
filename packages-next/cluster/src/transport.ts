/**
 * `ClusterTransport` — the wire-level seam adapters implement to
 * carry messages and events across the cluster.
 *
 * Adapter authors write a Promise-flavored impl + callback-based
 * subscription returning an unsubscribe function. The
 * {@link defineClusterTransport} helper (in `./define.ts`) bridges
 * to the framework's internal Effect/Layer machinery.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";

import type { AddressFilter, EventFilter, NodeId } from "./types.js";

/**
 * Cross-node wire. Carries inbox messages (point-to-point) and bus
 * events (broadcast). Subscriptions return an `unsubscribe`
 * function; the framework calls it on shutdown / re-subscribe.
 *
 * Ordering guarantees adapters MUST honor:
 *   - **Per-(source, destination) FIFO** for `send()`. Two messages
 *     A then B from node N1 to N2 arrive at N2 in order A → B.
 *     Cross-source ordering is NOT guaranteed.
 *   - **Per-source FIFO** for `broadcast()`. Events emitted by
 *     node N in order E1 then E2 are observed by any subscriber in
 *     order E1 → E2. Cross-source ordering across nodes is NOT
 *     guaranteed (a "wall-clock" total order doesn't exist in a
 *     distributed system).
 *
 * Delivery guarantees:
 *   - `send` is **at-least-once** to a live recipient; adapters MAY
 *     implement acks for stricter guarantees but the framework does
 *     not assume them. Recipients dedupe by envelope id where
 *     idempotency matters.
 *   - `broadcast` is **best-effort to current subscribers**. Late
 *     subscribers do NOT see historical events (the cluster bus is
 *     NOT an event log; durable replay lives on {@link DurableJournal}).
 */
export interface ClusterTransport {
  /**
   * Send a message envelope to a specific node. The envelope's
   * `target` and `correlationId` already encode the destination
   * harness address + reply correlation; the transport's job is
   * purely to land the envelope at the right NODE, where the local
   * inbox dispatch resolves it to a harness.
   *
   * Rejects (via Promise rejection) on transport-level failure
   * (broker unreachable, codec error). Does NOT reject if the
   * destination node has no handler for the address — that's the
   * recipient's policy; the transport's job ends at delivery.
   */
  send(toNode: NodeId, env: MessageEnvelope): Promise<void>;

  /**
   * Broadcast an event envelope to every node in the cluster.
   * Receivers route it into their local bus; subscribers see it
   * exactly as if it had been emitted node-locally.
   *
   * Idempotency: the receiver is responsible for not re-broadcasting
   * an event it received via broadcast. The cluster bus tags
   * inbound-from-cluster events so they're not echoed back out.
   */
  broadcast(env: EventEnvelope): Promise<void>;

  /**
   * Subscribe to inbound messages matching `filter`. The
   * `onMessage` callback fires per delivered envelope. The returned
   * function unsubscribes; awaiting the returned promise guarantees
   * the underlying transport-level resources (Redis SUBSCRIBE
   * registrations, NATS subscription handles, IPC socket
   * listeners) have been released. Calling unsubscribe MUST NOT
   * throw; transient async errors during cleanup are swallowed by
   * the adapter and surfaced via the cluster's diagnostic events.
   *
   * Adapters MAY deliver messages synchronously OR asynchronously
   * from the callback's POV. Subscribers MUST handle either.
   */
  subscribeInbox(
    filter: AddressFilter,
    onMessage: (env: MessageEnvelope) => void,
  ): () => Promise<void>;

  /**
   * Subscribe to inbound events matching `filter`. Same shape as
   * {@link subscribeInbox}; the callback fires per delivered event.
   */
  subscribeBus(filter: EventFilter, onEvent: (env: EventEnvelope) => void): () => Promise<void>;

  /**
   * Cooperative close. Drops every subscription; flushes any
   * in-flight `send` / `broadcast` if the adapter supports it;
   * releases transport-level resources (sockets, connections,
   * heartbeats). After `close`, subsequent calls SHOULD reject /
   * be no-ops; adapters MUST NOT throw on double-close.
   */
  close(): Promise<void>;
}
