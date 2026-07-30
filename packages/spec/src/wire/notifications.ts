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
// notifications/initialized — client → server handshake completion
// ============================================================================

/**
 * Sent by the client after a successful `initialize` response. Signals
 * the server that the client is ready to receive notifications and
 * issue normal RPCs. Server SHOULD NOT send other notifications before
 * receiving this. Mirrors MCP's `notifications/initialized`.
 */
export type InitializedNotificationParams = Record<string, never>;

// ============================================================================
// notifications/progress — LSP $/progress pattern for execution-bound streams
// ============================================================================

export interface ProgressNotificationParams {
  /** Client-allocated; matches the request's `params._meta.progressToken`. */
  readonly progressToken: string;
  readonly cursor: Cursor;
  readonly envelope: EventEnvelope;
}

/**
 * End-of-stream marker for one progress token, sent after the last
 * `notifications/progress` frame carrying it. Carries the token and nothing
 * else: a bounded stream reaching its end is not a failure and has no reason
 * (contrast {@link SubscriptionClosedParams}, which reports server-initiated
 * teardown of an OPEN-ENDED stream).
 */
export interface ProgressCompleteParams {
  readonly progressToken: string;
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

/**
 * RESERVED — declared, registered, and deliberately unproduced. Nothing on
 * the server sends this frame, and nothing will until subscriptions retain
 * events at all: eviction is a statement about a retention window
 * ("your cursor fell out of the buffer"), and today's fan-out has no buffer
 * to fall out of — it is live-only, and a client that drops simply misses
 * what it was not connected for.
 *
 * The shape is kept because it is what the eviction frame WILL carry once
 * retention lands, and the client already discriminates it (a
 * `cursorEvicted` transport error, ADR 29 Phase C). See the
 * `TODO(wire-resume)` trailhead on `subscriptionsWireExtension` in
 * `@agentick/gateway` for the design this is the last step of.
 */
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
  "notifications/initialized": InitializedNotificationParams;
  "notifications/progress": ProgressNotificationParams;
  "notifications/progress/complete": ProgressCompleteParams;
  "notifications/subscription/event": SubscriptionEventParams;
  "notifications/subscription/evicted": SubscriptionEvictedParams;
  "notifications/subscription/closed": SubscriptionClosedParams;
  "notifications/cancelled": CancelledNotificationParams;
  "notifications/auth/expired": AuthExpiredNotificationParams;
  "notifications/auth/challenge": AuthChallengeNotificationParams;
}

export type WireNotificationMethod = keyof WireNotifications;
export type WireNotificationParams<M extends WireNotificationMethod> = WireNotifications[M];
