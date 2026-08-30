# ADR 107 — Credentials as a built-in: one harness, many providers

**Status:** DRAFT 2026-08-30 (Fable, for Ryan). Proposed after a day spent trying
to solve the credential problem in the auth seam, and finding that the primitive
which actually solves it was already in the repo and unused.
**Builds on:** ADR 104 (connectors as a gateway built-in — the structural
precedent), ADR 26 (everything is a harness), ADR 42 (harness-slot trichotomy),
ADR 48 (principal as structural identity), ADR 91/92 (ctx spine; the redaction
law), ADR 281b.1 (the credentials harness as shipped).
**Relates to:** ADR 106 (user context) — still an open draft, and explicitly NOT
solved here. See "What this does not solve".

## TL;DR

1. **`@agentick/credentials` becomes a first-class built-in with a permanent
   slot**, the way connectors did in ADR 104: `createGateway({ credentials: [...] })`
   rather than a `withCredentials({ store })` extension install.
2. **One harness, many provider instances**, registered by name — matching the
   connectors harness exactly. Today the harness takes a single store in its
   constructor and `namespace` is a key prefix that store must interpret itself.
3. **`namespace` becomes the routing key**: it selects a provider. Exact match,
   no chaining, unknown namespace is an error rather than a miss.
4. **A provider may store OR mint.** `get` is a resolution verb, not a lookup —
   which is what lets a static Redis-backed store and an on-demand token minter
   sit side by side under one interface, as Vault's static and dynamic secret
   engines do.
5. **Three security properties are load-bearing and do not change**: credentials
   never reach a tool handler's `ctx`; the harness ships no inbox protocol; the
   journal records credential COORDINATES and never values.

## Context

### The problem this closes

The first adopter needs the caller's credential at the point of an outbound API
call — inside a tool's host-bound port, long after the crossing that
authenticated it. What it has is a module-global `Map` keyed by principal,
populated in `AuthSource.authenticate`, with five call sites that disagree about
what a miss means (two degrade, three throw). Its own docblock admits it is
unbounded and process-local.

That map is not the wrong _pattern_. Carrying identity and resolving the
credential at the point of use is what Temporal does with activities against
worker config, and what SPIFFE does through an STS exchange. The pattern is
right; the implementation is a global with no framework seam, so it is
unreachable from anywhere principled, un-auditable, empty after a restart, and
absent entirely on a second node.

Its failure mode is instructive. A `send_sms` call failed in a normal `channel=chat`
session, for an authenticated principal, where the map should have held a token —
a silent miss surfacing as a mid-turn tool error, with nothing in the journal
saying a credential was even sought.

### What already exists, and is right

`@agentick/credentials` ships a `CredentialsHarness` (a real `BaseHarness`, with
an id and a cluster-portable address), a pluggable `CredentialsStore` contract, a
conformance suite, and `env` + `in-memory` stores. Three of its design choices
are load-bearing and should be understood as decisions, not accidents:

- **It augments `HookBridges`, not `ToolHandlerCtxExtensions`.** Credentials are
  reachable from host and tree code and NOT from a tool handler's `ctx`. Since
  the actor choosing which tool to call is a language model following untrusted
  input, a `ctx.credentials` would be a credential-exfiltration verb. This is the
  object-capability position and it is already enforced.
- **It augments `EventScopeExtensions` with `credentialNamespace` / `credentialKey`.**
  Coordinates on the journaled scope, values never. That is an audit trail: it is
  provable which credential was read for which operation, without the secret
  touching the journal.
- **It ships no inbox protocol**, deliberately — the harness source says so.
  Credentials are server-resident; an inbox verb would be a network-reachable
  secret read.

**Nothing consumes it.** Every reference outside the package is a docblock, plus
one optional field on the MCP transport factory that is declared and never read.
The package is effectively unshipped, which is the cheapest possible moment to
reshape it.

### What is structurally wrong

```ts
new CredentialsHarness(id, options.store, journal, bus, inbox); // ONE store
withCredentials({ store }); // an extension
```

One harness, one store, and `namespace` is a parameter that store must
demultiplex internally. Compare the connectors harness, which holds MANY specs
registered by name, with `register` / `unregister` / `start` / `stop` commands
and a permanent gateway slot.

A real deployment needs several credential sources at once. The first adopter
needs a Redis-backed store for kAuth tokens AND a minter for email ingestion
(which it already hand-rolls) AND the same for the SMS connector. Under a
single-store design, one implementation has to branch on namespace internally —
which is the `Map` again, with a nicer type.

## Prior art

The multi-instance shape is the norm, not the exception:

|                                                               | shape                                                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HashiCorp Vault**                                           | secret ENGINES mounted at paths — `kv/`, `aws/`, `database/`. Static KV at one mount, dynamic short-lived credentials at another. One system, many providers, routed by path |
| **Airflow**                                                   | a list of pluggable Secrets Backends; its DB-backed default is the part production shops migrate off                                                                         |
| **n8n**                                                       | credential TYPES, each with its own auth logic (API key vs OAuth2 flow)                                                                                                      |
| **Kubernetes CSI secret drivers, PAM modules, JCA providers** | pluggable provider registries, selected by name                                                                                                                              |

Vault's static-versus-dynamic split at different mounts is precisely "stores or
integrations under one harness".

The dissent is worth recording: **Temporal deliberately refuses to own
credentials at all** — they come from worker config or an external secret
manager, on the grounds that owning secrets means owning encryption, rotation,
key management, and audit. This ADR keeps faith with that objection by shipping
an INTERFACE and adapters, never a persistent store (see Non-goals).

## Decision

### 1. A permanent slot, as connectors have

