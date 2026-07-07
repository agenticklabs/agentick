# ADR 63 — Compiler surfacing: defaults are a default tree, not implicit IR

**Status:** PROPOSED 2026-07-07 (Fable + Ryan, workshopped). **Foundational** — governs how
state (timeline, tools, resources, …) reaches model input. **Builds on:** ADR 49 ("the tree is
the schema"), ADR 62 (resources = read-projection). **Ties:** the dep-less/functional compiler
aspiration; the reconciler→**compiler** rename (#243, the mechanical sweep — not done here). **Not
blocking the MCP waves; it defines how Wave 4b's surfacing is built.**

## The question

The framework's core is *compilers → IR → model input* (the React reconciler is one compiler; a
functional `agent((ctx) => IRNode[])` is another). Today a component is an **inclusion switch** —
`<Timeline/>` puts the timeline in context; its absence leaves it out. That means every agent
re-wires the same surfacings by hand. The tempting ergonomic fix — **implicit defaults** (the
compiler surfaces timeline/tools/etc. even when the tree doesn't) — appears to force a trade-off
against ADR 49's invariant that **"the IR contains only what the compiler rendered."**

## The invariant is right — keep it

"IR = only what the compiler rendered / the tree is the schema" is **correct and non-negotiable.**
It is what makes the model input *explicit and inspectable* — you can always answer "what did the
model actually see?" by reading the compiled tree. A compiler that *injects* content behind the
tree's back (magic not visible in the tree) breaks that and minimizes the compiler's role. **Do
not do that.**

## The resolution — defaults are a *default tree*, not implicit injection

The trade-off is false. Ergonomic defaults do **not** require implicit IR-injection; they require
**framework-provided default components the user's root is composed with.**

- Write nothing → your agent root is composed with a **default surfacing layer** that renders the
  standard nodes (fold the timeline, advertise tools, surface a connected MCP server's
  info/catalog).
- Write `<Timeline>{(entries) => …}</Timeline>` (or `<Message>{(content) => …}</Message>`,
  `<Resource>`, …) → you **override** the default node for that primitive.
- Either way, **the IR is exactly what the (possibly-default) tree rendered.** Nothing injected,
  nothing hidden. The default components are *real, inspectable nodes* — devtools shows them like
  any other. The invariant holds verbatim; the compiler's role is **strengthened** (it renders
  everything, defaults included), not minimized.

Analogy: the difference between a compiler with **implicit side-effects** (bad) and a framework
that ships a **default layout you compose with and can replace** (good — you didn't hand-write it,
but you can see and override it).

## Mechanism (finalized 2026-07-07, with Ryan)

The mechanism is **harness projection**, NOT a new channel/combination-strategy layer. Two false
starts clarified it:
1. A single keyed "slot" that gets *replaced* — wrong, because **tools aggregate** from many
   sources (`<Tool>` + MCP + skills) rather than being source-exclusive like the timeline.
2. Keyed channels with per-channel `replace|accumulate|append` strategies — **over-machinery**: it
   re-invents accumulation the *harnesses already do* (the tool-executor unions tools; the timeline
   harness holds the log; the ResourcesHarness holds the registry).

**The fundamental: accumulation lives in the harnesses; surfacing just projects them. And
registration ≠ surfacing.**

- **Registration** (`<Tool>`, `<Resource>`, MCP client, a skill) feeds a *source* into its harness
  — the accumulation, upstream, with its existing API. Not a surfacing op.
- **Surfacing** = the compiler projecting each surfacing-capable harness → IR. Each harness has
  **exactly one projection**: the harness's **default** projection, or a component that **overrides
  that harness's projection**. So the `replace/accumulate/append` taxonomy dissolves — a harness is
  inherently one-or-many by its *own* nature (tool-executor accumulates, timeline is singular);
  the surfacing layer is uniform: *project (default) or custom-project (override)*.
- **Raw content** (`<Message>`/`<Section>`/`<Text>`) is the one true append stream — direct
  content contributions, no harness.

```ts
function compileTick(tree, ctx): RenderedTree {
  const content: ContextEntry[] = [];               // direct content — append, tree order
  const overrides = new Map<string, ProjectFn>();   // a component overriding ITS harness's projection

  collect(tree, {
    content: (entry)  => content.push(entry),        // <Message>/<Section>/<Text>
    project: (key, fn) => overrides.set(key, fn),    // <Timeline>{fn} / <Tools filter=…>
    // <Tool>/<Resource> are NOT here — they register into their harness (a source), upstream.
  });

  const projected = ctx.surfacingHarnesses.map((h) =>       // ONE projection per harness
    overrides.has(h.key) ? overrides.get(h.key)!(ctx) : h.project(ctx),  // custom else default (lazy)
  );
  return assemble(projected, content);               // provenance-tagged: authored:<key> vs default:<key>
}
```

- **Compiler-general.** React's override component and the functional compiler's `ctx` call are the
  same concept — both override a harness's projection by key. `<Timeline>{fn}` ≡ `ctx.timeline(fn)`.
- **Lazy defaults.** A harness's default `project` runs only when un-overridden (an overridden
  timeline is never folded).
