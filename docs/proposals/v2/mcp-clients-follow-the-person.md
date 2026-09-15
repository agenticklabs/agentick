# MCP clients follow the person — the `mcp` client namespace at gateway scope, per-call principal

**Status: WORKSHOP DRAFT v1** — 2026-09-14, Ryan + Fable. Companion to
`SendInput.identity` (lane .213) and knowify's
`docs/ernesto-v2/PARTICIPANTS-AND-RELAY.md`. ⁇ marks open questions.

## 1. The problem

`withMCP` is a session-target extension. At install it builds one client
harness per server, calls the transport factory ONCE with
`installer.principal` (the session's owner), and registers that connection's
tools into the session. Every tool call on that session rides that connection,
whoever initiated the turn. In a multi-participant session this is the confused
deputy: a staff reply's execution now runs AS the staff member
(`ctx.principal`, lane .213), but a `knowify__*` call still acts as the owner.

Three facts make the fix small:

- Credentials are already first-class here. `DefaultOAuthProvider` reads and
  writes tokens through the `credentials` namespace; `withMCP` resolves that
  namespace by proximity and hands it to every transport factory.
- The DEFAULT credential key is `(serverId, field)` — no subject. Tokens are per
  server, not per person, unless the adopter composes a principal into
  `credentialKey`.
- The MCP package augments the gateway only for the SERVER role
  (`GatewayExtensions.mcpServers`). The client role is `HookBridges.mcp`,
  registered per session, with no top-level config slot (ADR 93 says every
  namespace gets one).

## 2. Principles

1. **The agent's identity is a ceiling.** The session's own connection is the
   agent's; an execution acts as its one initiator, intersected with that
   ceiling. Never max-of-participants, never per-initiator escalation.
2. **Credentials are per person** (ADR 107: namespace = audience, key = subject).
   "Authenticate once, use in any session" is the token layer's shape already;
   the default key just has to say so.
3. **A connection is an implementation detail.** An entry is a PERSON'S VIEW OF
   A SERVER: credential + cached snapshots + an OPTIONAL live channel. Stateless
   servers have no channel. The model must not depend on holding sockets.
4. **No session-level slot** (ADR 107 §1, verbatim reasoning): the per-principal
   axis is handled PER CALL by `ctx.principal`, not by per-session registries.
5. **The tool list is stable across turns** (prompt cache). Per-turn variation
   is dispatch ROUTING, not list churn.

## 3. Design

### 3.1 The credential key gains a subject

Default key becomes `(principal, serverId, field)`; adopters' `credentialKey`
override stays. ⁇ Room for an ACCOUNT label — one person, two accounts on one
server — as a fourth dimension with a per-(principal, server) default chosen as
a session knob; not built until someone has two accounts.

Landmine: existing tokens stored under `(serverId, field)` orphan on upgrade.
Defusal: read falls back to the old key once and re-saves under the new one.

### 3.2 `mcp` becomes a both-levels, one-harness namespace

Exactly credentials' shape (ADR 107 §1):

```ts
createGateway({ mcp: [knowifyServer(), linear()] });   // constructs the harness
createApp({ mcp: [notes()] });                          // contributes into the inherited one
withMCP({ servers: [...] })                              // same contribution, extension form
```

- Gateway constructs; an app-level slot REGISTERS INTO the inherited namespace,
  or constructs locally when there is no gateway (the local-agent case).
- Cross-level collision on a server id is a construction-time ERROR, never a
  cascade (a silently intercepted tool connection is a security bug, not a
  quality bug).
- ADR 42 forms: definitions | live instance; `use:` escape hatch; `filter:`
  per-connection visibility. Read getter `gateway.mcp` (noun); `HookBridges.mcp`
  stays as the per-app bridge over the inherited instance. Gateway-constructed
  ⇒ gateway-closed.

### 3.3 Entries keyed `(principal, serverId)`

Inside the harness, one entry per person per server:

| holds                                              | note                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| credential handle                                  | via the credentials namespace, key from §3.1                                   |
| snapshots: tools, resources, prompts, capabilities | filled by one `list` on first use; invalidated by `list_changed`; TTL backstop |
| live channel (stateful servers only)               | absent for stateless; opened lazily on first call, reconnect FSM as today      |
| last-used, in-flight count                         | for reaping                                                                    |

Reaping, three triggers, never "never": idle TTL after in-flight hits zero;
credential loss (revoked / unauthorized); hard cap with LRU. Gauged and logged
like session residency. `EventScopeExtensions.mcpConnectionId` keeps its name;
its id space becomes `(principal, serverId)`.

### 3.4 Per-call principal — no attach, no detach

Every harness operation takes the operation context:
`callTool(serverId, name, args, ctx)` selects the entry for `ctx.principal`.

- **Sessions register nothing per principal.** At install `withMCP` registers one
  handler per server tool, principal-agnostic: `(input, { ctx }) =>
mcp.callTool(serverId, name, input, ctx)`. The session's tool registry does
  exactly what it does today.
- **Declarations.** The session's own principal's, listed at install (today's
  behaviour). An INITIATOR's arrive on `send.tools` from a before-send reshape
  (`onBeforeSessionSend` may return a reshaped input), read from that
  principal's cached snapshot. App policy decides the list: the union of
  participants' tools is the recommended default (stable prefix); dispatch is
  routed by `ctx.principal` regardless. A tool the initiator's entry does not
  expose fails at the server and returns an `isError` envelope — fail closed.
- The dispatch ctx carries the initiator (lane .213). `readContext()` is EMPTY
  inside Effect fibers (ADR 45), so the principal must ride the op's own ctx,
  never an ambient read.

### 3.4a Tool-list stability — the list is not the authority (Ryan, 2026-09-15)

Two things were being asked of one list: authority must vary per execution;
the model's picture of its capabilities must not. Registering around the
execution serves the first and must not decide the second.

- **Same declarations every turn.** `send.tools` is per execution but the app
  passes the same union of participants' tools each time; handlers are
  principal-agnostic and ROUTE by the initiator. Per execution only what WORKS
  changes, never what EXISTS: no prefix churn, no tool that vanishes between
  turns. It may refuse — a different, legible event.
- **Ownership on the declaration.** Each union entry names who provides it
  (owner / account label on `group` or metadata, beside the existing group +
  summary), so the model reads "Linear, via Alice" on Bob's turn BEFORE calling;
  the dispatch error says the same words after.
- **The asker block.** A per-turn "this turn acts as Bob, with Bob's tools"
  prompt block (knowify's Current User rework) is the load-bearing half: it
  ties refusal, owner label and last turn's result into one story.
- **Tool search** ranks tools usable by the current asker first without hiding
  the rest; big rooms do not swamp the prompt.

Residual, NOT solved by lists: the same tool name is a different world per
person (Alice's `linear__list_issues` ≠ Bob's) — a result from Alice's turn is
valid data on Bob's, re-running it as Bob answers a different question. The
labels give the model what it needs; whether it reasons correctly is an
evaluation question once a real room exists. Membership changes churn the union
once each — the honest moment for the prefix to change.

### 3.4b Attribution of tool calls and results (Ryan, 2026-09-15)

"On whose behalf" is a JOIN, not a new stamp: every call and result belongs
to an execution, every execution has one principal (scope + knowify's
`executions.principal`). The app's JSX timeline renders it as an attribute on
the tool-call / tool-result tag (`as="Bob"`, principal → actor display name),
the way user messages already carry who + via. Not a content block: the
result's bytes stay unchanged, 1:1 sessions render nothing, and it is a
stable historical fact (no prefix churn). Framework contributes nothing here.

### 3.4c The dispatch guard — a tool executor seam

The tool-dispatch analog of arena's session-operation guard, in the house
guard vocabulary:

```ts
authorizeDispatch?: (input: {
  declaration: ToolDeclaration; principal?: string; ctx: ToolHandlerCtx;
}) => Verdict;   // proceed | veto(reason) — default proceed
```

A veto is rendered as an `isError` envelope carrying the reason (and the owner
label, so "Linear is connected for Alice, not for you" writes itself). The app
supplies the policy: for MCP tools a snapshot lookup (does this principal have
an entry for this server) BEFORE any network call; host tools answer from the
adopter's own permission model. Neither the before-hook (reshape only) nor the
confirmation policy (ask only) can say no, which is why this is a seam and not
a hook. Properties:

- Two layers may both refuse: the guard is the cheap explainable answer, the
  port is the authority; they use the same words.
- Nested dispatch inherits the caller's ctx (fixed), program bindings go
  through dispatch, client-handled tools dispatch too — one gate, no bypass.
- Visibility ≠ viability: tool search shows what exists (ranked by usability),
  the guard decides what runs.

### 3.5 Auth: two doors, one store

- **In-turn** (exists): a call fails unauthorized → the transport factory's
  `elicit` asks, in the conversation, the INITIATOR (now the right person).
- **Out-of-turn** (new): gateway-scoped wire rows keyed by the caller's
  principal, house naming `namespace/verb_snake`:
  `mcp/list_servers`, `mcp/connect_server` (returns the URL-elicitation shape
  the client already speaks), `mcp/disconnect_server`. No `sessionId` param.
- Both write the same credential key; either path satisfies the other. The
  existing session-scoped rows (`mcp/list_tools`, tasks) are unchanged.

### 3.6 Executions, steering, proactive turns (unchanged rules, restated)

One initiator per execution. Steer only by the initiator (compare
`record.currentExecutionActor` to the inbound identity), others queue;
steering adds content, never authority. A proactive turn runs as the agent's
own identity with the agent's own entries — deliberately small (read + speak).

### 3.7 The in-process server (knowify)

Authenticates per connection today. One in-process entry per principal is
cheap; no special case. ⁇ Per-request credential on the in-process transport
later, which would make it behave as a stateless server under §3.3.

## 4. What does not change

`withMCP({ servers })` for adopters; server definitions; the session tool
registry; the session-scoped `mcp/*` wire rows; the OAuth flow and its
elicitation; `HookBridges.mcp`; `mcpServers` (server role) — untouched.

## 5. Rollout

1. **Key default gains the subject** + old-key fallback. Standalone value:
   tokens follow the person for every current adopter.
2. **Namespace hoist**: harness with `(principal, serverId)` entries, both-level
   slot, per-call selection, reaping, gauges. Conformance suite (the bulk).
3. **Wire rows** (§3.5) and the `authorizeDispatch` seam (§3.4c).
4. **Before-send reshape** for initiator declarations — app policy; lives in
   knowify first, hoists when a second adopter wants it.
5. Knowify: server config moves from the app's `withMCP` list to
   `createGateway({ mcp })`; its transport factory (principal → kauth) is
   unchanged. Lane publish.

## 6. Verification

- Conformance: both-levels construction; collision error; app-only local
  construction; per-call selection (two principals in one session hit two
  entries, one server); stateless entry has no channel; reaping on TTL, on
  credential loss, at cap; gauges present.
- Old-key fallback test for §3.1.
- Wire rows: principal-scoped; a caller cannot list or disconnect another's.
- Regression: unmodified 1:1 composition with the new default key is
  byte-identical except the key string.

## 7. Open (⁇)

Account label dimension; per-request credential for the in-process server;
reaping defaults (TTL, cap); whether the union tool list should hide names of
servers the initiator lacks (privacy of "who has what" in a room).
