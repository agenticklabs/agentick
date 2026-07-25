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
 * wrapper enforces this at `register` / `send` / `ask` entry points
 * with a `RoutingFailed`. Without enforcement, an adopter (malicious
 * or careless) could register a handler at `@cluster/asks:node-X` and
 * intercept ask responses, or send a forged `@cluster/ask-response`
 * envelope to resolve a pending Deferred with attacker-controlled
 * data.
 *
 * Wire payloads are validated at the inbound boundary
 * (`handleInboundAskRequest` / `handleInboundAskResponse`). Any
 * envelope that fails the shape check emits a diagnostic and is
 * dropped — we never trust the `unknown` payload past a runtime
 * validator. This matters under Phase 4 adapters with real
 * serialization where a malformed wire byte can deliver `any` to
 * `as R` casts.
 */

import type {
  InboxError,
  InboxErrorChannel,
  MessageEnvelope,
  MessageHandlerError,
  MessageHandlerErrorChannel,
} from "@agentick/spec";
import { isObject } from "@agentick/utils";

import type { NodeId } from "../types.js";

// ============================================================================
// Reserved namespace
// ============================================================================

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

// ============================================================================
// Exhaustive tag guards (spec-evolution-safe)
// ============================================================================

/**
 * Tag enumeration that the compiler enforces against the
 * `MessageHandlerError` union — if the spec adds a tag, the
 * initializer below fails to compile until we add the case. This is
 * the load-bearing safety net for the typed-error round-trip story.
 */
const MESSAGE_HANDLER_ERROR_TAGS: { readonly [K in MessageHandlerErrorChannel["_tag"]]: true } = {
  HandlerError: true,
  InvalidPayload: true,
};

const INBOX_ERROR_TAGS: { readonly [K in InboxErrorChannel["_tag"]]: true } = {
  AddressNotFound: true,
  RoutingFailed: true,
  InboxClosed: true,
  AskTimeout: true,
};

export function isMessageHandlerError(value: unknown): value is MessageHandlerError {
  if (!isObject(value)) return false;
  const tag = value._tag;
  if (typeof tag !== "string") return false;
  return Object.hasOwn(MESSAGE_HANDLER_ERROR_TAGS, tag);
}

export function isInboxError(value: unknown): value is InboxError {
  if (!isObject(value)) return false;
  const tag = value._tag;
  if (typeof tag !== "string") return false;
  return Object.hasOwn(INBOX_ERROR_TAGS, tag);
}

// ============================================================================
// Ask-request wire payload
// ============================================================================

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

export function isClusterAskRequestPayload(value: unknown): value is ClusterAskRequestPayload {
  if (!isObject(value)) return false;
  if (typeof value.innerType !== "string") return false;
  // Optional fields — only validate types if present.
  if (value.innerFrom !== undefined && typeof value.innerFrom !== "string") return false;
  if (value.innerParentOpId !== undefined && typeof value.innerParentOpId !== "string") {
    return false;
  }
  if (value.innerCorrelationId !== undefined && typeof value.innerCorrelationId !== "string") {
    return false;
  }
  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") return false;
  return true;
}

// ============================================================================
// Ask-response wire payload
// ============================================================================

/**
 * The discriminated outcome the asker's wrapper feeds back into the
 * pending Deferred. Three failure modes are distinguished so the
 * adopter's typed error surface (both `MessageHandlerError` and
 * `InboxError`) round-trips structurally across the cluster rather
 * than being flattened to a stringly-typed routing failure.
 *
 *   - `success`       — handler returned a value
 *   - `handler-fail`  — handler raised a typed `MessageHandlerError`
 *   - `routing-fail`  — `local.ask` itself failed before reaching the
 *                       handler (AddressNotFound, InboxClosed,
 *                       AskTimeout, RoutingFailed)
 *   - `interrupt`     — handler fiber was interrupted (remote close
 *                       mid-call)
 */
export type ClusterAskResponsePayload<R = unknown> =
  | { readonly _tag: "success"; readonly value: R }
  | { readonly _tag: "handler-fail"; readonly error: MessageHandlerError }
  | { readonly _tag: "routing-fail"; readonly error: InboxError }
  | { readonly _tag: "interrupt" };

export function isClusterAskResponsePayload(value: unknown): value is ClusterAskResponsePayload {
  if (!isObject(value)) return false;
  switch (value._tag) {
    case "success":
      return "value" in value;
    case "handler-fail":
      return isMessageHandlerError(value.error);
    case "routing-fail":
      return isInboxError(value.error);
    case "interrupt":
      return true;
    default:
      return false;
  }
}

// ============================================================================
// Envelope type guards
// ============================================================================

export function isClusterAskRequest(env: MessageEnvelope): boolean {
  return env.type === CLUSTER_ASK_TYPE;
}

export function isClusterAskResponse(env: MessageEnvelope): boolean {
  return env.type === CLUSTER_ASK_RESPONSE_TYPE;
}
