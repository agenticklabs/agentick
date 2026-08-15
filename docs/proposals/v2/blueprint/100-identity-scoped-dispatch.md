# ADR 100 — `as()`: identity-scoped dispatch on the local pole

**Status:** Implemented — 2026-08-15.
**Builds on:** ADR 48 (construction-bound principal), ADR 51 §4 (ingress
identity + authorization), ADR 83 (wire dispatch through the op seam),
ADR 84 §5 (`gateway.authorize` as a hookable op).

**Touches:** `@agentick/spec` (`IdentityScoped` root + `IdentityScopedApp` /
`IdentityScopedGateway` protocols, `RunOnceInput.principal`,
`EventScope.identity` doc), `@agentick/runtime` (`BaseHarness.as` — the stance —
and the protected `identityScope` threading helper), `@agentick/app`
(`AppHarness.as` override, principal thread-through in `runOnceBody`),
`@agentick/gateway` (`GatewayHarness.as` override, `dispatchAsIdentity`).

---

## 1. Driver

A server-side consumer (Knowify's `email.received` queue handler) needs to run
an app AS a specific user: create a session attributed to a tenant/user
principal, send once, read a structured verdict, dispose. Before this ADR it
had exactly two doors, both wrong:

- **The bare local pole** (`app.createSession({ principal, metadata })`) —
  trusted, unchecked, and hand-assembled. The caller must build both principal
  representations itself (the ADR-48 composite string AND whatever attribution
  bag the adopter's stores read), and getting it wrong fails silently:
  unattributed rows, no error. Every adopter grows an opaque
  `toCreateSessionInput`-style helper to survive this.
- **A wire client over the in-process transport** — full fidelity (identity,
  hooks, authorizer), but the serialized boundary strips exactly what a
  server-side one-off needs: `SendInput.output` (the schema cannot cross) and
  handler-carrying execution-scoped `tools`.

The observation that resolves it: **"wire" in this framework was never the
socket.** The in-process server transport is already an honest no-op — the
`wire:` op prefix marks the _trust boundary_: a dispatch whose authority comes
from an authenticated identity rather than from being the host, with params
untrusted and policy in between. That boundary is real for a server-side
consumer acting as a user; only the framing is missing.

## 2. The mechanism

One new stance, two doors, zero new seams:

```ts
// Gateway door — the wire mechanism without the framing.
const session = await gateway.as(identity).app("email-classifier").createSession();
const { result } = await gateway.as(identity).app("email-classifier").runOnce({ send });

// App door — attribution without gateway policy (standalone apps).
const session = await app.as(identity).createSession();
```

`gateway.as(identity).app(id).createSession(input)` runs, in order:

1. **The verb gate** — `gateway.authorize({ scope: "app:create_session",
principal, tokenScopes })`, the same hookable op `authorizeDispatch` routes
   through, same derived scope label, same `WireRpcError.forbidden` denial.
   The default unconfigured authorizer denies authenticated principals here
   exactly as it does on the wire.
2. **The wire op** — `runWireDispatch("app/create_session", params, ctx, run)`
   with a ctx carrying `identity` / `principal` / `app`. The
   `wire:app/create_session` op fires the adopter's existing
   `onBeforeWireAppCreateSession` hooks with `ctx.identity` populated, and
   their param reshaping is honored. Policy written once applies to both doors
   — there is no `onBeforeLocal…` twin, deliberately: a second hook family
   would be a policy-bypass door shipped as a naming nicety.
3. **The local terminal** — the `run` closure is `app.as(identity)`, not a
   wire handler: the ADR-48 stamp (`principal` from `identity.principal`,
   clobbering anything the input claims — the identity is the authority, the
   wire rule) and then the ordinary local `createSession`. The caller gets the
   real `SessionHarness`, keeping what the serialized wire cannot carry:
   structured `output`, handler-carrying `tools`, the live handle.

`runOnce` rides the same `app/create_session` crossing: a run-once IS
create → send → dispose, and create is the identity-relevant crossing
(ownership is construction-bound). `RunOnceInput` gains `principal` so the
ephemeral session is stamped like a durable one.

`app.as(identity)` is the terminal alone: the stamp, plus the identity threaded
onto the `app:create-session` / `app:run-once` op scope (the same
`EventScope.identity` axis a wire dispatch stamps) so app-op hooks can read who
is acting. No authorizer, no gateway hook bag — an app alone has neither, and
the door does not pretend otherwise.

## 2a. The stance lives on the base

`as()` is declared on `BaseHarness`, not invented per-harness — for the same
reason `principal` already lives there. The base carries the construction-bound
identity axis (`BaseHarnessOptions.principal`, stamped uniformly into every
event by `makeEvent`, centralized explicitly "to prevent per-command drift"),
and `hook()` shows the pattern for a universal stance. `as()` is the dynamic
twin of both: per-call identity, one declaration.

The division of labor:

- **Base** — declares `as(identity)` returning the minimal
  `IdentityScoped` binding (`{ identity }`, inert: the base has no
  identity-meaningful verbs to scope), and owns the ONE threading helper
  (`identityScope(scope, identity)`) an override uses to stamp WHO onto its
  ops. Explicit threading, not ambient state — the structural-identity
  doctrine ("bound at construction, never read ambiently") forbids a FiberRef
  shortcut, and 31 subclasses mostly have nothing to scope, so the base forces
  no surface.
- **Overrides** — a harness with identity-meaningful verbs narrows the return
  covariantly and adds its semantics: `AppHarness.as → IdentityScopedApp`
  (the ADR-48 stamp), `GatewayHarness.as → IdentityScopedGateway` (the wire
  seam + authorizer in front of the app door). Every scoped view exposes
  `identity` — the binding is inspectable.
- **Deferred** — `SessionHarness.as` (send/dispatch under the wire's
  same-principal target rule) is the natural third door, blocked on
  session.send moving onto `runOperation` (the base's own noted TODO).

## 3. Trust contract

`as()` does **not** authenticate. The identity is whatever the caller hands it
— verify the credential first (`AuthSource` is the door for that); a fabricated
identity is the host lying to itself, which the bare local pole already allows.
What `as()` guarantees is the other direction: once handed a verified identity,
stamping and policy are the framework's job, and the failure mode the bare pole
permits (a session with a missing or malformed principal, attributed to nobody,
silently) cannot be produced through it.

The bare local pole is unchanged and keeps its meaning: the trusted host
composing with itself — framework-internal creation (spawn, tests, adopter
plumbing) — never second-guessed, no identity on the scope, no wire hooks.

## 4. Wire parity notes

- Hooks see params **pre-stamp** and read WHO from `ctx`, exactly as on a
  transport dispatch (the wire params type carries no `principal` field; the
  stamp is the handler's, downstream of the hooks).
- The structural `requiredScopes` ceiling applies to a _target_ session named
  in params. `app/create_session` has no target — the session does not exist
  yet — so the ceiling is vacuous on this door by construction, not skipped.
- The dispatch ctx has no client: `publish` is a silent no-op, the progress
  writer discards, subscriptions are refused. The Observability/Ops facets are
  enriched in-fiber by `runWireDispatch` as on the transport path.

## 5. What this replaces downstream

Adopter code of the shape

```ts
app.createSession(toCreateSessionInput({ principal: { tenantId, userId } }));
```

becomes

```ts
const identity = await authSource.authenticate({ kind: "bearer", token });
gateway.as(identity).app(appId).runOnce({ send: { messages, tools, output } });
```

— one auth path end to end (the same `AuthSource` the transports use, with
whatever side effects the adopter's source performs on authenticate, e.g.
Knowify's principal→token cache that in-process MCP transports read), and the
adopter's principal-bag hooks stamp the attribution metadata for both doors
without registering anything twice.
