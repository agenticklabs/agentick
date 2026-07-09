# ADR 69 — Substrate request escalation: chain-of-responsibility over the ownership inbox

**Status:** PROPOSED 2026-07-08 (Fable, for Ryan — mechanism ratified in design; tiers + first
consumer below). **Builds on:** ADR 31 (self-similar slottable harness hierarchy — the `parent`
ref + composable inbox), ADR 51 (declared commands — provenance / principal stamping), ADR 68
(persistent tasks — the `awaitingInput` origin seam + `input_required` FSM state), the addressable
inbox request/response substrate. **First consumer:** elicitation-over-tasks (this ADR). **Free
future riders:** sampling, permission/authorization, resource/credential requests, error escalation.

## TL;DR

A nested unit of work — a **task** or a **sub-agent session**, arbitrarily deep — sometimes needs
something only an ancestor (ultimately the connected human **client**) can provide: an
**elicitation** answer today; a sampling completion, a permission grant, a held credential, an
unhandleable error tomorrow. Today elicitation is **session-scoped and tick-tied** (sugar over a
per-request `elicitation/create` on the live client connection), so a background task or a
sub-agent has no way to reach the client, and each future concern would reinvent the same relay.

**Decision: make "escalate a request up the ownership chain until handled" an innate, opt-in
capability of the substrate inbox** — a thin forwarding discipline on the inbox's *existing*
addressed request/response. A blocked node publishes a tagged **escalation envelope** to its
**escalation-parent**'s inbox; each hop's local handler either **resolves** it (answer / deny /
transform — "interception") or **forwards** it to *its own* escalation-parent; the **root**
(no escalation-parent) resolves it terminally (the real client `elicitation/create`, or a policy
→ deny/timeout); the response routes back to the **origin** to unblock it. Chain of responsibility
as an inbox primitive — composed from what's already there, payload-agnostic. Elicitation-over-tasks
is the one implemented consumer; the others ride the same rails for free.

## The problem

- **Elicitation can't leave its session or its tick.** `ElicitationHarness` is per-session
  (`elicitation:${sessionId}:elicitation`); `ctx.elicit` is sugar over a per-request server→client
  `elicitation/create` issued *during a live call*. A task that has outlived its tick, or a
  sub-agent whose "client" is really its *spawner*, has nothing to elicit through.
- **`input_required` + elicitation are disconnected** (ADR 68): nothing attaches an elicitation
  request to a nested unit, routes it toward the client, or routes the answer back.
- **The pattern is payload-agnostic and recurs.** Sampling, permission, resource, and error
  escalation are the *same* relay with a different payload + terminal. Embedding the relay in the
  elicitation harness would force every other concern to duplicate it or reach through elicitation.

## Decision

### The mechanism — nested `inbox.ask`, nothing more

The inbox already supports `ask()` — RPC-shaped send-and-await-typed-response, where the
recipient's handler **return value IS the response**, correlated + `messageId`-idempotent +
Effect-fiber-interruptible (`runtime/src/substrate/local-inbox.ts`). Escalation is **nested
`ask`** — the `ask` return-value stack *is* the relay AND the return path; there is no separate
envelope-forwarding machinery and no origin-reply-address to thread:

1. A blocked node **`ask`s its escalation-parent**, passing an opaque escalation payload.
2. The receiving harness's **escalation handler** returns one of:
   - a **resolution** — it handled it (answered / denied / transformed-then-answered). This is
     **interception**; it needs no machinery beyond "the handler returned a value."
   - **`yield* inbox.ask(myEscalationParent, payload)`** (the default) — forward one hop; the
     parent's eventual response propagates back down through this `ask`'s return.
3. The **root** harness (no escalation-parent) resolves **terminally**: for elicitation, the real
   client `elicitation/create` over the wire; absent a willing client, a root **policy** (deny /
   timeout).
4. The response threads back down the nested-`ask` return stack to the origin, whose
   `awaitingInput` (ADR 68) resolves. Correlation, idempotency, and **interruptibility** (an origin
   cancel/ttl interrupts the whole chain via `Fiber.join`) are the primitive's, not ours.

