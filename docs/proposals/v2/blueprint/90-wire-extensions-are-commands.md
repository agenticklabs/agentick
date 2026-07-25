# ADR 90 — Wire extensions are commands

**Status:** Accepted (rows→typed-hooks + define-time op config landed); the
in-process invocation lane is **Deferred** pending a real consumer.

**Context:** ADR 46 (wire extensions), ADR 51 (invocation & authorization),
ADR 80 (command lifecycle hooks), ADR 83 (one interceptor primitive — the
`wire:` prefix + "wire dispatch through the seam"), ADR 42 (the two-form
dichotomy).

## The claim

A wire method is not a second-class RPC bolted onto the side of the runtime. It
IS a command — it earns every surface a domain command has. One row in
`WireMethods` + one handler yields **four surfaces**, no per-method wiring:

| From one `"<ns>/<method>"` row… | …you get                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| **client method**               | `session.<ns>.<method>(params)` — typed, `sessionId` bound (ADR 46 / the wire proxy)     |
| **authz scope**                 | the verb name IS the scope label (`crm/deleteContact` → `crm:deleteContact`, ADR 51 §3.3) |
| **journaled + hookable op**     | a `wire:<method>` operation through `runOperation` (requested→terminal, ADR 83 §wire)     |
| **typed gateway hooks**         | `onBeforeWire<...>` / `onAfterWire<...>`, derived from the row (this ADR, §1)             |

The first two shipped with ADR 46/51. This ADR lands the last two as
zero-per-method derivations and adds a define-time authoring surface for the op.

## §1 — Rows mint typed hooks (`WireCommandMap`)

Every `WireMethods` row already becomes a `wire:<method>` op at dispatch
(`GatewayHarness.runWireDispatch`, op `name: "wire:<method>"`). The hooks were
untyped — `gateway.hook({ onBeforeWireCrmDeleteContact })` needed a cast.

The fix is one mapped type in spec, folded into the runtime `CommandRegistry`:

```ts
// @agentick/spec — wire/params.ts
export type WireCommandMap = {
  [K in WireMethod as `wire:${K}`]: { input: WireParams<K>; output: WireResult<K> };
};

// @agentick/runtime — substrate/middleware.ts
export interface CommandRegistry extends WireCommandMap {}
```

`CommandHooks` (already `HooksOf<CommandRegistry, InterceptorCtx>`) now derives
`onBeforeWire<Ns><Method>` / `onAfterWire<Ns><Method>` for **every** row —
framework AND adopter augmentation — with the row's params flowing to the
before-hook input and its result to the after-hook output. The extends is legal
because `WireCommandMap`'s keys are statically known (the same property
`SessionHandle`'s wire proxy relies on), and it re-derives lazily when an adopter
augments `WireMethods`.

The type-level `Pascal` derivation and the runtime `deriveHookNames` are twins
that MUST agree (`wire:crm/deleteContact` → `WireCrmDeleteContact` on both);
`hook-lifecycle-names.spec.ts` and `wire-command-hooks.type.spec.ts` lock them in
lockstep.

**Before-hooks genuinely reshape the request.** `runWireDispatch` threads the op
INPUT (post-before-hook) into the handler — a `onBeforeWire<...>` hook that
returns reshaped params is honored, not merely observed. This is what makes the
wire boundary a real command rather than a fire-only notification seam.

### Why the `wire:` prefix stays (permanent — ADR 83)

The **client** mirrors the session op it initiates, so its hook for
`session/send` is `onBeforeSessionSend` (unprefixed) — the SAME name the session
op carries. The **gateway** boundary op and the domain op it delegates to
genuinely coexist under live inheritance (`wire:session/send` and the folded
`session:send`), and both Pascalize to `SessionSend` without the qualifier. The
`Wire` prefix is the disambiguator that keeps the two seams distinct and each
firing once. It is not decoration; removing it re-introduces the collision.

## §2 — Define-time op config (the ADR-42 dichotomy on methods)

