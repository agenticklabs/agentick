# ADR 43 — Unified `ToolHandlerCtx` (one ctx across transports)

**Status:** Proposed — 2026-06-29.
**Touches:** `@agentick/spec/data/tool-handler.ts` (the canonical
ctx interface), `@agentick/spec/protocol/mcp-server-harness.ts`
(deprecates `McpRequestContext` as a separate type), `@agentick/mcp/server`
(projection populates the unified shape), `@agentick/tool-executor`
(in-process dispatch populates the unified shape), `@agentick/session`
(session dispatch populates the unified shape), `@agentick/tool/transforms`
(`wrap-handler` audit), `@agentick/spec-conformance` (fixture
factory). Cross-references ADR 26 (harness API shape), ADR 27 (modular
built-ins), ADR 40 (MCP server harness), ADR 41 (`AgentickError`), ADR
42 (slot trichotomy + sugar convention).
**Driver:** During #171d.2.1–2.2 the MCP server projection grew its own
`McpRequestContext` separate from `ToolHandlerCtx`. Tool handlers
written for in-process Agentick sessions cannot run unchanged inside
the MCP server (and vice versa) — the second arg's shape diverges.
Adopter pushback (2026-06-29): "createTool tools should work with mcp
server too and both should basically work the same. the tool basically
doesn't care if it's in an mcp server context or a regular agentick
context… can we fulfill that???" — yes; this ADR is the plan.

---

## TL;DR

1. **One canonical ctx interface — `ToolHandlerCtx` — for tool handlers,
   regardless of transport.** Today there are two: in-process tool
   handlers see `ToolHandlerCtx`, MCP-server tool handlers see
   `McpRequestContext`. They overlap structurally but diverge
   nominally. Same name, same shape.

2. **`transport: "in-process" | "mcp"` discriminator** on the unified
   ctx. Discriminating field on a literal union — handlers can branch
   when (rarely) they need to. Common code ignores it.

3. **MCP-specific fields move under `ctx.mcp?` sub-slot.** Connection
   id, transport kind, client capabilities, progress callback,
   negotiated client info — present only when `transport === "mcp"`.
   The `mcp` slot's TypeScript shape conditionally narrows from
   `undefined` to a typed object via the discriminator.

4. **Sugar surfaces converge.** Both transports populate `ctx.elicit?:
   Elicit` (the noun-aliased sugar). The raw `ctx.elicitation?:
   ElicitationHarnessProtocol` stays for power users who want the
   substrate-level access. Same for `ctx.tasks?: Tasks` (sugar) +
   `ctx.tasks?: TasksHarnessProtocol` — though those share a name; we
   resolve naming below.

5. **`McpRequestContext` becomes a structural TYPE ALIAS** —
   `McpRequestContext = ToolHandlerCtx & { transport: "mcp"; mcp:
   McpRequestExtras }`. Existing code that imports `McpRequestContext`
   keeps typechecking; new code uses the unified `ToolHandlerCtx`
   directly.

6. **ADD-ONLY rollout strategy.** No existing field is removed or
   renamed. Optional new fields added; populated incrementally; old
   code paths continue to work. Collapse `McpRequestContext` to a
   type alias once all consumers have migrated. No big-bang refactor.

