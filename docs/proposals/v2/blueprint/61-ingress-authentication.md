# ADR 61 — Ingress authentication: one seam for every trust-boundary crossing (`interceptIngress`)

**Status:** PROPOSED 2026-07-07 (Fable, for Ryan). **Cut-blocker** — the prod-readiness
gate (cloud persona #163) ingresses over HTTP and connectors, both currently unauthenticated.
**Builds on:** ADR 50 (gateway extensions — designed + *deferred* `interceptIngress`), ADR 51
(§4 Authorizer + "authn happens ONCE at ingress"), ADR 34 (scoped-capability cascade — the
`AuthSource` *grant-derivation* side), ADR 47 (no gateway connection registry — the seam lives
at transport ingress), ADR 48 (`principal` → structural identity), ADR 58 (connectors — the
second ingress edge).
**Touches:** `@agentick/spec` (`wire/authorizer.ts` — `AuthSource`/`IngressIdentity`
already exist; adds `IngressContext` + `IngressCredential`), `@agentick/transport`
(server dispatch + connection-context), `@agentick/transport-{websocket,http,unix-socket}-next`
(the edges), `@agentick/connector` (the federated edge, slice 2).
**Tracking:** #146 (title still says "ADR 34" — pre-renumber; retarget to ADR 61). The
`TODO(#302)` code refs are stale — #302 does not exist; the issue is #146.

## TL;DR

We built **three of the four** pieces of the auth story and shipped the fourth at exactly **one**
of several ingress edges. The **Authorizer** (the lock, ADR 51 §4) is built and enforced at one
point (wire dispatch). The **`AuthSource`** port (credential → identity) and the **`IngressIdentity`**
carrier are built. What is missing: **the authentication CALL runs only on the WebSocket
transport** (`transport-websocket/server.ts` inline). `transport-http` (the prod edge),
`transport-unix-socket`, and **connectors** (ADR 58) stamp no real principal → the Authorizer sees
`principal: undefined` = the trusted local pole = an **open door in prod**.

This ADR realizes ADR 50's deferred **`interceptIngress`** as **one uniform seam for every
trust-boundary crossing** — client transports *and* connectors — with a **polymorphic credential**
and `AuthSource` as the normalizing **identity broker**. In-process calls (`session.send`) are the
trusted **interior** and deliberately never touch the seam. Authenticate **once per crossing**,
propagate the `principal` inward; **never re-authenticate internally.**

## The principle: "ingress is ingress" — precisely scoped

The unifying concept is not "a request arrived." It is an **untrusted-outside → trusted-inside
crossing where a claim must be verified.** This is the industry's **north-south vs east-west**
distinction (API gateways; Envoy/Istio ingress gateways):

- **North-south** — the edge; external → internal; **authenticate here, once.**
- **East-west** — internal / in-process; **do not re-authenticate — propagate the established
  identity.**

| Edge | Trust crossing? | Authn shape |
|---|---|---|
| **Client transport** (ws / http / unix) | ✅ yes | verify a credential (bearer/header) → principal. **Ingress.** |
| **Connector** (telegram / imessage, ADR 58) | ✅ yes — **federated** | the platform already authenticated the user; verify the delivery is genuinely the platform, then **map** the asserted platform identity → principal. **Ingress, federated.** |
| **`session.send()` / `dispatch` / in-process** | ❌ **no** | trusted interior; **explicit** caller-supplied principal (or the system/service principal). Never hits the seam. |

**Authenticate-once-propagate** is the load-bearing rule (Java `SecurityContext`, .NET
`ClaimsPrincipal`, Spring `SecurityContextHolder`, Rails `current_user`) — and it's already ADR 51
§4.1's doctrine ("authn happened ONCE at ingress; dispatch only carries the stamped identity").
Re-verifying a credential at every internal hop is the **distributed re-authentication
anti-pattern**: it couples every hop to the IdP, multiplies latency, and multiplies the number of
places a mistake becomes a hole.

The **one** legitimate nuance: **stateless HTTP authenticates per-request** — not redundant
re-auth, but because each stateless request *is its own distinct edge crossing* (no connection to
pin identity to). So the rule is **once per crossing**: per-connection for stateful transports
(ws), per-request for stateless (http).

## Why not the alternatives (steel-manned)

- **"Keep per-transport inline authn (what websocket does today)."** It works for ws, but it
  duplicates the extract-verify-stamp logic per transport, gives no home for non-authn edge
  concerns (rate-limit, IP-allowlist, tenant-resolution), and — the actual bug — was simply *never
  added* to http/unix/connectors. Duplication is why coverage drifted. One seam, called at every
  edge, is the fix.
- **"Run auth idempotently on every request everywhere."** The distributed re-auth anti-pattern
  above. Rejected.
- **"A separate `PlatformIdentityResolver` for connectors."** Splits the security surface into two
  places to audit; the connector isn't a *different mechanism*, it's a different *credential shape*
  feeding the same broker. Rejected in favor of the polymorphic credential (below). This is the
  textbook **federated-identity / token-broker** pattern (OIDC, SAML, SPIFFE): normalize
  heterogeneous external identities into one internal principal shape.

## The contract

### The seam — `interceptIngress` (realizing ADR 50)

A **chain-of-responsibility** at the transport ingress edge (post-ADR-47 there is no gateway
connection registry — it runs transport-side, invoked via the gateway's ingress chain). Registered
via `GatewayInstaller.interceptIngress` (ADR 50 item 2, deferred there, defined here). Interceptors
run in install order; each **enriches** the ingress context or **rejects** by throwing a typed
`AgentickError`. **Enrichment-only — never a runtime authorization filter** (that is the
Authorizer's job at dispatch; conflating them is the `notify({to})` anti-pattern ADR 47 killed).

```ts
// spec/wire — NEW
/** What the transport supplies at the edge. Discriminated by `credential.kind`. */
export interface IngressContext {
  readonly transportKind: "websocket" | "http" | "unix" | `connector:${string}`;
  readonly credential: IngressCredential;
  /** Connection id where the transport has one (stateful); absent for stateless/per-request. */
  readonly connectionId?: string;
  /** Accumulated as the chain runs; the terminal auth interceptor sets it. */
  readonly identity?: IngressIdentity;
}

/** The polymorphic credential — one seam, many shapes. */
export type IngressCredential =
  | { readonly kind: "bearer"; readonly token?: string; readonly headers: Readonly<Record<string, string | undefined>> }
  | { readonly kind: "platform"; readonly platform: string; readonly platformUserId: string; readonly assertion?: unknown }
  | { readonly kind: "none" };

/** Enrichment-only, install-order. Throws a typed error to reject the crossing. */
export type IngressInterceptor = (ctx: IngressContext) => IngressContext | Promise<IngressContext>;
```

`IngressIdentity` (`{ principal?, user?, scopes? }`) and the `AuthSource` port already exist in
`spec/wire/authorizer.ts` — unchanged as outputs. The only spec change to `AuthSource` is
**widening its input** from `{ token }` to the `IngressCredential` union so one broker handles
bearer *and* platform:

```ts
export interface AuthSource {
  readonly backend: string;
  authenticate(credential: IngressCredential): Promise<IngressIdentity>;
}
```

### The flow (per crossing)

```
edge builds IngressContext (native creds)
      ↓  gateway ingress chain runs ONCE (install order)
   [ …enrichers (rate-limit, tenant)… ] → [ auth interceptor → AuthSource.authenticate ]
      ↓  ctx.identity : IngressIdentity
   stamp principal structurally (connection for ws, request for http, session action for connector)
      ↓
   WireExtensionContext.principal / scope principal  →  Authorizer (ADR 51) sees a REAL principal
```

The single auth interceptor degenerates to "call `AuthSource` at the edge" — which *is* slice 1.
The multi-interceptor value (extra enrichers) is why it's a chain, not a bare function.

### The edges

- **`transport-websocket`** (slice 1): migrate the inline `authSource.authenticate` on upgrade
  (`server.ts:~87`) onto the ingress chain. Per-connection; identity pinned to the socket
  (`ConnectionContext.identity`, already the carrier). 401 on rejection. **Zero behavior change**
  for the configured-authSource path — the proof it's a refactor, not a rewrite.
- **`transport-http`** (slice 1): **the prod edge — highest severity.** Per-request: extract
  `Authorization: Bearer` (+ headers), run the chain, stamp identity on the request context, `401`
  on rejection. Today: **zero authn references.**
- **`transport-unix-socket`** (slice 1): host-local trust, but explicit — run the chain with
  `credential.kind: "none"` by default (peer-cred enrichment is a later interceptor).
- **Connectors** (slice 2, ADR 58): per inbound message, build `credential.kind: "platform"`
  (`{ platform, platformUserId, assertion }`), run the chain; a connector-flavored `AuthSource`
  branch maps platform id → principal; stamp the **per-message actor** on the session action.
  Resolves `connector/define-connector.ts:132` (every message currently runs as the connector's
  service-account principal — a multi-user bot runs everyone as one principal).

### The interior (explicitly excluded)

`session.send`, `session.dispatch`, and any in-process call are **east-west**. They take an
**explicit `principal`** from the caller (already-authenticated upstream, or the system principal);
they **must not** run `interceptIngress`. Authenticating your own in-process call is authenticating
yourself. If `send()` needs authentication, a wire sits in front of it — and *that wire* is the
ingress edge.

## Enforcement relationship (authn ≠ authz)

This ADR is **authentication** (who is the principal, is the claim trustworthy). The **Authorizer**
(ADR 51 §4) is **authorization** (may this principal invoke this verb on this target). They compose:
ingress **produces** `principal`; dispatch **consumes** it. The ingress seam **never authorizes**
(enrichment-only); the Authorizer **never authenticates** (it trusts the stamped principal). One
enforcement point each; no re-auth inward.

## Default posture (unchanged)

- **No `AuthSource` configured** → the **local/trusted pole**: crossings carry no principal;
  `unconfiguredAuthorizer` passes them (dev / single-tenant). This is the bare-host default.
- **`AuthSource` configured** → **deny tokenless** (`staticTokenAuthSource` `allowAnonymous:false`
  by default; the prototype-key-bypass guard stays). Anonymous only when explicitly opted in.
- The two together give the ADR 51 §4 matrix: local pole passes, any principal denied until the
  Authorizer grants — now with a principal that is *actually stamped at every prod edge*.

## Security invariants (INVARIANT)

1. **The seam is server-side only.** `AuthSource`, tokens, and the ingress chain never project to
   the client. Per credentials-never-cross-wire — the client sees status + verbs, never credential
   material or the identity-derivation logic.
2. **Enrichment-only, never authz.** An interceptor adds identity or throws; it does not gate verbs.
3. **Federated ≠ blind trust.** The connector edge must verify the *delivery* is genuinely the
   platform (webhook signature / platform auth) before trusting its asserted `platformUserId`. The
   platform authenticated the *user*; the connector authenticates the *platform*.
4. **Fail closed.** A configured `AuthSource` that throws → reject the crossing (401 / drop the
   message), never fall through to the local pole.

## Prior art

API-gateway edge authentication (Kong, Envoy, AWS API Gateway); Istio/Envoy north-south vs
east-west; security-principal propagation (`SecurityContext`/`ClaimsPrincipal`/`SecurityContextHolder`);
federated identity + token brokering (OIDC, SAML, SPIFFE/SVID). The design is deliberately
un-novel: authenticate once at the edge, normalize heterogeneous credentials through one broker,
propagate a principal, authorize downstream.

## Conformance

A `runIngressAuthnConformance` suite (in `transport-next/testing`) any transport runs against a
**real** server: (1) configured `AuthSource` + valid bearer → identity stamped, dispatch sees the
principal; (2) missing/invalid credential → rejected at the edge (401 / drop), never local-pole
fallthrough; (3) no `AuthSource` → local pole passes with no principal; (4) prototype-key bypass
rejected; (5) `once-per-crossing` (per-connection for ws — one authn per socket; per-request for
http). Connector conformance (slice 2) adds the federated `platform` credential path.

## Slice plan
1. **Seam + all transports** (per Ryan): `IngressContext`/`IngressCredential` in spec; widen
   `AuthSource.authenticate`; a shared ingress-authn helper; migrate websocket onto it; wire
   `transport-http` + `transport-unix-socket`; `runIngressAuthnConformance` green against all three.
   Locks the prod HTTP edge.
2. **Connectors** — the `credential.kind:"platform"` branch, federated map, per-message actor;
   resolves the `define-connector.ts:132` TODO; connector conformance.
3. **`GatewayInstaller.interceptIngress` chain + `withAuth` — DEFERRED (corrected 2026-07-07).**
   Slice 1's **per-transport `authSource` option is THE design** — a transport *is* the ingress
   edge; configuring auth there is clean and sufficient. Relocating it to a gateway-composed chain
   was specced and then **withdrawn** as churn-without-a-consumer: it would have removed working,
   just-shipped code to chase a more-"composable" form, and per-transport-option + gateway-`withAuth`
   are two ways to configure one thing (violates one-code-path). Per steel-man-the-null: **do not
   build the `interceptIngress` chain abstraction until a concrete NON-auth interceptor
   (rate-limit, tenant-resolution, request-enrichment) needs it** — at which point the chain earns
   its keep as genuine multi-interceptor infrastructure, and auth moves onto it then. Until then,
   auth stays per-transport. `IngressInterceptor` remains defined in spec (harmless seed) with a
   `// TODO(#146)` trailhead.

## Deferred / open
- **Peer-credential enrichment** for unix-socket (SO_PEERCRED → principal) — a later interceptor.
- **BYOK per-principal adapter instances** (ADR 48 §5 / ADR 52) consume `principal`; out of scope
  here (this ADR *produces* it).
- **Grant derivation** (OAuth scope claims → grants) is ADR 34's `AuthSource.scopes` side; the
  Authorizer already consumes `tokenScopes`. This ADR stamps `scopes`; the derivation policy is
  the `claimsAuthorizer`'s.
