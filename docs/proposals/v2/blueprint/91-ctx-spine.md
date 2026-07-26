# ADR 91 — The ctx spine: one trunk, derived boundary contexts

**Status:** DRAFT (pending Ryan ratification)
**Drives:** context normalization across every adopter-facing handler seam
**Supersedes/extends:** ADR 45 (RuntimeContext model — extended, not replaced),
ADR 64/78 (Observability), ADR 76/83 (Ops), ADR 66 (handler ctx slots —
unchanged, composes)

## Problem

v1 had ALS: one ambient context, reachable anywhere — one reality by
_transport_. v2 killed the ambient transport deliberately (causality,
testability, concurrency bleed) but never replaced the _one reality_
part. What grew instead is bespoke bags. The 2026-07-26 inventory
(grounding for this ADR) found:

- **8 boundary context types** with hand-picked, inconsistent slices of
  the same underlying reality: `ToolHandlerCtx` re-declares
  `sessionId`/`executionId`/`tickId` flat and omits
  `opId`/`principal`/`origin`; `WireExtensionContext` carries
  `principal`/`identity` but no work-path coordinates; `StoreCtx`
  _inlines the entire trunk verbatim_ because spec cannot import runtime.
- **6 fabrication sites** that hand-assemble contexts from scratch —
  the MCP server fabricates `toolCallId`s, fresh `AbortController`
  signals, and no-op `setState`/`emit`/`progress` closures three
  different ways (`buildRequestContext`, `buildOffConnectionContext`,
  `buildInstructionsContext`).
- **9 starved seams** with little or no ctx at all: prompt `render`,
  `ResourceResolver`/`TemplateResolver`, `CompletionContext`,
  `TaskWorkContext` (a task body cannot even `log`), `onSessionCreate`,
  `RequestContext`, and the lifecycle bags.
- **3 name conflicts**: `transport` (string discriminator on
  `ToolHandlerCtx` vs capability object on `WireExtensionContext`),
  `user` (adopter ambient state on the trunk vs authenticated principal
  on `McpRequestExtras`), `progress` (three signatures across three
  ctxs).

The consumer-#1 (Ernesto/Knowify MCP) port hit the starved seams
directly: `knowify://me`/`company` resources, two dynamic prompts, and
DB-backed completions all degraded because their seams receive no
identity. Fixing those seams bespoke-ly would add a 9th bag to the
Frankenstein.

## Decision

**One reality by type, not by ambience.** Three commitments:

### 1. The trunk moves to spec, split as data + facets

`RuntimeContext` — the pure-data causality/identity core — moves from
`packages/runtime/src/substrate/runtime-context.ts` into
`packages/spec` (it already `extends EventScope`, which is
spec-resident, and carries zero runtime dependencies: `opId`,
`parentOpId`, `op`, `correlationId`, `traceparent`, `user`). The
FiberRef propagation machinery (`RuntimeContextRef`, `getContext`,
`withContext`, `readContext`) **stays in runtime** — spec gets the
type, runtime keeps the mechanism. ADR 45's "pure frozen data" law is
unchanged.

Direct payoff: `StoreCtx` collapses to a literal
`extends RuntimeContext` (its docblock already asks for exactly this),
and its `user: unknown` weakening disappears.

The capability facets stay what they are — spec-resident
`Observability` (`log`/`trace`/`metrics`) and `Ops` (`run`/`runner`) —
_derived from_ the data at derivation time, never serialized, never on
the trunk. The canonical boundary-ctx shape is the one that already
exists at `middleware.ts:63`:

```ts
type InterceptorCtx = RuntimeContext & Observability & Ops;
```

That intersection IS the spine. Every other boundary ctx becomes
`RuntimeContext & Observability & Ops & <boundary facets>`.

### 2. One deriver: `deriveContext(parent, facets)`

A single runtime helper — the promotion of `defineOperationFacets`
(base-harness.ts:1213), which already composes `deriveObservability` +
`deriveOps` into lazy getters — becomes the **only legal constructor**
for a boundary context. It takes a parent trunk (the op's `ctxScope`,
a connection's crossing info, a session's construction identity) and
the boundary facets, and produces the extended ctx. Hand-assembled
bags are a code smell after this ADR; the MCP fabrication trio and the
tool-executor assembly site all route through it. Fabricated no-ops
(`setState`, `emit`, `progress`) are replaced by either real
derivations from the parent crossing or _typed absence_ (the slot is
optional and absent, not silently inert).

