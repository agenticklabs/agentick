# ADR 106 — User context (OPEN DRAFT — not decided)

**Status:** OPEN DRAFT, 2026-08-29 (Fable, for Ryan). **Nothing here is decided
and no code implementing it survives** — the implementation was written, argued
down three times in one day, and reverted. It is parked on `explore/user-context`
if any of it is wanted back.

**What IS settled:** the lane split. A credential cannot ride the journal, and
identity can. Every system surveyed below agrees, Temporal most sharply. §3's
model — the session belongs to the principal, the execution to the credential
that drove it — also held up under argument.

**What is NOT settled, and must be weighed FIRST:** whether the caller's
credential should be reachable from `ctx` by every tool at all. The
capability-security position says no, and it is the strongest argument anyone
made all day:

> Ambient authority is the confused-deputy bug. A tool that can read
> `ctx.user.token` can act as the user — and the thing choosing which tool to
> call is a language model following untrusted input. Go rejected
> goroutine-local storage for adjacent reasons and warns against credentials in
> `context.Value`; OpenTelemetry warns against secrets in Baggage; Effect's own
> doctrine prefers `Context.Tag` + `Layer` injection over `FiberRef` ambient
> state.

Which points at an alternative this draft does not develop: **keep `ctx.user` for
the non-secret working set (tenant, company, permissions, display name) and hand
the host a hook to construct its PORTS per execution with the credential closed
over.** The first adopter's existing `services.sms` — a host-bound port the tool
calls without ever seeing a token — is already that shape, and is closer to what
the literature recommends than what this draft would replace it with. Its real
wart was narrower than it looked: the credential was resolved from a
process-local `Map` with no framework hook, so it was unreachable, unrefreshable,
and inconsistent across five call sites.

Read the rest as an argued survey, not a decision.

## TL;DR

1. **One callback, for every door.** `authenticate(credential)` resolves
   `{ identity, user }`. The adopter writes it once; the wire, the `as()` door,
   and the local pole all funnel through it, because `IngressCredential` already
   discriminates them: `bearer` is a client, `platform` is a connector or an
   impersonation, `none` is the trusted host.
2. **Two lanes, named by what happens to them.** `identity` is WHO — journaled
   with every operation. `user` is what the work needs — the caller's live
   credential, their company, their permissions — and is never persisted.
3. **The session belongs to the principal; the execution belongs to the
   credential.** Any credential valid for the principal may drive the session,
   and the work runs under the one that drove it. Two clients with two equally
   valid tokens stop being a conflict to reconcile.
4. `ctx.user` **rides the facet channel, not the trunk** — same field, same type,
   same read sites, no longer journaled. `user` joins `NON_INHERITED_TRUNK_KEYS`
   so an adopter cannot put it back by hand.
5. **The framework carries only what it was given.** No fallback, no cache, no
   lazy resolution, no re-resolution. Nobody supplied a user context ⇒ `ctx.user`
   is undefined and the adopter's handler decides what that means. Whether that
   is expensive is the adopter's business.

## Context

### The user-visible symptom

A tool needs the caller's kAuth token to call an upstream API as them. In the first
adopter this takes **eight steps across five files**: cache the verified token in a
module-global `Map` keyed by principal at `authenticate()`; declare a port; add a
`principal: string | undefined` parameter to that port purely as a cache key; have
the tool launder `ctx.principal` into it; gate the tool on the port; implement the
service host-side; look the token back up out of the `Map`; wire the service.

The payload is one string that the inbound request was already holding.

The consequences are not cosmetic:

- The map is process-local and unbounded (its own `TODO(kauth-cache-eviction)` says
  so). A restart empties it; a second node never had it.
- Five call sites grew three different postures on a miss — two degrade gracefully,
  three throw. Nobody decided that.
- The failure surfaces at **call** time. The tool mounts, the model is told it can
  send a text, the model tries, and only then does it throw. Nothing at session
  creation knows the session has no credential.