```ts
createGateway({ credentials: [ redisKauth(), smsMinter(), keychain() ] })
createApp({ credentials: [ ... ] })
```

Resolved as an ADR 42 slot with the app/gateway cascade, replacing the
`withCredentials({ store })` extension install.

### 2. Many providers under one harness

The harness holds a registry keyed by namespace and gains the connector-shaped
lifecycle commands:

```
credentials:register     { spec }
credentials:unregister   { namespace }
credentials:start        { namespace }
credentials:stop         { namespace }
credentials:get / set / delete / keys      (routed by namespace)
```

`start`/`stop` are not ceremony: a Redis-backed store holds a connection and a
minter holds a client, exactly as a connector holds its transport.

### 3. `defineCredentialProvider`, mirroring `defineConnector`

```ts
const redisKauth = defineCredentialProvider({
  namespace: "kauth",
  get: (key, ctx) => /* ctx.principal is available — see §5 */,
  set?, delete?, keys?, onChange?, start?, stop?,
});
```

A spec, validated and frozen at definition, registered by the slot. `get` is a
RESOLUTION verb: an implementation may read from a store, exchange a grant
(RFC 8693), or mint on demand. The caller cannot tell and must not need to.

### 4. Routing, not chaining

`namespace` selects exactly one provider. Exact match — no prefixes, no fallback
chain. An unknown namespace is an ERROR, not an empty result.

Airflow chains backends and Vault mounts by prefix; both produce "which backend
served this?" ambiguity, and a fallback chain invites two providers to disagree
about who owns a key. An adopter who wants layering composes a chaining provider
themselves — the framework does less.

Duplicate registration is an ERROR, never last-wins. Silently shadowing a
credential provider is a security event, not a convenience.

### 5. Policy on read lives in the provider

`StoreCtx extends RuntimeContext`, so **every provider call already receives the
acting principal**. A provider can refuse to serve principal A's credential to an
operation running as B.

This is the multi-tenant isolation a namespace convention cannot give — a
namespace is a naming scheme, not a boundary. Note the deliberate consequence:
with many providers, "who may read whose credential" is answered N times rather
than once. That is correct — a keychain provider and a minting provider SHOULD
have different rules — but it is a consequence to state, not to discover.

## Non-goals — the three refusals

These are the properties that make the primitive safe. Each is already true and
each will be under pressure once credentials are "first-class".

1. **No `ctx.credentials`.** Stays on `HookBridges`. A tool handler must never be
   able to read a credential, because the caller is a model following untrusted
   input. Host code binds ports that hold authority; tools call those ports.
2. **No inbox protocol.** Being a harness buys lifecycle, interceptors,
   journaling, and the op spine. An inbox verb would buy remote credential reads.
   The existing refusal stands as a documented decision.
3. **No persistent default store.** `env` (read-only) and `in-memory` (ephemeral)
   only. A DB-backed default with its own encryption makes agentick the owner of
   key management — the Airflow-Fernet trap, and the thing Temporal is right to
   refuse.

A fourth, weaker: **do not grow the verb set.** No `rotate`, no `refresh`. Those
are a provider's business, behind `get`.

## What changes in the package

- `CredentialsHarness` takes a registry rather than a single store.
- `register` / `unregister` / `start` / `stop` commands are added.
- `namespace` becomes a routing key; the store contract narrows to one namespace.
- `defineCredentialProvider` is added.
- `withCredentials` is replaced by the slot.
- The conformance suite runs per provider rather than per store.

Materially breaking, at zero migration cost: nothing consumes the package today.

## Consequences

- The first adopter's module-global map becomes a Redis-backed provider, bound at
  the slot, asked at the point of use by the host-bound port that already
  receives the principal. Durable, multi-node, one call site instead of five.
- Its minting paths — email ingestion today, SMS next — become providers under
  the same interface as its stores, instead of hand-rolled parallel code.
- Credential access becomes auditable: `credentialNamespace` now identifies WHICH
  PROVIDER served a read, which is a materially stronger record than the field is
  today.
- A missing credential becomes a loud, located failure — an unknown namespace, or
  a provider that returned nothing — instead of a silent miss on a global map.
- The framework still stores nothing. It defines an interface, routes to
  implementations, and records that a resolution happened.

## What this does NOT solve

**The runtime user bag.** An adopter still has no place to put non-secret,
per-principal runtime values — settings, preferences, display name, permission
flags — that every seam can read and the journal never persists. That is a
different problem from credentials: it is not authority, it does not want a
provider per namespace, and it probably does want to be on `ctx`.

Yesterday's attempt at it is parked as ADR 106 (OPEN DRAFT) and on
`explore/user-context`. What was settled there and still holds:

- identity may be journaled; a credential may not;
- the session belongs to the principal, the execution to the credential that
  drove it;
- `ctx.user` sits on the trunk today, and the trunk is copied onto every child
  operation's `EventScope` — so it is the persisted lane despite its name.

This ADR removes the credential half of that problem from ADR 106's scope, which
should make the remainder tractable: a non-persisted per-principal value bag, with
no secret in it and therefore none of the object-capability tension that made the
first three drafts collapse.

## Open questions

1. **Where does the slot live — gateway, app, or both?** Connectors landed on the
   gateway with an app cascade. Credentials plausibly want the same, but a
   single-user local agent has no gateway.
2. **Does a provider see the namespace it was registered under**, or is that the
   harness's bookkeeping? Matters for a provider serving several namespaces.
3. **Does `keys(namespace)` survive?** Enumerating credential keys is a
   capability worth questioning; some providers cannot support it and a minter
   has no meaningful answer.
4. **Conformance for minting providers.** The existing suite assumes
   set-then-get. A provider that mints on demand fails that shape while being
   entirely correct.