7. **Naming conflict resolution: `ctx.tasks`.** Today `ToolHandlerCtx.tasks`
   is `TasksHarnessProtocol` (raw). MCP-server has no `ctx.tasks` yet
   (lands with #171d.3). The sugar surface (`Tasks` noun alias) will
   match `Prompts` / `Elicit` patterns. Rule: **the existing
   `ctx.tasks` field stays raw protocol**, the sugar (when it lands)
   goes on `ctx.tasksSugar` OR `ctx.tasks` is widened to `Tasks`
   protocol alias. **Deferred decision** — settle when #272 /
   tasks-sugar slice arrives. Not a blocker for this ADR.

---

## Context

### Today's two ctxs side by side

```ts
// spec/data/tool-handler.ts
interface ToolHandlerCtx {
  readonly toolCallId: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly signal: AbortSignal;
  setState(key: string, value: unknown): void;
  emit(seed: HandlerChannelSeed): void;
  readonly elicitation?: ElicitationHarnessProtocol;  // raw protocol
  readonly tasks?: TasksHarnessProtocol;               // raw protocol
  readonly task: "auto" | "ref" | "inline";
}

// spec/protocol/mcp-server-harness.ts
interface McpRequestContext {
  readonly serverId: string;
  readonly connectionId: string;
  readonly transportKind: string;
  readonly connectedAt: number;
  readonly user: McpAuthenticatedUser | null;
  readonly clientInfo: { name; version } | null;
  readonly clientCapabilities: Record<string, unknown> | null;
  readonly signal: AbortSignal;
  readonly sendProgress?: (...) => Promise<void>;
  readonly elicit?: Elicit;       // sugar
  readonly metadata: Record<string, unknown>;
}
```

Common fields: `signal` only.

Divergent fields:
- `ToolHandlerCtx` carries `toolCallId`, `sessionId`, `setState`, `emit`,
  `task`, raw harness protocols.
- `McpRequestContext` carries connection / wire / auth state and the
  sugar `Elicit`.

A tool handler written against one cannot run against the other
without code changes. This is the gap the ADR closes.

### Why two ctxs exist today

Historical, not designed:
- `ToolHandlerCtx` was authored for in-process tool dispatch (#138).
- `McpRequestContext` was ported verbatim from v1's `MCPRequestContext`
  during #171b.
- Nothing forced convergence; the two implementations were independent.

### What the unified shape unlocks

- **`createTool({ handler: (input, { ctx }) => ... })` is portable.**
  Same handler runs in an in-process session AND when the same
  `ToolDeclaration` is projected onto the wire by `McpServerHarness`.
  No `ctx`-shape branching at the call site.
- **Single conformance suite for tool handlers.** Today there's an
  asymmetry — in-process tool handlers can be conformance-tested with
  `runToolExecutorConformance`; MCP-server-side handlers have no
  equivalent. Unified ctx → one suite.
- **Cross-transport portability of the sugar.** `ctx.elicit` + the
  forthcoming `ctx.sample` / `ctx.roots` work identically regardless
  of routing — same Elicit/Sample/Roots interfaces, different
  transports underneath.

---

## Decision

### 1. The unified `ToolHandlerCtx`

```ts
// spec/data/tool-handler.ts — new shape
export interface ToolHandlerCtx {
  // ── Universal (every transport populates these) ─────────────────
  readonly toolCallId: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly signal: AbortSignal;
  setState(key: string, value: unknown): void;
  emit(seed: HandlerChannelSeed): void;
  readonly task: "auto" | "ref" | "inline";

  // ── Sugar surfaces (NEW — same in both transports) ──────────────
  /**
   * Sugar over the underlying elicit transport. Present when the
   * transport can elicit AND the in-process harness OR connected
   * client supports it. `undefined` otherwise. Tool handlers MUST
   * check for presence before use.
   */
  readonly elicit?: Elicit;

  // ── Raw substrate primitives (existing — kept for power users) ──
  readonly elicitation?: ElicitationHarnessProtocol;
  readonly tasks?: TasksHarnessProtocol;

  // ── Transport discriminator + extras ────────────────────────────
  /**
   * Which transport invoked this handler. `"in-process"` for tools
   * dispatched by an Agentick session's tool executor;
   * `"mcp"` for tools projected onto the MCP server wire. Discriminator
   * for the `mcp` field below.
   */
  readonly transport: "in-process" | "mcp";

  /**
   * MCP transport-specific extras. Present iff `transport === "mcp"`.
   * Use `ctx.mcp?.clientCapabilities` etc. for portable code; reach
   * inside without the `?` after narrowing on `transport`.
   */
  readonly mcp?: McpRequestExtras;

  /** Free-form metadata — adopter extension point. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * MCP-only ctx extras. Carries the wire-level identity material
 * that's meaningless in the in-process case.
 */
export interface McpRequestExtras {
  readonly serverId: string;
  readonly connectionId: string;
  readonly transportKind: string;
  readonly connectedAt: number;
  readonly user: McpAuthenticatedUser | null;
  readonly clientInfo: { readonly name: string; readonly version: string } | null;
  readonly clientCapabilities: Readonly<Record<string, unknown>> | null;
  readonly sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}
```

### 2. `McpRequestContext` as a structural alias

```ts
// spec/protocol/mcp-server-harness.ts — replaces the standalone interface
export type McpRequestContext = ToolHandlerCtx & {
  readonly transport: "mcp";
  readonly mcp: McpRequestExtras; // narrowed: definitely present
};
```

Existing code referencing `McpRequestContext` keeps typechecking. The
alias narrows the discriminator + makes `mcp` non-optional —
`McpRequestContext` callers can dereference `ctx.mcp.clientCapabilities`
without optional chaining.

### 3. Rollout — strictly ADD-ONLY

No existing field is removed, renamed, or made required.

**Step 1: Spec types.** Add `transport`, `mcp?`, `elicit?`,
`metadata?` to `ToolHandlerCtx`. Define `McpRequestExtras`. Replace
`McpRequestContext` standalone interface with the alias. No call-site
changes yet. **Workspace typecheck must stay clean** — every field is
optional except `transport`, which gets a default value of
`"in-process"` populated by the existing ctx-build sites. (Optionality
trick: make `transport` optional at the interface level but populated
universally in call sites; adopters can rely on its presence without
the interface forcing it during incremental rollout.)

Wait — if `transport` is optional at the interface level it defeats
the discriminator. Resolution: make `transport` REQUIRED, and update
every existing ctx-build site simultaneously in this step. Three
known sites + tests. Manageable in one slice.

**Step 2: In-process ctx-build (tool-executor).** Populate
`transport: "in-process"`. Wrap the existing `elicitation` harness in
a `buildSessionElicit(harness)` factory (lands here OR with #272 — we
can land a minimal version here and beef up in #272). Populate
`ctx.elicit?` whenever the elicitation harness is present.

**Step 3: MCP server ctx-build (projection/tools.ts +
buildRequestContext in mcp-next/server/harness.ts).** Populate
`transport: "mcp"` + `mcp: { serverId, connectionId, ... }`. The
existing `elicit?` field stays exactly where it is — already on the
unified shape now.

**Step 4: Session dispatch.** Verify ctx-build via
`session.dispatch(...)` populates `transport: "in-process"`. Should
be a one-line addition.

**Step 5: `wrap-handler` audit.** Check `@agentick/tool/transforms/wrap-handler.ts`
for any ctx-shape assertions or mutations. Update if needed.

**Step 6: Conformance fixture.** `spec-conformance-next` ships a
`fakeToolHandlerCtx({ transport?, ... })` factory so test code uses
one canonical builder instead of hand-rolling ctx objects per spec.

**Step 7: Adopter sweep.** Examples + READMEs use the unified ctx
vocabulary.

### 4. Naming for the sugar surfaces

Per ADR 42's naming rules: no "Harness" in adopter-visible types. The
sugar surface aliases are:

- `Elicit` — exists (added in #171d.2).
- `Tasks` — TODO (adds during #171d.3 or related). Today `ctx.tasks` is
  raw `TasksHarnessProtocol`; the sugar layer will be a separate
  decision (see TL;DR §7).
- `Prompts` — exists; lives on `server.prompts` (per-server access),
  not in `ctx`.

`ctx.elicit` is the canonical example. `ctx.elicitation` (raw
protocol) stays — power users can reach for it when the sugar is too
narrow. The convention: `<noun>` for sugar, `<noun>ation` /
`<noun>HarnessProtocol` for raw protocol where overlap exists. Not
ideal English; pragmatic naming.

### 5. What this ADR does NOT decide

- **The `Tasks` sugar surface.** When `ctx.tasks` becomes sugar vs.
  stays raw protocol. Defer — settle during #171d.3 or a tasks-sugar
  slice.
- **`ctx.sample` for sampling.** Lands when `SamplingHarness` lands —
  same pattern as `ctx.elicit`, deferred until the harness exists.
- **`ctx.roots` for workspace roots.** Lands with #124.
- **`ctx.user` typing convergence.** MCP has `McpAuthenticatedUser`;
  in-process sessions may have their own auth principal type. Settle
  when in-process auth becomes a thing; today `user` lives only under
  `ctx.mcp` because in-process flows don't authenticate.
- **`metadata` shape.** Free-form by design; per-call adopter
  extension slot.

---

## Audit — backprop surfaces

| Seam | Blast | Notes |
| --- | --- | --- |
| Tool handler authors | **none** (ADD-only) | optional fields only; existing handlers untouched |
| Tool-executor in-process ctx-build | moderate | populates `transport: "in-process"` + new sugar |
| MCP server projection ctx-build | moderate | re-anchor on unified shape; nest extras under `mcp:` |
| Session dispatch | small | one ctx-build call site |
| Loop executor | small | one ctx-build site, same shape |
| MCP client tool wrapping | small | catches `UrlElicitationRequired` already; ctx shape ignored |
| Sandbox tools | small | don't peek at MCP-specific |
| `wrap-handler` transform | moderate | audit for ctx-shape assertions / mutations |
| Conformance suites | small | `fakeToolHandlerCtx()` factory in spec-conformance |
| Workspace tests | moderate | many specs hand-roll fake ctx — migrate to factory |
| Examples + READMEs | small | ADD-only means no breakage; prefer-new-shape sweep |
| DevTools | small | ctx visualizers may want `transport` badge |
| Eval | small | shares in-process tool-executor path |

**Total estimate: ~3-4 days** for the ADD-ONLY landing across these
seams.

---

## Migration plan

### Slice 1 (this ADR + minimal spec changes)
Land the spec-level additions (`transport`, `mcp?`, `McpRequestExtras`,
the `McpRequestContext` alias). Update every existing ctx-build site
simultaneously so the `transport` field is populated. Typecheck +
workspace tests pass. Single commit. ~1 day.

### Slice 2 (tool-executor)
In-process ctx-build emits the new sugar `ctx.elicit?` by wrapping the
local `ElicitationHarness` via a minimal `buildSessionElicit(harness)`
factory in `@agentick/elicitation`. Test that a tool handler
running in-process can call `ctx.elicit.text(...)` identically to the
MCP-server case. ~1 day.

### Slice 3 (`wrap-handler` audit + workspace test fixture sweep)
Tour the wrap-handler transform; introduce
`spec-conformance-next/testing/fake-tool-handler-ctx.ts`. Migrate
in-tree tests to use the factory. ~1 day.

### Slice 4 (examples + READMEs)
Sweep `example/*` + every adopter-facing README snippet to use the
unified ctx vocabulary; remove any code that special-cases
`McpRequestContext` vs. `ToolHandlerCtx`. ~0.5 day.

### Slice 5 (deprecation phase, future)
Once all in-tree callers use the unified shape, mark the standalone
`McpRequestContext` import path as `@deprecated` (the alias still
works); collapse to a true type alias in a future tidy-up. Optional
— the alias works correctly today.

---

## What this ADR is NOT

- **A v2 versioning bump.** ADD-only, no breaking change.
- **A claim that all transports use identical implementations.** The
  populating CODE differs per transport; only the SHAPE the handler
  sees is unified.
- **A unification of `Elicit` / `Sample` / `Roots` interfaces with
  the in-process raw protocols.** The sugars are convenience shells
  over the protocols; both stay accessible.

---

## See also

- ADR 26 — harness API shape (the BaseHarness contract these ctxs flow
  out of)
- ADR 27 — modular built-ins (the `ctx.elicit?` optionality follows
  this principle)
- ADR 40 — MCP server harness shape (where `McpRequestContext` was
  born)
- ADR 41 — `AgentickError` hierarchy (`UrlElicitationRequired` is the
  cross-transport class produced by `ctx.elicit.requireUrls()` —
  symmetric in-process + MCP)
- ADR 42 — harness-slot trichotomy (the convention `Elicit` /
  `Prompts` / `Tasks` aliases derive from)