- A session with no wire crossing — a connector-driven inbound SMS — can never have
  an entry, so the mechanism cannot be made to work there at all.
- v1 did this in one line: `ctx.user.token`.

### Why it got this bad

Every piece of the intended design already exists. Exactly one wire was never
connected.

- `AuthSource.authenticate()` — the adopter hook. **Exists.**
- It returns `IngressIdentity { principal, user, scopes }`, where `user` is
  documented verbatim as _"Adopter-shaped user record (RuntimeContextUser concern,
  ADR 34)"_. **Exists.**
- `RuntimeContextUser` — the empty-seed augmentation seam, whose doc example is
  `ctx.user?.tenantId`. **Exists.**
- `RuntimeContext.user?: RuntimeContextUser`. **Exists.**
- `EventScope.identity` — the journaled identity twin. **Exists and is stamped.**

**Nothing reads `identity.user`.** A grep across `gateway`, `session`, `app`, and
`transport-http` returns zero references. The adopter's `authenticate()` hands the
framework a user record and the framework drops it on the floor, which is why
`ctx.user` is permanently `undefined`, which is why the module-global `Map` exists.

### The one real constraint

`inheritScope` copies every enumerable trunk key onto each child operation's
`EventScope`, excluding only `opId` / `parentOpId` / `correlationId` / `op` /
`origin`. `EventScope` reaches the bus and the journal in full, with no allowlist.

So: **a credential on the trunk is a credential on disk, forever.** That is the ADR
92 redaction law, and it is the only essential complexity in this entire area. v1
was safe from it because ALS carried no journal-copy semantics; v2 is not.

Everything else an adopter currently has to know — that `ctx.user` is the persisted
lane despite its name, that the non-persisted lane is called "boundary facets", that
tool handlers were the one seam that never read them — is accidental.

### How this compares — the three mechanisms

Systems that solve this have three distinct mechanisms, not one, and it is worth
naming which of ours is which.

| job                                                            | prior art                                                                     | ours                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| **Establish** — stamp durable identifiers at a boundary        | Apollo `context`, tRPC `createContext`, Nest guards, Temporal workflow inputs | `AuthSource.authenticate` → `EventScope.identity` |
| **Propagate** — carry non-persisted context down the hierarchy | Orleans `RequestContext`, Temporal `Headers`, Effect `FiberRef`               | boundary facets (ADR 91)                          |
| **Own** — long-lived state belonging to the actor              | Akka actor state at init, Erlang `gen_server` loop state                      | the session's principal                           |

The JS lineage (Apollo, tRPC, Nest, Hono) assumes the unit of work IS the
request, which is the assumption that broke every earlier draft of this ADR: an
agentick session outlives the crossing that created it, and an execution outlives
the fiber that started it.

**Temporal is the closest analogue** and had our exact constraint — long-lived
durable execution whose history is replayed, plus credentials that must never
enter that history. Its answer is the split adopted here: history holds
identifiers; the live credential is resolved outside it and never written down.

## Decision

### 1. One callback

```ts
export interface Authenticated {
  readonly identity: IngressIdentity; // journaled with every operation
  readonly user?: RuntimeContextUser; // never persisted; reaches seams as ctx.user
}

export interface AuthSource {
  readonly backend: string;
  authenticate(credential: IngressCredential): Promise<Authenticated | IngressIdentity>;
}
```

The field names carry the rule, so nothing adopter-facing has to explain trunk
versus facet: `identity` is what the journal remembers, `user` is what the work
needs. Both are adopter-shaped — `identity.user` holds identifiers worth
recording durably (a company id an audit trail wants), `Authenticated.user` holds
the working set — and a credential belongs only in the second.

Returning a bare `IngressIdentity` means "identity only": `ctx.user` stays
undefined.

### 2. Three credential kinds are three doors, one function

`IngressCredential` (ADR 61) already discriminates every origin, so one callback
serves all of them:

