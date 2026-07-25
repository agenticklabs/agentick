/**
 * Cross-harness inbox protocol for {@link ElicitationHarness}.
 *
 * Defines the typed inbox-message shapes another harness sends to
 * drive an elicit on a session's elicitation harness WITHOUT holding
 * an in-process object reference. Same protocol routes in-memory
 * (LocalInbox) and across cluster nodes (ClusterInbox) — the
 * address-based dispatch is the cluster-portable seam.
 *
 * Usage from the calling side (e.g. `@agentick/mcp`):
 *
 * 1. Generate a `correlationId`.
 * 2. Register a Deferred in your harness's `requests` registry
 *    keyed by that correlationId.
 * 3. `inbox.send(elicitAddress, { type: "elicit-request",
 *    correlationId, payload: { request, replyTo, correlationId } })`.
 * 4. Await the Deferred. The session's elicitation harness will route
 *    its `ElicitationResult` back as a `request-response` envelope —
 *    `BaseHarness.dispatchMessage` auto-resolves your Deferred.
 *
 * No new `request-response` variant is invented for the reply — we
 * reuse the framework's existing auto-intercept so any harness with a
 * `requests` registry can be a caller. The `elicit-request` direction
 * is new because the elicit *is* a side-effectful operation, not a
 * pure response, and needs explicit dispatch.
 *
 * @see ./harness.ts ElicitationHarness.handleElicitRequest
 */

import type { ElicitationRequest, StandardSchemaV1 } from "@agentick/spec";

// ============================================================================
// elicit-request payload (caller → ElicitationHarness inbox)
// ============================================================================

/**
 * Inbox payload shape sent to an `ElicitationHarness.address` to
 * drive a single elicit. `replyTo` is the caller's harness address;
 * the elicit harness routes the `ElicitationResult` back there as a
 * `request-response` envelope keyed by `correlationId`.
 *
 * `request` is the same discriminated `ElicitationRequest` the
 * harness's public `elicit()` method accepts — schema is required
 * for form mode but lands as a plain value here (not a function);
 * callers passing a schema-bearing request via inbox MUST send a
 * JSON-Schema-wrapped Standard Schema (`jsonSchema(...)`) since
 * functions are not serializable across transports.
 */
export interface ElicitRequestInboxPayload {
  readonly request: ElicitationRequest<StandardSchemaV1>;
  readonly replyTo: string;
  readonly correlationId: string;
}

// ============================================================================
// Message type constant
// ============================================================================

/**
 * Canonical `type` field for the {@link ElicitRequestInboxPayload}
 * envelope. Exported so callers don't have to string-literal it.
 */
export const ELICIT_REQUEST_MESSAGE_TYPE = "elicit-request" as const;
export type ElicitRequestMessageType = typeof ELICIT_REQUEST_MESSAGE_TYPE;
