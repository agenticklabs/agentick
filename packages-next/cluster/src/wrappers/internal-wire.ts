/**
 * Cluster-internal wire framing for `ClusterInbox.ask` round-trips.
 *
 * Adopter-visible `MessageEnvelope` fields (`type`, `payload`, `from`,
 * `correlationId`) carry adopter semantics; we mustn't overload them.
 * Instead, we wrap an asking caller's envelope inside a cluster-meta
 * envelope using a reserved `@cluster/` namespace:
 *
 *   - `@cluster/ask`           — forward an ask request to the owner node
 *   - `@cluster/ask-response`  — return the result back to the asker
 *   - `@cluster/asks:<nodeId>` — addressedTo for response envelopes
 *
 * Adopter types and addresses MUST NOT start with `@cluster/`; the
 * wrapper treats that prefix as reserved.
 */

import type { MessageEnvelope, MessageHandlerError } from "@agentick/spec-next";

import type { NodeId } from "../types.js";

// ---------------------------------------------------------------------------
// Reserved namespace constants
// ---------------------------------------------------------------------------

export const CLUSTER_NS_PREFIX = "@cluster/";

export const CLUSTER_ASK_TYPE = "@cluster/ask";
export const CLUSTER_ASK_RESPONSE_TYPE = "@cluster/ask-response";

/** Build the reserved reply-address for a node. */
export function clusterReplyAddress(nodeId: NodeId): string {
  return `@cluster/asks:${nodeId}`;
}

/** True when the value belongs to the reserved `@cluster/` namespace. */
export function isClusterReservedType(type: string): boolean {
  return type.startsWith(CLUSTER_NS_PREFIX);
}

// ---------------------------------------------------------------------------
// Ask-request wire payload
// ---------------------------------------------------------------------------

/**
 * Carried inside the `payload` of a `@cluster/ask` envelope. Lets the
 * remote receiver reconstruct an adopter-shaped `MessageEnvelopeInput`
 * for `local.ask` without colliding with adopter-defined fields on
 * the outer envelope.
 */
export interface ClusterAskRequestPayload<T = unknown> {
  readonly innerType: string;
  readonly innerPayload?: T;
  readonly innerFrom?: string;
  readonly innerParentOpId?: string;
  readonly innerCorrelationId?: string;
  /**
   * Original ask timeoutMs from the caller. Receiver honors this when
   * running `local.ask` so the responder's own ask doesn't outlive the
   * asker's patience.
   */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Ask-response wire payload
// ---------------------------------------------------------------------------

/**
 * The discriminated outcome the asker's wrapper feeds back into the
 * pending Deferred. Includes a structured failure shape so the
 * adopter's `MessageHandlerError` round-trips across the cluster
 * without being flattened to a stringly-typed error.
 */
export type ClusterAskResponsePayload<R = unknown> =
  | { readonly _tag: "success"; readonly value: R }
  | { readonly _tag: "fail"; readonly error: MessageHandlerError }
  | { readonly _tag: "interrupt" };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isClusterAskRequest(env: MessageEnvelope): boolean {
  return env.type === CLUSTER_ASK_TYPE;
}

export function isClusterAskResponse(env: MessageEnvelope): boolean {
  return env.type === CLUSTER_ASK_RESPONSE_TYPE;
}
