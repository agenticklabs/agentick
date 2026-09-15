# Owner, actor, author, address — identity in agentick, now and for multi-participant sessions

**Status: WORKSHOP DRAFT v1** — 2026-09-15, Ryan + Fable. §3.2a BUILT on feat/v2 (2026-09-15). The architectural
statement behind `SendInput.identity` (lane .213), `mcp-clients-follow-the-person.md`,
and knowify's `PARTICIPANTS-AND-RELAY.md`. Goal: see the current model, see the
proposed one, and PROVE that the single-user session is unchanged while the
multi-participant cases become expressible. ⁇ marks open questions.

## 0. Summary

The framework has one word, `principal`, doing four jobs. In a 1:1 session the
four values coincide, so one word sufficed and the code got it right for free.
A multi-participant session separates them. The proposal names the four —
**owner, actor, author, address** — gives each a home, derives the rules from
them, and pins conservation: with no identity on a send, every new field
defaults from the old one and the 1:1 composition behaves byte-identically.

## 1. The current model (from the code and ADRs 45, 48, 51, 100, 104, 107)

| identity fact               | where it lives today                                                                                                                                                                                                                                                                              | who sets it                                                                                                                                                            | who reads it                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **session owner**           | `SessionHarness.principal` (construction-bound, ADR 48); `SessionRecord.principal`; `EventScope.principal` stamped by `BaseHarness` "not per-operation" (ADR 45); `StoreCtx.principal` threaded by every bridge                                                                                   | `app/create_session` from the wire caller (`ctx.principal`), the connector `as()` door (ADR 100), spawn (inherits)                                                     | wire target rule — caller must equal owner (ADR 51 §4.2; authorizer pluggable, default owner-only); store tenancy + attribution; subscriptions |
| **acting principal**        | (lane .213) `SendInput.identity` → execution scope `principal` → `ctx.principal` in loop, model, tools, stores under the run; `SessionRecord.currentExecutionPrincipal` when ≠ owner. **Superseded by §3.2a**: `EventScope.actor`, `principal` restored to the owner, `currentExecutionActor`     | wire `session/send` from the caller; connectors from `InboundMessage.identity`; in-process callers; spawn child's first send inherits; `resumeExecution` reads it back | everything that reads `ctx.principal` — before .213 this was ALWAYS the owner                                                                  |
| **ingress identity**        | `IngressIdentity { principal, user, scopes }` on wire dispatch and connector inbound; `RuntimeContextUser` (ADR 45) = "the authenticated actor a piece of work runs on behalf of", an EMPTY SEED the connector path never filled (#302 TODO)                                                      | transport auth / connector author                                                                                                                                      | the `as()` door (creates the session AS the identity), authorizer, adopter wire hooks                                                          |
| **provenance**              | `MessageSource` under `message.metadata.source` — "provenance, NOT identity", unauthenticated transport coordinates                                                                                                                                                                               | connectors, per inbound                                                                                                                                                | app renderers (`via`)                                                                                                                          |
| **address**                 | execution carries `connectionId` / `clientId` ("the tab that asked"); connectors route `stream(turn)` by `turn.origin.source`; **elicitation is addressed by SESSION** — the bus event's `scope.sessionId`; the wire client subscribes; a connector answers for sessions in its `managedSessions` | wire boundary / connectors harness                                                                                                                                     | tool relay, elicitation, delivery                                                                                                              |
| **credentials**             | gateway (+app) `credentials` namespace, `namespace` = audience, key = subject (ADR 107)                                                                                                                                                                                                           | providers                                                                                                                                                              | ports, `DefaultOAuthProvider` (MCP default key `(serverId, field)` — no subject)                                                               |
| **per-principal resources** | MCP client harness per SESSION per server, transport factory called once at install with `installer.principal`; sandbox per session; OAuth provider per client                                                                                                                                    | `withMCP`, session extensions                                                                                                                                          | tool handlers                                                                                                                                  |
| **tools**                   | session registry (`tool:register`) + execution-scoped `send.tools` (declarations; handlers resolve on the session); `ToolConfirmationPolicy` can ASK; before-hooks can RESHAPE; nothing can REFUSE except op middleware                                                                           | app / extensions                                                                                                                                                       | dispatch                                                                                                                                       |
| **timeline**                | one shared log per session; entry `visibility` model / internal / log; `internal` per SESSION or per EXECUTION (`send.internal`), never per block                                                                                                                                                 | session                                                                                                                                                                | compiler, clients, stores                                                                                                                      |
| **connectors**              | gateway built-in at the TRUSTED POLE (ADR 104): route to any session by id, bypass the wire gate                                                                                                                                                                                                  | adopter                                                                                                                                                                | —                                                                                                                                              |

**The law that made one word enough** (ADR 45 §"structural identity", ADR 48
§1): a principal is a scope key fixed at construction; per-principal resources
encode the principal in their identity — "different principal → different
instance"; nothing reads principal from ambient context. In a 1:1 session
owner = actor = author = address, so the scope key WAS the actor and every rule
above was correct.

## 2. Where it breaks — three traces on the current model (post-.213)

**A. A staff reply (Slack) into a customer's session.** Owner `200:100`,
actor `1:7`. The execution's `ctx.principal` is the staff member's (correct) —
but: the Knowify MCP connection was opened at install with the OWNER's kauth
→ every `knowify__*` call acts as the owner; knowledge writes resolve the
author by `sessionId` → the owner (a cross-tenant write, as the customer);
`StoreCtx.principal` is the owner (correct for tenancy, silent for attribution);
an elicitation raised in this turn goes to the customer's browser AND the
Slack thread (both "own" the session), and the standing grant records whoever
answered; usage/cost aggregate onto the customer's session; the reply is
visible (intended) but so is every tool result the staff turn produced.

**B. A second human in a browser.** Cannot `session/send` at all: the same-
principal target rule refuses. No membership seam exists to admit them.

**C. The relay (support session → customer session).** Connectors run at the
trusted pole, so any connector can send into any session; the relay's own
`authorize` hook is the only gate. Entries the relayed turn appends carry no
author; `internal` can hide the whole execution, not "speech visible, results
hidden".

None of these are bugs in any one place. They are the four identities being
read off one field.

## 3. The proposed model — four identities, four homes

### 3.1 Owner — the session's scope key (unchanged)

`session.principal`, construction-bound, ADR 48 as is. **State lives here**:
timeline, knobs, state, the tenancy of every persisted row, subscriptions.
Gate input for the wire, extended by the **session-operation guard**
(arena §3.2): `authorizeSessionOp({ principal, sessionId, verb, record }) →
proceed | veto`, default = owner-only, i.e. today. Membership is APP data the
guard consults; the framework has no room concept.

### 3.2 Actor — per execution (landed in .213, extended)

`send.identity` → the execution's principal. Applying ADR 45's own rule at
execution grain: **every per-principal resource is keyed by the actor, every
session-scoped resource by the owner.**

- `ctx.principal` = actor under the run (done). `StoreCtx` gains `actor?`
  beside `principal` (owner): tenancy by owner, attribution by actor; absent
  actor ⇒ owner (1:1 unchanged).
- Credentials: default key subject = actor (`mcp-clients-follow-the-person.md`
  §3.1). Per-principal resources (MCP entries, sandbox runtimes, OAuth) keyed
  by actor, selected PER CALL — no per-session actor registries (ADR 107 §1).
- Persisted on the record (`currentExecutionActor`, done) and on the
  execution's durable boundary entry (⁇ so the timeline alone can answer "who
  ran this turn" without the record).
- Spawn inherits (done). Resume reads (done) — and must also rebuild the
  execution-scoped tool declarations (§6, F11).

### 3.2a Code: `actor` on the trunk — the additive first step

**Cascade is already there.** The operation runner's `inheritScope` copies
every ambient trunk key into a child op except `opId`, `parentOpId`,
`correlationId`, `op`, `origin` — and the op's own declared scope wins on
collision. `deriveContext` copies the parent trunk into every boundary ctx
(tool handler, hook, middleware, model). So a key stamped ONCE on the
execution's root scope reaches every nested op and every derived ctx with no
factory touched. The loop's explicit `principal` spreads stay as they are and
are simply no longer load-bearing for the actor. The one place the cascade does
not reach is the bridges' `storeCtx()`, built from the harness at construction
— by design for tenancy, and the one site that needs a line.

**1. spec — `EventScope.actor`** (`packages/spec/src/data/events.ts`, beside `principal`):

```ts
  /**
   * The ACTING identity for this operation and everything nested under it —
   * who the work is FOR. Twin of `principal` (the construction-bound scope key:
   * whose session, whose tenancy) and DISTINCT from it: a turn sent AS someone
   * other than the owner sets `actor` at the execution's root scope and every
   * nested op inherits it (`inheritScope`). Absent ⇒ the owner: readers treat
   * `actor ?? principal` as the acting identity, so a 1:1 session carries no
   * `actor` at all and its envelopes are unchanged. Set only at boundaries the
   * framework owns (the session's execution root, the identity doors) — never
   * by an op's own scope factory.
   */
  readonly actor?: string;
```

`RuntimeContext extends EventScope`, so `ctx.actor` exists on every handler,
hook, middleware and store-write ctx with no further declaration.

**2. session — stamp at the execution root, restore `principal` to the owner**
(`packages/session/src/harness.ts`, the run scope — replaces the .213 override):

```ts
  ...pick(input, ["connectionId", "clientId"]),
  // ADR 48 — the owner stays the scope key on every envelope under this run.
  ...omitUndefined({ principal: this.principal }),
  // The acting identity, only when it is someone else: a 1:1 turn stamps
  // nothing, so its envelopes are byte-identical to before.
  ...omitUndefined({
    actor:
      input.identity?.principal !== undefined && input.identity.principal !== this.principal
        ? input.identity.principal
        : undefined,
  }),
```

Nothing else in the spine changes: loop, model and tool ops inherit `actor`
via the ambient scope; `ToolHandlerCtx` (built by `deriveContext` at the
dispatch site) carries it; `ctx.tools.dispatch` from inside a tool inherits it
(the nested-dispatch fix).

**3. stores — nothing to do.** `StoreCtx extends RuntimeContext extends
EventScope`, so `StoreCtx.actor` exists by declaration; and `BaseHarness.
storeCtxEffect()` already spreads the live ambient `RuntimeContext` over the
construction-bound `storeCtx()`, so every write-path store mutation under a
staff turn carries `actor` with no store code changed. The construction-bound
`storeCtx()` stays owner-only (tenancy). A tenant-scoped adapter keeps keying
rows by `principal`; an attributing adapter (knowify's executions row,
knowledge provenance) reads `actor ?? principal`.

**4. record + persistence — say what it is.** `SessionRecord.currentExecutionPrincipal`
→ `currentExecutionActor` (it IS the actor by this definition); `resumeExecution`
passes it as `identity.principal` as today. Knowify: `executions.principal` →
`executions.actor` while the migration is a day old and undeployed.

**5. the structured half.** `IngressIdentity.user` is the `RuntimeContextUser`
seed ADR 45 reserved ("the actor a piece of work runs on behalf of"). The same
root boundary attaches it as `ctx.user` via `deriveContext` extras — follow-up,
not part of the additive step.

**6. readers that switch, each one line at its site:** the credentials default
key subject (`actor ?? principal`); the MCP entry key; entry `author` stamps
(§3.3); knowify's standing-grants key and knowledge attribution
(`ctx.actor ?? ctx.principal`). Everything not switched keeps owner semantics —
safe by construction.

**Tests (extend `send-identity.spec`):** with no identity, no envelope and no
ctx under the run carries `actor` and `principal` is the owner everywhere
(byte-identical); with a staff identity, `principal` is STILL the owner on every
loop/model/tool envelope and `actor` is the staff principal on every nested op
and in the tool handler's ctx; spawn and resume carry `actor` the same way.

### 3.3 Author — per entry (new)

The session stamps the actor onto every entry an execution appends (assistant,
tool_use, tool_result) and the ingress identity's principal onto every inbound
message: `entry.metadata.author = <principal>`. `source` stays what it is,
provenance. Author is DURABLE and RENDERABLE with no join — the app's timeline
tag gains `as="Bob"` from it — and it is what makes "a result from Alice's turn
is valid data on Bob's turn, but re-running it as Bob is a different question"
visible to the model. In 1:1, author = owner on every entry; renderers may
elide it.

### 3.4 Address — per execution (new, generalizes what exists)

Where asks go and replies flow. The execution already carries `connectionId` /
`clientId` (wire) and connectors already route delivery by `turn.origin`. Make
it one field:

```
Address = { kind: "client";    clientId; connectionId? }
        | { kind: "connector"; name; origin }        // the inbound that started the turn
        | { kind: "member";    principal }           // resolved by the app's membership
```

Stamped by the wire boundary / connectors harness with the identity; carried
onto the execution like `connectionId` is today. **Elicitation routes to the
execution's address first**, the session's clients second — one more link at
the head of ADR 69's chain, not a new mechanism. The standing-grant record then
names the actor who actually answered (knowify already keys grants by actor).

### 3.5 Rules, derived

| rule                  | statement                                                                                                                                                                                                     | from          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R1 authority          | an act's authority = actor ∩ agent's own (the session connection is a ceiling, never a floor)                                                                                                                 | 3.2           |
| R2 speak-only default | a non-owner actor's execution may append speech and may NOT dispatch tools unless the app's dispatch policy allows it — `authorizeDispatch` (a guard with nicer inputs) defaults to veto when `actor ≠ owner` | 3.2 + guard   |
| R3 steer / abort      | the execution's actor OR the session's owner; anyone else queues (the owner override closes the filibuster)                                                                                                   | 3.1, 3.2      |
| R4 messaging          | a relay is admitted when same owner, or sender's actor is a participant of the target, or the sessions are linked (either direction) — the app answers, the relay's `authorize` asks                          | knowify doc   |
| R5 tool list          | the declarations a session sends are stable across turns (union of participants'); dispatch ROUTES by actor; ownership is on the declaration                                                                  | mcp doc §3.4a |
| R6 visibility         | a non-owner actor's execution is `internal` unless the app says otherwise; per-block visibility for tool results is the later refinement                                                                      | 3.3           |
| R7 cost               | usage/cost are attributable per execution by actor; the app decides which tenant pays                                                                                                                         | 3.2           |
| R8 membership         | app data (participants, links); the framework only exposes the guard seams                                                                                                                                    | 3.1           |
| R9 connectors         | a connector targeting a session it did not open passes the same session-operation guard as a wire caller — the trusted pole shrinks to "may create"                                                           | 3.1           |

## 4. Conservation — the single-user session is unchanged

For a session with owner `P` and no identity on any send:

| axis            | value                                                 | why                                                                    |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| owner           | `P`                                                   | construction-bound, untouched                                          |
| actor           | `P`                                                   | `send.identity` absent ⇒ execution principal = owner (I1, tested .213) |
| author          | `P` on every entry                                    | stamped from actor = `P`; 1:1 renderers elide                          |
| address         | the asking client                                     | exactly `connectionId`/`clientId` today                                |
| StoreCtx        | `principal = P`, `actor` absent                       | bridges unchanged                                                      |
| credentials key | `(P, server, field)`                                  | the subject is `P`; old-key fallback for stored tokens                 |
| MCP             | entry `(P, server)` — one, opened at install as today | per-call selection always finds the same entry                         |
| guard           | never consulted with `actor ≠ owner`                  | R2 is inert                                                            |
| elicitation     | the client                                            | address = client                                                       |
| wire gate       | owner-only                                            | `authorizeSessionOp` default                                           |

**Invariants and the tests that pin them**

| #   | invariant                                                                                                              | status                             |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| I1  | no identity on send ⇒ execution principal = owner; owner never changes                                                 | ✔ `send-identity.spec` (.213)      |
| I2  | spawn inherits the parent turn's actor; explicit wins; none ⇒ none                                                     | ✔ `.213`                           |
| I3  | resume re-drives as the actor; absent ⇒ owner; settle clears the slot                                                  | ✔ `.213`                           |
| I4  | `StoreCtx.principal` (tenancy) never changes with the actor                                                            | to build (F7)                      |
| I5  | every entry appended under an execution carries `author` = actor; inbound messages carry the ingress principal         | to build (F3)                      |
| I6  | an elicitation from an execution goes to that execution's address; no address ⇒ the session's clients (today)          | to build (F4)                      |
| I7  | `authorizeDispatch` vetoes a non-owner actor by default; owner turns never consult it                                  | to build (F5)                      |
| I8  | declarations sent per turn are identical across actors in union mode                                                   | app test (K5)                      |
| I9  | credentials resolve by actor; an old-key token is found once and re-saved                                              | to build (F8)                      |
| I10 | two actors in one session hit two MCP entries on one server; one actor across two sessions hits one                    | to build (F9)                      |
| I11 | a connector targeting a session it did not open is admitted only by the session-operation guard                        | to build (F6)                      |
| I0  | the unmodified 1:1 composition, with all of the above installed and unused, is byte-identical (transcript + envelopes) | conformance, the conservation test |

## 5. The three traces under the proposed model

**A. Staff reply into the customer's session.** owner `200:100`; actor `1:7`;
address `{connector: slack, origin: thread}`; author `1:7` on the note and on
the reply. R2: the turn speaks, dispatch vetoed with a reason the model relays.
R6: the execution is internal except its speech (⁇ or fully visible — app
choice). Cost: execution row says `1:7`; the app bills Knowify. Elicitation, if
any, goes to the Slack thread — the address — not the customer's browser.
Nothing touches the customer's data as the customer.

**B. A second human in a browser.** The app installs a membership policy on
`authorizeSessionOp`; Bob, a participant, may `session/send`; his turn's actor
is Bob, address his tab, author Bob on his entries. His tools (R5) are in the
union and route to his entries; Alice's refuse for him with her name in the
reason. Alice may abort Bob's turn (R3).

**C. The relay.** The support session's turn (owner + actor = support) calls
`send_message_to_session`; the relay connector's `authorize` asks the app (R4:
linked); the customer session runs an execution with actor = support, address
`{connector: relay, origin: support session}`, `internal: true`; the customer
agent answers by relaying back, symmetric; author = support on the relayed
message, author = the customer's agent on the answer.

## 6. Change inventory

Framework (agentick, feat/v2):

| id  | change                                                                                                                               | size   | status               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------- |
| F1  | `SendInput.identity`, execution principal = actor, wire + connector stamping                                                         | small  | ✔ .213               |
| F2  | `currentExecutionPrincipal`, spawn inherit, ephemeral stamp                                                                          | small  | ✔ .213               |
| F3  | author stamp on entries (`metadata.author`) from actor / ingress                                                                     | small  | —                    |
| F4  | `Address` on the execution; elicitation routes to it first (ADR 69 head link)                                                        | medium | —                    |
| F5  | `authorizeDispatch` seam in the tool executor; veto → `isError` envelope; default veto for `actor ≠ owner`                           | small  | —                    |
| F6  | `authorizeSessionOp` (arena §3.2) on wire session verbs AND connector targeting; default owner-only                                  | medium | —                    |
| F7  | `actor` on the trunk (§3.2a): `EventScope.actor`, root stamp, `principal` restored to owner, record rename (`currentExecutionActor`) | small  | ✔ feat/v2 2026-09-15 |
| F8  | credentials default key gains the subject; old-key fallback                                                                          | small  | —                    |
| F9  | `mcp` client namespace: both-level slot, entries `(actor, server)`, per-call selection, reaping, gauges, conformance                 | large  | —                    |
| F10 | per-block visibility for tool results                                                                                                | medium | later                |
| F11 | resume rebuilds execution-scoped tool declarations                                                                                   | small  | —                    |
| F12 | wire rows `mcp/list_servers`, `mcp/connect_server`, `mcp/disconnect_server`                                                          | small  | —                    |

App (knowify):

| id  | change                                                                                                                  | status        |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| K1  | actors, identities, participants, links; registrar                                                                      | ✔             |
| K2  | `executions.principal`; grants keyed by actor                                                                           | ✔             |
| K3  | Slack repliers → actors; inbound carries identity                                                                       | ✔             |
| K4  | host ports take the actor (`ctx.principal` / `StoreCtx.actor`) — knowledge attribution first                            | —             |
| K5  | asker block, rendered at the TAIL (stamp the message, not the timeline); union tool list with ownership on declarations | — (Ryan)      |
| K6  | `as="…"` on rendered tool tags from `author`                                                                            | —             |
| K7  | cost attribution per actor / tenant from the execution row                                                              | —             |
| K8  | the thread session (feedback, debug_info)                                                                               | —             |
| K9  | `send_message_to_session` over the relay                                                                                | after F-relay |
| K10 | membership policy behind `authorizeSessionOp` and `authorizeDispatch`                                                   | —             |

## 7. Sequencing — the speak-only cut

F5 with R2 makes K8 and K9 shippable on F1/F2 alone: no non-owner actor
dispatches a tool, so A's cross-tenant write, misrouted ask, leaked result and
misbilled cost cannot occur. Then, in order of what unlocks the most:

0. F7 (`actor` on the trunk) — additive, corrects the .213 overload, enables every later switch to be one line at its site.
1. F5 (guard, speak-only default) → K8 thread session → relay + K9.
2. F3 + F7 + F4 (author, StoreCtx.actor, address) → K6, K4 knowledge first.
3. F8 + F9 + F12 (credentials subject, `mcp` namespace, wire rows) → K5.
4. F6 (session-operation guard, connectors under it) → K10 → browser rooms.
5. F10, F11, K7 hardening.

Each step carries the conservation test (I0); nothing ships that changes a
1:1 transcript.

## 8. Proof plan

- **Conformance suite "identity"** in the session package: I0–I7, I9–I11
  as named tests; the 1:1 composition run twice, with and without every
  extension installed, transcripts and journal envelopes diffed.
- **Trace specs** A, B, C as acceptance tests over an in-process gateway with
  a connector probe and two principals.
- **Knowify**: participants + Slack identity specs (✔), grants per actor (✔),
  a staged room with two Slack repliers once F5/K8 land.

## 9. Open (⁇)

- Whether the author also rides the execution boundary entry so the timeline
  alone answers "who ran this turn".
- R6's default for staff replies: internal-except-speech vs fully visible.
- `Address.member` resolution: app-provided resolver vs a membership harness.
- Where the app's policies plug: one `policy` bag per guard, or the existing
  hooks bags on the session definition (ADR 93 guards on configs).