```ts
authenticate(credential) {
  switch (credential.kind) {
    case "bearer":                       // a client over http / ws / unix
      return fromVerifiedToken(credential.token);
    case "platform":                     // a connector, or acting on someone's behalf
      return forPlatformUser(credential.platform, credential.platformUserId);
    case "none":                         // the trusted local pole
      return { identity: {} };
  }
}
```

This is what dissolves the crossing-less execution. An inbound SMS is not a hole
in the design — it is `{ kind: "platform", platform: "sms", platformUserId }`,
and what a channel session may act as becomes a branch the adopter writes.

An adopter who can mint a token for an impersonated user does so here. One who
cannot returns a context without one, and their tools branch on its absence. The
framework assumes neither.

### 3. The session belongs to the principal; the execution to the credential

The session is the actor: it is bound to a principal (ADR 48), durable, and
journaled. It holds **no credential** — a session idle for a week would be
sitting on a rotted token.

The execution carries the record of whoever drove it, for its whole run. So:

- Two clients, two equally valid tokens, one principal: each drives its own
  executions under its own credential. Nothing is shared, nothing needs a
  "current" winner.
- A long run keeps the credential it was launched under, which is the authority
  it was launched under, and does not break when that client disconnects.
- A second client's crossing disturbs nothing in flight.

Spawned children inherit the parent execution's record — the same authority
chain that principal inheritance already descends.

### 4. `ctx.user` changes lane

`ctx.user` keeps its name, type, and every read site; what changes is the channel
carrying it — the `BoundaryFacetsRef` extras channel (ADR 91) rather than the
trunk, which `inheritScope` copies onto every child's `EventScope` and thus into
the journal.

`user` also joins `NON_INHERITED_TRUNK_KEYS`. The framework never writes it to
the trunk, so the guard changes nothing on its own; it exists so an adopter who
sets `ctx.user` by hand still cannot leak a credential into the journal. A rule
the substrate enforces beats one a docblock asks for.

Every seam already reads boundary facets through `currentOperationCtx` — resource
resolvers, prompt `render`, completion handlers. Tool handlers were the one that
did not, which is why an MCP tool could read `ctx.mcp.user.token` and an ordinary
tool could read nothing; fixed independently.

### 5. Delivery rides the send

Two boundaries sit between a crossing and a tool handler, and neither can be
crossed by an ambient channel. The wire handler runs inside `Effect.tryPromise`,
so the session is entered from a Promise callback rather than the publishing
fiber; and `session.send` returns a handle while its execution continues on a
detached runtime. Both were measured.

So the record is PASSED, not inherited: `SendInput.userContext`, stamped
server-side by the `session/send` handler from the authenticated ctx — the
treatment `connectionId` already gets, and never read from client params. The
session wraps its execution in `withUserContext`, where a facet does survive.

The wire never lets a client reach the field; the trusted local pole fills it
directly.

### 6. `as()` is a stance, not a parameter

`as(who)` authorizes and attributes before it dispatches. It is the programmatic
equivalent of an authenticated crossing, which is exactly why wire params may
never carry a `principal` — that would be forgeable. So the three doors are three
TRUST POSTURES rather than three ways to pass a value:

| door                     | who vouches                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| wire                     | the transport authenticated a credential                             |
| `as(who)`                | the caller acts on another's behalf, and the framework authorizes it |
| `createSession` / `send` | the local pole — the host IS trusted                                 |

`as()` accepts an `IngressCredential` (funnelling into the one callback) or a
pre-resolved `Authenticated`, and supplies both lanes to everything called
through it. `createSession` needs the identity — the session's owner. `send`
needs the user context — the execution's credential. That the two land on
different calls is a confirmation the split in §3 is real.

### 7. The framework carries only what it was given

No fallback, no cache, no lazy resolution, no re-resolution on staleness. If
nobody supplied a user context, `ctx.user` is undefined and the handler decides.
If an adopter's `authenticate` is expensive, they memoize it; the framework calls
it whenever it needs to and does not model cost.

This is the line that kept being crossed in earlier drafts, always by deciding
something on the adopter's behalf.

## What we tried and rejected

