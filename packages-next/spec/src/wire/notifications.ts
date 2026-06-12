/**
 * Notification method names and their param shapes.
 *
 * All notification methods use the `notifications/` prefix per MCP /
 * LSP convention. Notifications carry no `id` and expect no response.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Wire protocol"
 */

import type { EventEnvelope } from "../data/events.js";
import type { Cursor } from "../protocol/event-log.js";
import type { JsonRpcId } from "./json-rpc.js";

// ============================================================================
// notifications/progress — LSP $/progress pattern for execution-bound streams
// ============================================================================

export interface ProgressNotificationParams {
  /** Client-allocated; matches the request's `params._meta.progressToken`. */
  readonly progressToken: string;
  readonly cursor: Cursor;
  readonly envelope: EventEnvelope;
}

// ============================================================================
// notifications/subscription/* — persistent subscription event delivery
// ============================================================================

export interface SubscriptionEventParams {
  /** Matches the `subscriptionId` returned by `subscribe`. */
  readonly subscriptionId: string;
  readonly cursor: Cursor;
  readonly envelope: EventEnvelope;
}

export interface SubscriptionEvictedParams {
  readonly subscriptionId: string;
  /** Last cursor the client received before eviction. */
  readonly lastCursor: Cursor;
  /** Oldest cursor still in retention. Resubscribe with this to skip the gap. */
  readonly oldestAvailable: Cursor;
}

export interface SubscriptionClosedParams {
  readonly subscriptionId: string;
  /** Null = clean close. Non-null = server-side error that ended the sub. */
  readonly reason: { readonly code: number; readonly message: string } | null;
}

// ============================================================================
// notifications/cancelled — LSP / MCP cancellation
// ============================================================================

export interface CancelledNotificationParams {
  /** The `id` of the in-flight request to cancel. */
  readonly requestId: JsonRpcId;
  readonly reason?: string;
}

// ============================================================================
// notifications/auth/* — unsolicited auth events
// ============================================================================

export interface AuthExpiredNotificationParams {
  /** Free-form code identifying the reason (`token-revoked`, `idle-timeout`, …). */
  readonly reason: string;
  /** Whether the client can call `auth/refresh` to recover without re-authenticating. */
  readonly renewable: boolean;
  /** Sessions whose execution is paused pending re-auth. */
  readonly affectedSessions?: readonly string[];
}

export interface AuthChallengeNotificationParams {
  readonly challengeId: string;
  readonly method: string;
  readonly acr?: string;
  readonly affectedSessions?: readonly string[];
}

// ============================================================================
// Notification registry — exhaustive map for type-safe dispatch
// ============================================================================

/**
 * Canonical map of every wire notification to its params shape.
 *
 * Adopters extending the wire add entries via declaration merging.
 */
export interface WireNotifications {
  "notifications/progress": ProgressNotificationParams;
  "notifications/subscription/event": SubscriptionEventParams;
  "notifications/subscription/evicted": SubscriptionEvictedParams;
  "notifications/subscription/closed": SubscriptionClosedParams;
  "notifications/cancelled": CancelledNotificationParams;
  "notifications/auth/expired": AuthExpiredNotificationParams;
  "notifications/auth/challenge": AuthChallengeNotificationParams;
}

export type WireNotificationMethod = keyof WireNotifications;
export type WireNotificationParams<M extends WireNotificationMethod> = WireNotifications[M];
