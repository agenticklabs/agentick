/**
 * Substrate escalation protocol — contract types (ADR 69).
 *
 * "Escalate a request up the ownership chain until handled" is a thin
 * forwarding discipline over the inbox's *existing* addressed
 * request/response — nested `inbox.ask`, nothing more. A blocked node
 * (a task, a sub-agent session) `ask`s its **escalation-parent** with a
 * tagged envelope; each hop's handler either **resolves** it (answer /
 * deny / transform — *interception*) or **forwards** it one hop up via
 * another `inbox.ask`; the **root** (no escalation-parent) resolves it
 * terminally (the real client `elicitation/create`, a policy). The
 * response threads back down the nested-`ask` return stack to unblock
 * the origin.
 *
 * **Why these types live in spec, not the substrate package.** The
 * *wire constants* (`SESSION_ESCALATION_MESSAGE_TYPE`,
 * `ESCALATION_TIMEOUT_MS`) are genuine substrate — the addressing
 * convention + the ask bound — and stay in `@agentick/runtime-next`. The
 * *contract types* below, however, are referenced by
 * `SessionHarnessProtocol.interceptEscalation` (this file's sibling in
 * the spec protocol barrel). `runtime-next` depends on `spec-next`, so a
 * contract in runtime that the spec protocol referenced would be a
 * dependency cycle. The envelope + interception seam ARE the API
 * contract an adopter session impl implements — that is precisely what
 * spec owns. runtime re-exports these for its existing importers.
 *
 * These types stay **payload-agnostic** (ADR 69: "the relay is
 * payload-agnostic → substrate"). The envelope carries an opaque `class`
 * discriminator + an opaque `request`; the origin (tasks) and terminal
 * (session) narrow it. The single implemented class today is `"elicit"`;
 * sampling / permission / credential / error classes ride the same rails
 * later without touching this file.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */

/**
 * One entry in an escalation envelope's provenance path (ADR 69 §
 * "Provenance + authority"). The chain accumulates one hop per node it
 * traverses — origin → each forwarding hop — so the terminal resolver
 * (and any intercepting ancestor) sees *who* is asking through *what*
 * authorized chain.
 *
 *   - `scopeId`   — the node's addressable scope, always present. For a
 *                   session hop this is `"session:{sessionId}"` (matching
 *                   the inbox address the hop `ask`s).
 *   - `taskId`    — present on the **origin** entry only: the task that
 *                   originated the escalation. Forwarding session hops
 *                   omit it.
 *   - `principal` — best-effort owning principal (ADR 51). Populated when
 *                   the stamping harness has one in construction scope;
 *                   omitted for principal-less deployments.
 */
export interface EscalationHop {
  readonly scopeId: string;
  readonly taskId?: string;
  readonly principal?: string;
}

/**
 * Payload-agnostic escalation envelope (ADR 69). Deliberately opaque:
 *
 *   - `class`   — the payload class discriminator. `"elicit"` is the one
 *                 implemented consumer; future riders add their own
 *                 (`"sampling"`, `"permission"`, …) without widening the
 *                 relay.
 *   - `request` — the class-specific request. For `"elicit"` this is a
 *                 spec `ElicitationRequest` (typed at the tasks/session
 *                 edges, opaque here). In-process (T1/T2a) the live schema
 *                 survives by reference; a cross-process hop (T2b) projects
 *                 it to a wire schema at the boundary.
 *   - `lineage` — provenance path (origin → each hop), principal-stamped
 *                 per ADR 51. The origin (tasks) seeds the first entry
 *                 (owning session + task); each forwarding session hop
 *                 appends its own {@link EscalationHop} before forwarding.
 */
export interface EscalationEnvelopePayload {
  readonly class: string;
  readonly request: unknown;
  readonly lineage?: readonly EscalationHop[];
}

/**
 * Outcome an {@link EscalationInterceptor} returns to the hop that
 * consulted it (ADR 69: "interception = the local handler returns
 * instead of forwarding").
 *
 *   - `{ forward: false, response }` — **this hop answered**. The hop
 *     short-circuits: it returns `response` (for an `"elicit"` class this
 *     is an `ElicitationResult`) down the nested-`ask` return stack to
 *     the origin; the terminal / parent never sees the request.
 *   - `{ forward: true }` — **fall through**. The hop runs its existing
 *     forward-or-terminal logic (bubble one hop up, or resolve terminally
 *     at the root).
 *
 * A hard **deny** is an interceptor that THROWS — the throw propagates as
 * the escalation `ask`'s rejection, so the origin's `ctx.elicit` rejects.
 * Payload-agnostic by construction: the interceptor branches on
 * `payload.class` itself; there is no policy DSL or class-typed sugar
 * (ADR 69 rejects both — "a handler is code; that's enough").
 */
export type EscalationOutcome =
  | { readonly forward: false; readonly response: unknown }
  | { readonly forward: true };

/**
 * An ancestor hop's escalation handler (ADR 69). Consulted **first** by a
 * session's escalation hop, before the forward-or-terminal logic. Return
 * an {@link EscalationOutcome} to answer / fall through; throw to deny.
 * ONE interceptor per session is enough — it branches on `payload.class`
 * itself.
 */
export type EscalationInterceptor = (
  payload: EscalationEnvelopePayload,
) => Promise<EscalationOutcome>;