**`createApp({ ctxExtensions })`** — an adopter-supplied bag on the tool-handler
ctx. Wrong seam: it opened a second adopter augmentation point
(`ToolHandlerCtxExtensions`, which is for framework harness facets) for a concept
`RuntimeContextUser` already owned. Built and reverted.

**Two callbacks, `authenticate` + `userContext`.** The credential had to be
verified twice because they could not see each other; the classification decision
became invisible, made in two places that never appear together; and narrowing
`IngressIdentity` to `{ principal, scopes }` removed the adopter's durable
bucket, so a company id an audit trail wanted had nowhere to go — a capability
deleted while claiming to improve ergonomics. Built and merged away.

**A framework-called `resolve` hook** for executions with no crossing. Unnecessary
once `as()` is understood as the crossing-less door and `platform` credentials as
its currency: there is no orphan execution to resolve for.

**Lazy or memoized resolution.** Policy, not mechanism. The adopter's call.

## Fallout

Breaking, in a `1.0.0-next.*` line with one adopter:

- `AuthSource.authenticate` returns `Authenticated | IngressIdentity`. Existing
  implementations returning a bare identity keep working.
- `IngressIdentity.user` narrows in MEANING — durable identifiers, never a
  credential. Same type; the docblock is the change.
- `fetchServerTransport({ identity })` becomes `{ authenticate }`, returning both
  lanes. A rename plus a return shape.
- `gateway.as(identity)` becomes `as(who)` over a union; existing call sites are
  unaffected.
- `SendInput` gains a server-stamped `userContext`. Additive, and unreachable
  from the wire.
- `ctx.user` becomes populated where it was permanently `undefined`, and stops
  being journaled. No adopter reads it today, because nothing ever wrote it.
- Journal entries lose nothing: `identity` was already what got stamped.

For the first adopter, most of the work is deletion — a module-global token map,
its five call sites, and a `principal: string | undefined` parameter on every
port that only ever used it as a cache key.

## Consequences

- The adopter writes one type augmentation and one callback, and reads
  `ctx.user`. The eight-step, five-file path collapses.
- The journal keeps recording who acted and stops being somewhere a bearer token
  could land.
- A connector session's authority is stated, in the same function as everything
  else, instead of being discovered when a tool throws mid-turn.
- **Availability is not solved by plumbing.** A session whose originator supplied
  no credential still has none. What changes is that the absence is declared at
  the door rather than found in a `Map` miss.

## Open questions

1. **Nothing enforces the classification.** A credential put on `identity` is
   written to the journal silently; the `NON_INHERITED_TRUNK_KEYS` guard covers
   `ctx.user`, not that. One visible decision beats two invisible ones, but the
   failure is still silent in both directions. A dev-mode shape check would help.
2. **A missing user context is silent.** No record at the door leaves `ctx.user`
   undefined, discovered when a handler needs it — the failure shape this ADR set
   out to remove. Worth warning once per session in dev.
3. **Long executions outlive their credential.** A run started with a token that
   expires mid-flight has no refresh path, by design. Temporal re-resolves per
   activity instead. If an adopter needs that, they hold a getter in their own
   record — which is exactly the kind of policy §7 keeps out of the framework,
   but it should be written down as the intended answer.
4. **One global `RuntimeContextUser`.** Declaration merging is process-wide, so a
   host running two apps with different user shapes gets one merged interface.
   Invisible to a single-app adopter; wrong for a multi-app host.

## Status of the work

- `fix(tool-executor)` — tool handlers fold the crossing's boundary facets.
  Landed, unpublished. The coupling §4 depends on.
- The transport threading, the `Authenticated` shape, `as(who)`, `withUserContext`
  and the `NON_INHERITED_TRUNK_KEYS` guard: landed, unpublished.
- **Unbuilt: §5.** `SendInput.userContext`, the session wrapping its execution,
  and inheritance to spawned children. Nothing reaches a tool handler until this
  exists.
- **Unbuilt: §2's `platform` path** and the adopter migration.
