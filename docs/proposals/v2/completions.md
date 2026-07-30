# Completions — argument completion as a first-class seam

**Status:** P1 LANDED 2026-07-30 (`d217ee13`, #244) — spec seam,
`@agentick/completions`, the mcp builder lift, prompts threading, and the
`definePrompt`/`defineCompletion` singular rule are in-tree.
**P2 LANDED 2026-07-30** — `PromptsHarness.complete` (the three-arm outcome),
the `completions/complete` wire route, the derived client method, and
`WireExtension.journal` (the per-method durability declaration that keeps a
per-keystroke verb out of the gateway journal); `ctx.completions` is now
populated. P3–P4 remain. Reviewed in-session with Ryan; the verdicts in §6 were
argued live and are settled unless new evidence arrives.

**Reads before this:** blueprint/27-modular-built-ins.md (package pattern),
ADR 43 (unified handler ctx), ADR 66 (dispatch-resolved ctx),
docs/proposals/v2/blueprint/40-mcp-server-harness.md (Mode A/B, projections).

---

## 1. Problem

A user typing into a command form needs the machine to finish their sentence:
`/tm_change_order_actual_cost` asks for a `job` and a `phase`, and the honest
answer to "which job?" is a lookup against the tenant's data — filtered by what
was typed, **conditioned on the sibling arguments already filled** (the phases
of _that_ job), and executed with the caller's identity.

MCP names this `completion/complete`. v1 (`@agentick/mcp-v1`) shipped it well:
per-arg resolvers on prompt definitions, a full handler ctx (identity included),
`resolvedArguments` for conditional completion, and a five-builder sugar family.
Production code exists (Knowify's `tm_change_order_actual_cost` completes jobs,
then phases-given-job).

### Where v2 stands today (verified 2026-07-30)

| Surface                                               | Support                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP client harness** (agentick → remote MCP server) | ✅ `mcp:complete` cmd; `completePromptArgument(name, arg, value)`, `completeResourceTemplate(uri, variable, value)` (Wave 2, #146)                                                                                                                                               |
| **MCP server harness** (agentick serving MCP clients) | ✅ `completions.{prompts,resources}` config; `CompletionContext extends OperationCtx` (identity via `ctx.mcp.user` — gap #3 CLOSED by the ctx-spine work). Builders live here with the v1 cap-100 baked in (`protocol/completions.ts`) — the wrong home per §4/§5; P1 lifts them |
| **Native prompts harness** (`PromptDeclaration`)      | ✅ P1/P2 — `complete` on the argument descriptor (inline resolver or named ref) and `PromptsHarness.complete` resolving it                                                                                                                                                       |
| **agentick client wire** (session RPC → client-core)  | ✅ P2 — `completions/complete`; the client method derives from the wire row                                                                                                                                                                                                      |

Both MCP **edges** had completion; the native **middle** was empty. The rows
above read as of P2 — the columns marked ❌ when this was written are what P1/P2
closed. Knowify's `RunnableRegistry.complete()` still answers `[]` for prompts
until P4 wires its prompt branch to the verb (`TODO(prompts-complete)` at the
branch).

The consumer chain **already exists and is waiting** (nx-knowify, landed
2026-07-30): composer slot-completion UI (`4ddd8ce8f8f`) → `completeArg` input →
`RunnableRegistry.complete(name, arg, value, args)` (`990083d90d9`) → _here the
wire ends_. LocalCommand completers resolve through it end-to-end already; this
proposal gives server prompts the same ride.

---

## 2. The shape, walked as usage

### 2.1 Declaring — a prompt whose args complete

```ts
import { definePrompts } from "@agentick/prompts";
import { completeDependent, completeFromAsync, completeFromList } from "@agentick/completions";

const prompts = definePrompts({
  prompts: [{
    name: "tm_change_order_actual_cost",
    description: "…",
    arguments: [
      { name: "job",        required: true,
        complete: completeFromAsync(async (value, ctx) =>
          (await jobsApi.search(value, ctx)).map((j) => j.name)) },
      { name: "phase",      required: true,
        complete: completeDependent({ requires: ["job"] }, (value, { job }, ctx) =>
          phasesApi.search(value, job, ctx)) },
      { name: "markup_pct", required: false,
        complete: completeFromList(["10", "15", "20", "25", "30"]) },
    ],
    render: …,
  }],
});
```

Inline functions are the common case. The resolver receives the **typed value**,
the **declared dependencies / sibling args**, and a **real ctx** —
`CompletionCtx extends OperationCtx` plus its boundary facets, the exact
pattern the MCP server's `CompletionContext` already follows (spec's
`runtime-context.ts` names completion as an `OperationCtx` seam alongside
`ResourceResolver` and `PromptDeclaration.render`). Identity-scoped completion
(`knowify://me`-class problems) works because the resolver is minted in-fiber
like any operation — NOT `ToolHandlerCtx`: a keystroke query has no
`toolCallId`, no `task` mode, no `transport` discriminator, and the `Derived`
brand makes fabricating them a compile error. The one dispatch extra completion
genuinely shares is the `AbortSignal` (latest-wins cancellation), carried as a
boundary facet.

**`definePrompt()` (singular)** ships alongside: identity + **inference** (no
brand — nothing discriminates a single declaration; it always arrives inside a
seed list or module barrel). A const generic over the `arguments` literal types
`render(args)` — required → `string`, optional → `string | undefined`,
`schema` present → its inferred output — and types `completeDependent`'s
sibling-deps the same way. Law settled with it: **no schema → the arg is a
string** (MCP parity); want a number, declare a schema.

### 2.2 Naming — register once, reference anywhere

```ts
import { defineCompletions } from "@agentick/completions";

const completions = defineCompletions({
  sources: {
    "knowify.jobs":   completeFromAsync((value, ctx) => jobsApi.search(value, ctx)),
    "knowify.phases": completeDependent({ requires: ["job"] }, (v, { job }, ctx) =>
      phasesApi.search(v, job, ctx)),
  },
});

// Or the file-grammar form: one source per file via the SINGULAR, folded by a
// barrel. defineCompletion returns the resolver itself carrying its canonical
// name (dual-use: barrel entry, or handed straight to a `complete:` slot).
export default defineCompletion("knowify.jobs", completeFromAsync(…));
defineCompletions({ sources: [jobs, phases] }); // duplicate names throw at define time

// A declaration references by NAME — a string crosses the spec firewall the
// way handlerRef does; a function never does.
{ name: "job", required: true, complete: "knowify.jobs" }
```

Same dichotomy as every other slot: the inline function is the declarative
shorthand — it rides the prompts sidecar exactly like `render`, and the record
gets a `completeRef` (the resolver's own `completionName` when it has one, else
the derived `prompt:<prompt>:<arg>`; the `prompt:` prefix is reserved). The
named ref is the reusable form. In **spec-land the record carries only
`completeRef?: string` (+ projectable `completeRequires`)** — the resolver
itself is sidecar- or registry-resident, exactly the `handlerRef` pattern.
Nothing self-registers at import (an ambient registry has no answer to "which
session?"); `defineCompletions` is an options bag (`{ sources }`, deliberately
NO `store` — nothing serializable to hold) so future knobs like
`guards: { resolve }` land flatly. This is what Knowify v1 never had and paid
for: every prompt re-imported `searchJobs` and re-wrapped it.

### 2.3 Resolving — programmatic, wire, and UI

```ts
// Server-side, anywhere a ctx exists:
const r = await ctx.completions.resolve("knowify.jobs", { value: "mil", args: {} });

// Client (agentick wire) — `session` here is a client `SessionHandle`:
const r = await session.completions.complete({
  ref: { type: "prompt", name: "tm_change_order_actual_cost" },
  argument: { name: "phase", value: "fra" },
  context: { arguments: { job: "Miller Residence" } },
});
// → { values: ["Framing", "Framing – CO #2"], total?: n, hasMore?: bool }
```

One generalized wire verb, **MCP-shaped on purpose** (`ref`-discriminated), so
squaring up with MCP costs a projection, not a translation. `ref.type` opens as
`"prompt"`; `"resource"` and `"tool"` are additive later (§5).

The client method is **derived, not written**: `completions/complete` is a
`WireMethods` row whose params carry a bound `sessionId`, so
`session.completions.complete(params-minus-sessionId)` falls out of the wire
proxy with zero client code. There is no `session.complete` base-handle method —
the namespace segment IS the verb's home.

Two things the route owns that no single harness can. First the **two-hop join**:
it asks `prompts.complete` (which runs an inline sidecar resolver and answers
`resolved`, or hands back a `completeRef` it will not chase), then resolves a
returned ref against the session's registry. The sidecar path therefore needs no
completions namespace at all — prompts with inline resolvers completes over the
wire on its own. Second, **silence over faults**: no prompts surface, an argument
that declares no completion, a ref nobody bound, a restored session with no
sidecar — all `{ values: [] }`, MCP parity. Only an unknown PROMPT errors.

And the durability question the gateway forced. Every wire dispatch mints a
`wire:<method>` boundary op whose `requested` + `terminal` envelopes journal by
default — so routing completion over the wire would have moved the per-keystroke
journal flood from the harness (where `resolve` is a plain method precisely to
avoid it) up one layer to the gateway. The fix is a declaration, not a
special case: `WireExtension.journal` lets a method state its own disposition
(`"bus-only"` here — live observers still see the traffic), and the gateway folds
it into its journaling policy keyed by the op name it alone derives. The gateway
never names a namespace, an adopter's explicit `policy.override` still outranks
the declaration, and the next high-cadence verb declares the same thing instead
of adding another hardcoded string. What still journals per keystroke is the
gateway's own `authorizer:command:authorize` op — a security audit record with a
different owner, deliberately left alone.

### 2.4 The two MCP projections

- **Outward (server harness):** `completion/complete` for `ref/prompt` resolves
  through the prompts harness's completion seam — the SAME resolvers serving
  both wires (ctx already carries identity there; gap #3 closed independently).
  The MCP wire applies MCP's constraints at the wire: 100-value cap +
  `hasMore` truncation happen in the projection, **not** in the primitive or
  the builders. (v1 baked the cap into the builders, and v2's mcp package
  inherited that — every builder in `mcp/src/protocol/completions.ts` calls
  `clamp()` internally. P1 lifts the builders into `@agentick/completions`
  WITHOUT the clamp; mcp re-exports them and keeps `COMPLETION_MAX_VALUES`
  in `projection/completions.ts` only — wire constraints live at the wire.)
- **Inward (client harness):** when MCP-origin prompts fold into the native
  prompts surface (not yet built — they currently live on the MCP client
  harness), their completion is a **forwarding resolver**: same seam, resolver
  body = `completePromptArgument(...)` against the origin server. Four
  surfaces, one seam.

### 2.5 The already-landed consumer (Knowify)

`ErnestoConversation.completeArg` → `RunnableRegistry.complete()` → **today**
`[]` for prompts. After §2.3's verb: `RunnableSources.prompts` gains
`complete(input)`, the registry's prompt branch calls it, and
`/tm_change_order_actual_cost`'s job slot pops live candidates in the composer
with zero further UI work.

---

## 3. Result currency

```ts
interface CompletionResult {
  readonly values: readonly string[];
  readonly total?: number; // full match count, when the source knows it
  readonly hasMore?: boolean; // values is a prefix of the real answer
}
```

Identical to v1/MCP. Resolvers may return `readonly string[]` (sugar for
`{ values }`) or a full result; `normalizeCompletionResult` folds. **No cap in
the primitive** — see §2.4.

---

## 4. The builders (ported from v1, one deliberate change)

| Builder                               | Semantics                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `completeFromList(values)`            | static list, prefix-filtered                                                  |
| `completeFromEnum(zodEnum)`           | `.options` of a Zod 3/4 enum (structural), prefix-filtered                    |
| `completePrefixMatch(loader)`         | lazy full-set loader (sync/async), sugar filters                              |
| `completeDependent({ requires }, fn)` | declared sibling dependencies; unmet → `{ values: [] }` without invoking `fn` |
| `completeFromAsync(fn)`               | escape hatch — full `CompletionResult` control                                |

The deliberate change: **no 100-cap inside the builders** (v1 clamped there).
The cap is MCP's, applied at the MCP projection. The agentick wire may choose
its own advisory limit, also at its wire.

`completeDependent.requires` is declaration **metadata**, not just control
flow: it projects to clients, so a composer can know "phase is not completable
until job is filled" without issuing a doomed request.

---

## 5. Where it lives — the staged fight

**Option A — completion sources are runtime-exposed tools.** Registration,
scoping, provenance, handler-ctx, interceptors, and a wire dispatch all exist;
`defineCompletion` would be sugar over a tool with a conventional result shape.
Maximum primitive-reuse, zero new registry.

**Option B — a dedicated (small) completions facility.** Own name→resolver
registry; resolver ctx is **`OperationCtx` + boundary facets** (the
`CompletionContext` precedent) so a resolver reads like every other starved
seam (`render`, `ResourceResolver`); own wire verb.

**Verdict: B.** A's steel-man breaks on three concrete failures, not taste:

1. **Journal/timeline pollution.** Tool dispatches are events — recorded,
   observable, semantically "things that happened." Completions fire per
   keystroke and are ephemeral _queries_; running them through dispatch either
   floods the journal or demands a "don't record this dispatch" flag, which is
   a second dispatch semantics hiding inside the first.
2. **Envelope mismatch.** Tools return the ADR 70 result currency
   (content blocks / structuredContent envelope); completion wants
   `{ values, total?, hasMore? }`. Every consumer would unwrap an envelope to
   find a list.
3. **List pollution.** Every tools-enumeration surface (client tool lists,
   MCP projections, debugging) would carry completion plumbing filtered out by
   convention — a leak with no owner.

What survives from A: the **ctx shape** (borrowed wholesale), and the note that
a source MAY wrap a dispatch (`completeFromAsync((v, ctx) =>
ctx.tools.dispatch(...))`) — the seam doesn't preclude composition, it just
refuses to make dispatch the substrate.

**Package home:** `@agentick/completions` — a small harness-pattern package per
ADR 27 (augment/extension/conformance/testing), depended on by `prompts` (and
later `tool`, `resources`). It is a registry + resolve door, not a subsystem.

---

## 6. Verdicts recorded (argued 2026-07-30, do not silently re-litigate)

- **No "command" vertical in agentick.** "Like tools but not session-tied"
  is already tools (provenance layers 1–3). Server-side command = dispatch-
  exposed tool (does) or prompt (composes); client-side = app-land LocalCommand
  (shipped in ernesto-client). The palette/runnable fold stays userland until
  the absorption rule's bar is met. The one framework-side gap worth building:
  a `flatArgsOf(inputSchema)` projection so dispatch-exposed tools can get
  composer slots + completion (§7 P4).
- **No `Action` supertype under Tool.** One consumer (itself) after "command"
  decomposes; maximal cost at the framework's most load-bearing type. Unchanged
  from the agent-native `defineAction` analysis.
- **Tool-arg completion is in-scope eventually** (`ref: { type: "tool" }`) —
  agentick may exceed MCP here (MCP completes only prompts/resource-templates);
  the generalized ref makes it additive.

## 7. Phasing

- **P1 — primitive.** `@agentick/completions`: spec types (`CompletionResult`,
  `completeRef` on `PromptArgument`), registry + `resolve` door with
  `CompletionCtx extends OperationCtx` (+ `AbortSignal` facet), the five
  builders (LIFTED from `mcp/src/protocol/completions.ts`, clamp stripped) +
  `normalizeCompletionResult`, conformance + `/testing` doubles, per-harness
  layout mirroring `@agentick/resources`. Prompts harness threads declarations
  (inline fn → sidecar like `render`, auto-registered under a derived name;
  record carries only the string ref). `definePrompt()` factory in
  `@agentick/prompts`.
- **P2 — agentick wire. LANDED.** `PromptsHarness.complete` (the three-arm
  `resolved` / `ref` / `unavailable` outcome, a plain method for the same journal
  reason `resolve` is one); the `completions/complete` route in
  `@agentick/completions`, registered through `builtinWireExtensions`; the derived
  client method (no hand-written handle); `WireExtension.journal` so the verb's
  gateway boundary op stays out of the journal; `ctx.completions` populated at the
  app's `ctxExtensions` site.
- **P3 — MCP squaring.** Server-harness `completion/complete` resolves through
  the seam (ctx restored; cap-100 at the wire). Client-harness forwarding
  resolvers wait on the MCP-prompts-fold (separate work).
- **P4 — consumers.** ernesto-client `RunnableSources.prompts.complete` +
  registry prompt branch (kills the `TODO(prompts-complete)`); later
  `flatArgsOf` for tools.

Every claim above lands with a test or lives in a "Roadmap & known gaps"
section — nothing here is verified until `@verifiedBy` says so.
