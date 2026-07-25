/**
 * Substrate escalation wire constants (ADR 69).
 *
 * "Escalate a request up the ownership chain until handled" is a thin
 * forwarding discipline over the inbox's *existing* addressed
 * request/response — nested `inbox.ask`, nothing more. A blocked node
 * (a task, a sub-agent session) `ask`s its **escalation-parent** with a
 * tagged envelope; each hop's handler either **resolves** it (answer /
 * deny / transform) or **forwards** it one hop up via another
 * `inbox.ask`; the **root** (no escalation-parent) resolves it terminally
 * (the real client `elicitation/create`, a policy). The response threads
 * back down the nested-`ask` return stack to unblock the origin.
 *
 * **This module owns the wire constants only** — the addressing
 * convention (`session:{sessionId}` message type) and the ask bound.
 * They are genuine substrate: the `{surface}:{scopeId}` addressing lives
 * here alongside `LocalInbox`. The *contract types* — the envelope, the
 * lineage hop, the interception outcome + interceptor — live in
 * `@agentick/spec` (`protocol/escalation.ts`), because the spec
 * `SessionHarnessProtocol.interceptEscalation` references them and
 * `runtime-next` depends on `spec-next` (a contract in runtime that the
 * spec protocol referenced would be a dependency cycle). We re-export
 * them here so existing `@agentick/runtime` importers are
 * unaffected.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */

// Contract types live in spec (payload contracts + the interception seam
// the session protocol exposes); re-exported here for substrate importers.
export type {
  EscalationEnvelopePayload,
  EscalationHop,
  EscalationOutcome,
  EscalationInterceptor,
} from "@agentick/spec";

/**
 * Inbox message type for an escalation envelope addressed to a session
 * (`session:{sessionId}`). Handled by the session's `handleMessage`:
 * consult a registered interceptor first, then forward one hop up
 * (`parentSessionId`) if a spawner exists, else resolve terminally
 * against the session's own client-facing harness.
 */
export const SESSION_ESCALATION_MESSAGE_TYPE = "session:escalation";
export type SessionEscalationMessageType = typeof SESSION_ESCALATION_MESSAGE_TYPE;

/**
 * Wait bound for an escalation `inbox.ask`. The default 30s `ask` timeout
 * is wrong for a human-in-the-loop request; escalation asks use a
 * long/effectively-unbounded bound (ADR 69) and rely on the origin's
 * `signal` (ttl / cancel) to tear the chain down early via
 * `Effect.runPromise(effect, { signal })` fiber interruption. The terminal
 * elicitation resolver enforces its own (shorter) human-scale timeout, so
 * this bound only guards against a hop that never returns at all.
 */
export const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