Interception is **default-off**: a harness with no handler for a payload class just forwards. With
no ancestor intercepting, the chain **behaves like direct-to-client**, preserving only the *seam*.
(See §Bubble vs direct.)

**Timeout.** `ask` defaults to 30s — wrong for a human-in-the-loop elicit. Escalation asks use a
long/unbounded timeout governed by the origin's `ttl`/cancel, not a 30s spurious failure.

**Runtime boundary.** Nested `ask` works **within one runtime** (`LocalInbox` is an in-process
fiber registry). A **forked child** task has a *separate* inbox — so T1 (in-process) is trivial
nested-`ask`, and the **cross-process child** case (T2) needs an IPC bridge from the child's
escalation origin to the parent's inbox. A `ClusterInbox` extends the same `ask` across nodes (T3).

### The escalation edge is the spawn lineage, NOT the structural parent — load-bearing

ADR 31's structural hierarchy is `Gateway→App→Session`; a spawned sub-agent session's structural
`parent` is the **App**. Its **escalation** parent is its **spawner** — the `parentSessionId`
already stamped on spawn (`session/harness.ts:677 parentSessionId: this.store.id`). So the
substrate primitive carries an **explicit escalation-parent address** — `session:${parentSessionId}`
for a spawned session, **absent (terminal)** at a root session — *distinct from* `parent`.
Escalating up the structural `parent` would route to the App, not the spawning agent; that is the
single detail that must be right.

An escalation-parent address (not a live handle) is what makes this work across a **process
boundary** (a forked child task) and a **cluster node** (a sub-agent on another node) — the inbox
is addressable and cluster-portable; a live callback is neither.

### The origin seam

- **Tasks** originate via ADR 68's `ctx.awaitingInput(promise, opts?)` — the wrapper flips
  `working → input_required → working`; underneath, "the promise" is an escalation round-trip
  entering at the task's **owning session** (`record.scope.sessionId`).
- **Sessions** (sub-agents) originate an escalation directly to `session:${parentSessionId}`.
- After the leaf hop (task→session), it is **pure session-level bubbling** — one recursive edge
  (`session → parentSessionId → … → root`), so sub-agent-of-a-sub-agent falls out for free.

### `interactive ⊥ detached` — the invariant the mechanism forces

Escalation requires a **live** ancestor chain (an inbox that is there, listening). Therefore:

- A **`detached: true`** task (ADR 68) has no guaranteed live parent → it **cannot escalate**.
  `awaitingInput` on a detached task is a **typed error**, not a silent hang against a dead inbox.
- An **interactive** task (any that may `awaitingInput`) is **session-bound** — its session is its
  lifeline to the client; it must not outlive it.

"Tasks that outlive their session" is thus a *narrow* mode: fire-and-forget, **non-interactive**,
durable-result work (kick off, disconnect, read the persisted result later). Real, but minor — the
centerpiece is the live relay chain. A dead intermediate ancestor is **transparently skipped**
(it can't intercept — correct, it's gone); the request continues up the persisted lineage to the
nearest live ancestor / root. This is why the lineage must be **durable** (`parentSessionId`
persisted), not held in live objects — tying straight back to ADR 68's durable store.

### Bubble vs direct