A method entry follows the two-form dichotomy: a bare handler (shorthand) OR a
rich config object. Flat, no nesting:

```ts
defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/deleteContact": {
      handler: async ({ contactId }, ctx) => ({ deleted: await remove(contactId) }),
      auth: { required: true, scope: "crm:admin" },      // → merged into ext.auth
      guard: ({ contactId }) =>                            // → guard-kind interceptor
        locked(contactId) ? { kind: "veto" } : undefined,
      middleware: async (p, next) => next(p),             // → transform interceptor
      spanAttributes: { "crm.tier": "premium" },          // → annotates the op span
    },
    "crm/listContacts": async (_p, ctx) => ({ contacts: [] }), // shorthand — unchanged
  },
});
```

`defineWireExtension` normalizes this at define-time, reusing existing seams —
**no new interception tier**:

- **`auth`** normalizes into the extension's `auth` map, so `authorizeDispatch`
  keeps reading `ext.auth` as the single enforcement point. Declaring the same
  method's `auth` in both places is a define-time error.
- **`guard` + `middleware`** the gateway composes onto the `wire:<method>` op via
  the existing tier-4 call-scoped seam (`withCallMiddleware`), each **self-scoped
  to the wire op's command** so they never leak to the nested `session:send` /
  `tool:dispatch` ops the handler triggers under the same call-scoped fiber.
- **`spanAttributes`** annotate the wire op's span via the existing annotate seam.

### Verdict taxonomy at the JSON-RPC edge

A define-time guard raises the ADR-83 verdict taxonomy, honored on the wire:

| Verdict                | Op terminal | JSON-RPC edge                          |
| ---------------------- | ----------- | -------------------------------------- |
| `veto`                 | `vetoed`    | `Forbidden` (-32003)                   |
| `defer`                | `deferred`  | `RateLimited` (-32040), retry-after    |
| `replace`              | `replaced`  | success frame with the supplied result |
| `proceed` / `void`     | (runs)      | the handler's result                   |

(The transport dispatcher maps `OperationOutcomeError` by its `outcome` rather
than collapsing to an opaque `InternalError`.)

## Deferred — the in-process invocation lane

A wire method's handler is reachable today only over a transport
(`dispatchRequest → runWireDispatch`). An in-process caller who wants to invoke
the same handler without a socket has no lane. That lane is **deferred pending a
real consumer** (Ernesto). It is not free — two walls constrain any future
design, and they are acceptance constraints, not suggestions:

- **The double-fire wall (ADR 83 — the `wire:` prefix is permanent).** An
  in-process lane MUST NOT fire both the `wire:<method>` boundary hook AND the
  domain op's hook for the same logical call in a way that double-counts, nor may
  it collapse the prefix to "unify" the seams. The prefix exists precisely
  because `wire:session/send` and the folded `session:send` coexist; a second
  invocation door does not get to erase that distinction.

- **The auth-bypass wall (identity-through-the-second-door).** The wire lane's
  authorization (`authorizeDispatch` — the un-waivable `requiredScopes` ceiling +
  the verb-scope gate) is the ONLY thing standing between a caller and a handler.
  A second door that skips it is an auth bypass. If the lane is ever opened, it
  MUST carry explicit identity through the same authorize path and the same op:
  `gateway.dispatch(method, params, { identity })` — explicit identity, same
  `authorizeDispatch`, same `wire:<method>` op. No door reaches the handler
  without crossing the authorization edge exactly once.

Until a real consumer needs it, no lane ships — the transport path is the one
door, and it is gated.

## Consequences

- Adopter and framework wire methods are first-class commands: journaled,
  typed-hookable, guard/middleware-configurable, span-annotated — with zero
  per-method plumbing beyond the row + handler.
- The four-surfaces story is now complete and mechanical; a new vertical is a
  row + a handler, and every surface falls out.
- The in-process lane is a known, bounded gap with its constraints written down,
  not an open question.