Derivation is also forward-flowing: a context established at an outer
crossing (the MCP pre-gate's authenticated ctx) derives _into_ the
inner one (the request/instructions ctx) instead of being rebuilt —
which retires the double-authenticator wrinkle noted at next.5.

### 3. The law

> Every handler/callback seam the framework invokes receives a `ctx`
> whose trunk derives from the invoking crossing's `RuntimeContext`.
> No seam fabricates a trunk from nothing; off-connection crossings
> derive from their connection info with explicit anonymous identity.

Reachability — v1-ALS's one genuine virtue — is recovered by
uniformity: ctx is always the same-shaped first-class parameter
carrying the same reality, at every seam. ADR 66's augmentation
pattern is untouched: module augmentation keeps adding optional
capability slots to boundary ctxs; the trunk is what they all inherit
underneath.

## Conflict resolutions

| Conflict                     | Resolution                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport` string vs object | `WireExtensionContext.transport` (the capability object) renames to `wire` — it is the wire-crossing's verbs, not a discriminator. `ToolHandlerCtx.transport: "in-process" \| "mcp"` keeps the name (it discriminates the transport). Breaking; no shim (house philosophy). |
| `user` semantics             | Stated as law: authenticated identity is **`identity`/`principal` on the trunk**; `mcp.user` is the MCP-boundary _projection_ of it; `ctx.user` is adopter ambient state and **never** auth. Names stay; the law is documented at all three sites.                          |
| `progress` three-ways        | Not unified in this ADR (three genuinely different boundary verbs); documented as boundary facets, each named by its boundary. Revisit only if a fourth appears.                                                                                                            |

## Phases

- **Phase 1 — name the spine** (spec + runtime + mechanical retypes):
  trunk type moves to spec; `deriveContext` lands in runtime absorbing
  `defineOperationFacets`; `StoreCtx` collapses; `ToolHandlerCtx`,
  `McpRequestContext`, `WireExtensionContext` retype as
  extends-trunk; all six fabrication sites route through the deriver;
  `transport` → `wire` rename on the wire ctx. Behavior-preserving;
  gate = full suite green + zero hand-assembled ctx sites remain
  (greppable: direct `deriveObservability`/`deriveOps` calls outside
  the deriver are the smell).
- **Phase 2 — feed the starved seams** (the Family A application), plus
  two carry-overs from the Phase 1 judge pass: **brand totalization** —
  Phase 1 brands the interceptor seam (`InterceptorCtxRef` demands
  `Derived`), but tool/MCP/wire compose their final ctxs by SPREADING
  the derived trunk into a larger literal, which erases the brand at
  the type level; `deriveContext` gains a boundary-extras parameter
  (`deriveContext(parent, facets, extras): Derived<OperationCtx & X>`)
  so the whole composition is minted branded, and the tool-dispatch,
  MCP-request, and wire-dispatch seams then demand it. And the
  **MCP single-authenticator forward-derivation** (stop-ruled in
  Phase 1: needs the pre-gate's authenticated identity persisted across
  the transport→harness boundary; `TODO(ADR-91 phase-2)` at the site).
  `ResourceResolver`/`TemplateResolver` gain `(uri, ctx?)`, prompt
  `render` gains `(args, ctx?)`, `CompletionContext` and
  `TaskWorkContext` extend the trunk + facets. Optional in the
  signature (declarations stay pure and trivially testable), required
  in the law (framework invocations always pass it). MCP's projection
  threads its now-trunk-derived request ctx into harness reads.
  Downstream: un-degrades the Knowify `me`/`company` resources, the
  two dynamic prompts, and DB-backed completions.
- **Phase 3 — ride-alongs**: `namespace` on the trunk read by
  `spanAttributes` (whole-spine whitelabel); metrics facet completes
  its sweep (loop/model/compiler); audit of remaining lifecycle seams
  (`onSessionCreate` — which ADR 48 already gave a reshape arm and
  would now also see a trunk — `RequestContext`, spawn/migration
  bags, `RenderContext` principal/scopes).

## Enforcement — the law is structural, not vigilance

Ryan's requirement (2026-07-26): "context being where it needs to be
needs to be completely rightfully assumed and framework enforced. not
something we need to constantly be vigilant to remember doing."

Plain `extends RuntimeContext` cannot enforce anything: every trunk
field is deliberately optional (ADR 45 — outside an active bracket they
are `undefined`), so `{}` satisfies the type structurally. Enforcement
is therefore nominal + mechanical:

1. **Branded derivation.** `deriveContext` stamps its result with a
   unique-symbol brand (`DerivedCtx`); the brand's constructor is not
   exported. Framework seam-invocation sites — the same six sites the
   inventory lists as fabrication sites today — require the branded
   type, so a hand-assembled ctx fails to COMPILE at the point of use.
   Adopter handler signatures keep the plain interfaces (handlers
   receive ctx, never construct it; branded satisfies plain — zero
   adopter friction). Tests construct via `deriveTestContext` from the
   runtime `/testing` subpath (also branded).
2. **Ambient-default parent.** In-fiber, `deriveContext(facets)` reads
   the parent trunk from `getContext` itself — no one remembers to
   pass it. Off-fiber boundaries (MCP accept, wire ingress) use the
   explicit overload `deriveContext(parent, facets)`, and the compiler
   demands the parent there.
3. **CI gates.** (a) Grep gate in `verify`: any direct
   `deriveObservability` / `deriveOps` call outside `deriveContext`
   fails the build. (b) Per-seam trunk-derivation conformance case:
   asserts the ctx a seam receives carries its parent crossing's
   coordinates (sessionId/opId/identity), not fabricated ones.

Migration note: moving `RuntimeContextUser` to spec retargets the
adopter augmentation from `declare module "@agentick/runtime"` to
`"@agentick/spec"` — breaking, no shim; sweep adopters (Ernesto) and
mind the ambient-module shadow trap (`export {}` in augmentation
files).

## Non-goals

- No ALS revival. The ambient FiberRef stays an in-fiber
  implementation detail behind `getContext`; the adopter contract is
  the explicit parameter.
- No God-object ctx. Boundary ctxs stay narrow: trunk + the facets
  that boundary actually needs.
- No change to ADR 66 dispatch-resolved slots or to
  `EventScope`-as-wire-projection (identity, never tokens — the
  credentials law holds).

## Verification

Phase gates as above; every retyped ctx keeps its existing conformance
and adds a "trunk derivation" spec (asserting the boundary ctx's trunk
fields are those of its parent crossing, not fabricated). The
inventory's fabrication-site list is the Phase 1 checklist; its
starved-seam list is the Phase 2/3 checklist.
