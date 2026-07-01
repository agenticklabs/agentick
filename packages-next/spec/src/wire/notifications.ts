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
// notifications/capabilities/changed — wire-extension set mutated (#311)
// ============================================================================

/**
 * Sent by the server when its wire-extension set changes at runtime
 * (extension installed / uninstalled / replaced). Payload is
 * intentionally bare — the client refetches `_extensions/list` and
 * rebuilds its `ClientCapabilities` from the fresh enumeration.
 *
 * Mirrors the MCP `notifications/{tools,prompts,resources}/list_changed`
 * pattern: "the list changed, ask again." Avoids delta reconciliation
 * (adds/removes/replaces) and the race windows that come with it.
 *
 * SDKs in other languages (Go, Python) MUST implement this notification
 * to keep their in-memory capability sets fresh. Servers that never
 * install/uninstall extensions at runtime simply never emit it — the
 * static-registration case has no client-side burden.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */
export type CapabilitiesChangedNotificationParams = Record<string, never>;

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
  "notifications/subscription/event": SubscriptionEventParams;
  "notifications/subscription/evicted": SubscriptionEvictedParams;
  "notifications/subscription/closed": SubscriptionClosedParams;
  "notifications/cancelled": CancelledNotificationParams;
  "notifications/capabilities/changed": CapabilitiesChangedNotificationParams;
  "notifications/auth/expired": AuthExpiredNotificationParams;
  "notifications/auth/challenge": AuthChallengeNotificationParams;
}

export type WireNotificationMethod = keyof WireNotifications;
export type WireNotificationParams<M extends WireNotificationMethod> = WireNotifications[M];