Bubble-up is the **semantic superset**; direct-to-client is the degenerate case where every hop
forwards blindly. Bubbling is strictly more powerful — an ancestor can **answer** (it set up the
child's task and knows), **dedupe/batch** (10 sub-agents asking the same thing → answer once),
**deny/rate-limit** (a rogue descendant eliciting credentials), and **contextualize** before the
human sees anything. **Default: bubble.** Cluster addressability *enables* a **direct-delivery
optimization** — when the substrate can prove no ancestor has a handler registered for the payload
class, collapse the hops and deliver straight to the client. Optimization, not model.

### Provenance + authority (governance rides the chain)

The escalation envelope accumulates its **lineage path** (origin → each hop), principal-stamped per
ADR 51 — the human sees *who* is asking through *what* authorized chain. Any hop may **deny or
rate-limit** a descendant; only the addressed principal (or a hop with delegated authority)
resolves. Chain of responsibility gives this for free — a node refusing is just `resolve(deny)`.

## First consumer + future riders

- **Implemented now: elicitation-over-tasks.** Terminal resolution = the existing
  `ElicitationHarness` client `elicitation/create`. Elicitation **generalizes** — it stops being
  "session-scoped direct-to-client sugar" and becomes the **terminal hop** of the escalation
  primitive; the same elicit, with intercepting hops in front of it. `input_required` is the
  origin's FSM state while its escalation is in flight.
- **Free future riders (enabled, not built): sampling** (escalate a completion to an ancestor that
  can run the model), **permission/authorization**, **resource/credential requests** (note:
  credentials never cross the wire — the *request* escalates; the credential stays server-side),
  **error escalation**. Each is a payload class + a terminal resolver; the relay is shared.

## Tiers (build order)

- **T1 — root-session task → client.** A task in a *root* session (connected client) escalates to
  its owning session, which is the root, which performs the real `elicitation/create`. No
  cross-session hop. The 80% "background task asks the human" case + the `awaitingInput` wiring to
  a real terminal. Plus the `interactive ⊥ detached` guard.
- **T2 — the recursive hop + the process boundary.** Cross-session bubbling
  (`session → parentSessionId`), and the **cross-process child** elicit bridge (a forked task's
  escalation over IPC → parent → the session escalation entry). This is where sub-agent input
  works and where the chain becomes real.
- **T3 — durable / cluster / cross-node.** Dead-ancestor skip over persisted lineage,
  cross-node escalation-parent addressing (cluster), and the direct-delivery optimization. Folds
  into the distributed-executor tier.

## Rejected

- **Elicitation-specific relay (in the elicitation harness).** Every other concern (sampling,
  permission, …) would duplicate it or reach through elicitation. The relay is payload-agnostic →
  substrate.
- **Direct-to-client only (no chain).** Throws away the entire value of a hierarchy — no ancestor
  interception, dedupe, denial, or provenance. Direct is the degenerate case, kept only as an
  optimization.
- **Escalating up the structural `parent` (ADR 31).** A spawned session's structural parent is the
  App; escalating there routes to the wrong node. The escalation edge is `parentSessionId`.
- **A policy engine / rules DSL for interception.** Over-built. Interception is "the local handler
  chose to reply." A handler is code; that's enough.
- **Live-handle callbacks for the relay.** Can't cross a process/cluster boundary. Inbox-addressed
  escalation-parent is the robust mechanism; the downward handle stays a control ref (cancel/await).
- **Letting a detached task elicit.** No live chain → a silent hang. Made a typed error; `detached`
  means non-interactive.
- **A bespoke escalation envelope + manual origin-reply-address threading across hops.** The first
  draft of this ADR did this; it's redundant. Nested `inbox.ask` already composes the recursion
  AND the return path — the `ask` return-value stack is the reply route. Deleted.

## Open questions

- **MCP wire verb for a client supplying input to an `input_required` task.** MCP's task+elicitation
  interplay is bleeding-edge; we may **define** an agentick-native verb with an MCP projection where
  the spec allows, rather than implement a settled one. (Terminal resolution over the *local* client
  transport is unblocked regardless.)
- **The escalation-parent configuration API** on the harness — likely a substrate field set from
  `parentSessionId` at construction; confirm shape against ADR 31's factory/parent wiring.
- **Root terminal policy** when no client is willing/capable (deny vs timeout vs queue) — a root
  default with an adopter override.

## Build scope (T1 → one build)

1. Substrate: the escalation envelope + inbox forwarding discipline (forward-on-unhandled,
   origin-reply preserved) + the explicit escalation-parent address on the harness.
2. Elicitation as terminal resolver at the root; `awaitingInput` wired to originate an escalation
   (replacing the placeholder promise) at the task's owning session.
3. The `interactive ⊥ detached` guard (typed error).
4. Tests: a root-session task escalates → the session's terminal elicit resolver answers → the
   task's `awaitingInput` resolves + FSM flips `working → input_required → working`; detached +
   `awaitingInput` → typed error; an ancestor **interception** (handler answers instead of
   forwarding) short-circuits before the terminal.
Deferred (seam-ready): T2 (recursive hop + child IPC bridge), T3 (durable/cluster + direct
optimization), the non-elicitation payload classes.
