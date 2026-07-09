/**
 * Substrate escalation protocol (ADR 69).
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
 * This module owns the shared wire constants only — it deliberately stays
 * **payload-agnostic** (ADR 69: "the relay is payload-agnostic →
 * substrate"). The envelope carries an opaque `class` discriminator + an
 * opaque `request`; the origin (tasks) and terminal (session) narrow it.
 * The single implemented class today is `"elicit"`; sampling / permission
 * / credential / error classes ride the same rails later without touching
 * this file.
 *
 * Home rationale: both the origin (`@agentick/tasks-next`) and the
 * relay/terminal (`@agentick/session-next`) address this envelope, and
 * `session-next` depends on `tasks-next` (so the constant can't live in
 * session), while spec is reserved for payload contracts. The substrate
 * package — home of `LocalInbox` and the `{surface}:{scopeId}` addressing
 * convention — is the neutral shared floor.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */

/**
 * Inbox message type for an escalation envelope addressed to a session
 * (`session:{sessionId}`). Handled by the session's `handleMessage`:
 * forward one hop up (`parentSessionId`) if a spawner exists, else
 * resolve terminally against the session's own client-facing harness.
 */
export const SESSION_ESCALATION_MESSAGE_TYPE = "session:escalation";
export type SessionEscalationMessageType = typeof SESSION_ESCALATION_MESSAGE_TYPE;

/**
 * Payload-agnostic escalation envelope (ADR 69). Deliberately opaque:
 *
 *   - `class`   — the payload class discriminator. `"elicit"` is the one
 *                 implemented consumer; future riders add their own
 *                 (`"sampling"`, `"permission"`, …) without widening the
 *                 relay.
 *   - `request` — the class-specific request. For `"elicit"` this is a
 *                 spec `ElicitationRequest` (typed at the tasks/session
 *                 edges, opaque here). In-process (T1) the live schema
 *                 survives by reference; a cross-process hop (T2) projects
 *                 it to a wire schema at the boundary.
 *   - `lineage` — provenance path (origin → each hop), principal-stamped
 *                 per ADR 51. The field exists now; population is deferred
 *                 to T2 (the recursive session hop).
 */
export interface EscalationEnvelopePayload {
  readonly class: string;
  readonly request: unknown;
  readonly lineage?: readonly unknown[];
}

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
