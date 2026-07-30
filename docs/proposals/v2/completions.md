# Completions — argument completion as a first-class seam

**Status:** DESIGN — written 2026-07-30, pre-implementation. Reviewed in-session
with Ryan; the verdicts in §6 were argued live and are settled unless new
evidence arrives.

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

| Surface                                               | Support                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP client harness** (agentick → remote MCP server) | ✅ `mcp:complete` cmd; `completePromptArgument(name, arg, value)`, `completeResourceTemplate(uri, variable, value)` (Wave 2, #146)                               |
| **MCP server harness** (agentick serving MCP clients) | ✅ `completions.{prompts,resources}` config — but **ctx-free**: `CompletionContext = { resolvedArguments }` only; no identity, no services (Knowify-port gap #3) |
| **Native prompts harness** (`PromptDeclaration`)      | ❌ no per-arg seam of any kind                                                                                                                                   |
| **agentick client wire** (session RPC → client-core)  | ❌ no verb                                                                                                                                                       |

Both MCP **edges** have completion; the native **middle** is empty. An
agentick-wire client (ernesto) has no path to any completion — which is why
Knowify's `RunnableRegistry.complete()` answers `[]` for prompts today, with a
`TODO(prompts-complete)` at the branch.

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
the **declared dependencies / sibling args**, and a **real ctx** — the same
`ToolHandlerCtx` shape tool handlers get (ADR 43: one ctx shape, transport
discriminated). That last point is the fix for the MCP server harness's
ctx-free completion: identity-scoped completion (`knowify://me`-class problems)
becomes possible because the resolver is dispatch-resolved like any handler.

### 2.2 Naming — register once, reference anywhere

```ts
import { defineCompletions } from "@agentick/completions";

const completions = defineCompletions({
  "knowify.jobs":   completeFromAsync((value, ctx) => jobsApi.search(value, ctx)),
  "knowify.phases": completeDependent({ requires: ["job"] }, (v, { job }, ctx) =>
    phasesApi.search(v, job, ctx)),
});

// A declaration references by NAME — a string crosses the spec firewall the
// way handlerRef does; a function never does.
{ name: "job", required: true, complete: "knowify.jobs" }
```

Same dichotomy as every other slot: the inline function is the declarative
shorthand (auto-registered under a derived name at construction); the named ref
is the reusable form. In **spec-land the declaration carries only
`completeRef?: string`** — the resolver itself is registry-resident, exactly the
`handlerRef` pattern. This is what Knowify v1 never had and paid for: every
prompt re-imported `searchJobs` and re-wrapped it.

### 2.3 Resolving — programmatic, wire, and UI

```ts
// Server-side, anywhere a ctx exists:
const r = await ctx.completions.resolve("knowify.jobs", { value: "mil", args: {} });

// Client (agentick wire):
const r = await session.complete({
  ref: { type: "prompt", name: "tm_change_order_actual_cost" },
  argument: { name: "phase", value: "fra" },
  context: { arguments: { job: "Miller Residence" } },
});
// → { values: ["Framing", "Framing – CO #2"], total?: n, hasMore?: bool }
```

One generalized wire verb, **MCP-shaped on purpose** (`ref`-discriminated), so
squaring up with MCP costs a projection, not a translation. `ref.type` opens as
`"prompt"`; `"resource"` and `"tool"` are additive later (§5).

### 2.4 The two MCP projections

- **Outward (server harness):** `completion/complete` for `ref/prompt` resolves
  through the prompts harness's completion seam — the SAME resolvers, now with
  real ctx (`bearerTokenAuth` → `ctx.mcp.user` reaches completion, closing
  gap #3). The MCP wire applies MCP's constraints at the wire: 100-value cap +
  `hasMore` truncation happen in the projection, **not** in the primitive or
  the builders. (v1 baked the cap into the builders; v2 deliberately does not —
  wire constraints live at the wire.)
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
registry; resolver ctx **borrows the `ToolHandlerCtx` shape** (ADR 43) so a
resolver reads like a tool handler; own wire verb.

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
  `completeRef` on `PromptArgumentDeclaration`), registry + `resolve` door with
  `ToolHandlerCtx`-shaped ctx, the five builders + `normalizeCompletionResult`,
  conformance + `/testing` doubles. Prompts harness threads declarations.
- **P2 — agentick wire.** `complete` session RPC (ref-discriminated),
  client-core handle, gateway route.
- **P3 — MCP squaring.** Server-harness `completion/complete` resolves through
  the seam (ctx restored; cap-100 at the wire). Client-harness forwarding
  resolvers wait on the MCP-prompts-fold (separate work).
- **P4 — consumers.** ernesto-client `RunnableSources.prompts.complete` +
  registry prompt branch (kills the `TODO(prompts-complete)`); later
  `flatArgsOf` for tools.

Every claim above lands with a test or lives in a "Roadmap & known gaps"
section — nothing here is verified until `@verifiedBy` says so.