- **Provenance** (`authored:<key>` / `default:<key>`) → devtools shows which layer produced each
  piece; ADR 49's inspectable-IR invariant holds.

### Per-connected-MCP-server (keyed by adopter alias, not the server's self-name)

A connected MCP server is **just another source** feeding agentick's harnesses (per the
fundamental), **namespaced by the adopter's connection alias** — the alias is agentick-assigned at
`withMCP({ servers: { github, linear } })`, so it's stable, unique, and **trust-safe** (the
server's self-reported `name` is untrusted — a server could claim `"github"`; the alias can't be
spoofed). The server's tools register into the tool-executor as `${alias}.${tool}`; its resources
into the ResourcesHarness as `mcp://${alias}/${uri}`; both route calls/reads back to that server's
`McpClientHarness`. The server's self-reported `name`/`description`/`instructions` are a **display
label** rendered by the one MCP-specific projection (`mcpServerInfo`, keyed by alias), never a key.

## Per-primitive defaults (uniform mechanism, different default)

The mechanism (default node + override) is uniform; the *default* differs by each primitive's
relationship to the model input:

| Primitive | Relationship | Default node |
|---|---|---|
| **Timeline, system/sections** | in-context **content** | **on** — fold the whole timeline / system prompt into IR. Override to filter/compact/reshape. |
| **Tools** | advertised **capability** | **on** — advertise all model-exposed tool schemas. Override to filter. |
| **Resources** | **pulled catalog** (application-controlled) | **catalog, not content** — surface the resource *list* so the model knows what it can pull; do NOT inline content (that would defeat what a resource is). Override to inline or suppress. |
| **MCP server name/description/instructions** | **self-description** (a distinct projection, not agentick's own IR) | surfaced as a `<McpServer>`-style context node when connected (ground-floor "what is this server"); overridable. NOT the same axis as the above — it's *about* a connected peer, rendered as content. |

## Inspectability is the safety valve

Default-on is only acceptable because the effective IR stays **fully inspectable**: devtools
renders the composed tree → IR, so "what did the model see, and which node put it there (default
or mine)?" is always answerable. This is what preserves ADR 49's spirit under defaults — the
schema is still the (composed) tree, and it's visible.

## Consequences

- **ADR 49 preserved**, not weakened: the tree is still the schema; the tree just has a
  framework-provided default portion you can override.
- **Wave 4b surfacing** (`withMCP` resources/roots/server-info) is built as **default components**
  under this model — overridable, inspectable, not injected. Resources default to *catalog*
  surfacing (per ADR 62 + the table above).
- **The dep-less compiler** inherits the same default-surfacing concept via `ctx`.
- Boilerplate drops (minimal agents write nothing) without any magic.

## Resolved (2026-07-07, with Ryan)
1. **Compose mechanism — RESOLVED:** harness projection (default/override) + content append; no
   channel/strategy layer (accumulation is the harnesses' job); registration ≠ surfacing. See
   Mechanism above.
2. **Resources default — RESOLVED:** catalog-list (the model needs to know what it can pull; ADR
   62's client-consumption composes).
3. **MCP per-server — RESOLVED:** alias-keyed sources feeding the existing harnesses; `mcpServerInfo`
   the one dedicated per-server projection; self-name is an untrusted display label.

### Still open (build-time)
- Override granularity within a projection (`<Message>` reshaping only some blocks vs whole-timeline
  custom projection) — the projection function's internal composition.
- The exact `collect` / `ContributorRegistry` signature the `content`/`project` split maps onto
  (verify as build step one).

## Scope
The surfacing model. Realized incrementally: default folds for the primitives that already have
components (timeline, tools) first; resources/roots/MCP-info default components with Wave 4b. The
reconciler→compiler rename (#243) is the separate mechanical sweep that aligns the name.
