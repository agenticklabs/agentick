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

## Mechanism (sketch; compiler-general)

- **The compose point** is the root: `createApp/run(rootElement)` composes `rootElement` with the
  framework default surfacing layer before the compiler folds it. Implementation options (decided
  at build): a default root wrapper the user root nests in, OR per-primitive **default folds** the
  compiler applies for any primitive the tree did not explicitly render. Either keeps the output a
  real tree.
- **Override = most-specific-wins.** An explicit component for a primitive replaces that primitive's
  default node (e.g. any `<Timeline>` in the tree suppresses the default timeline fold). Same
  cascade discipline as everywhere else.
- **Compiler-general.** React's *absence of a component* and the functional compiler's *`ctx`
  default* are the same concept — the default surfacing is a compiler-level notion, not React's.
  `<Timeline>` (React) and `ctx.timeline(fn)` (functional) are equal override front-ends.

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

## Open / build-time decisions
1. The exact compose mechanism (default root wrapper vs per-primitive default folds).
2. Resources default: catalog-list vs nothing-in-IR (leaning catalog-list — the model needs to
   know what it can pull; ADR 62's client-consumption composes with it).
3. Override granularity (whole-primitive vs partial — e.g. `<Message>` reshaping only some blocks).

## Scope
The surfacing model. Realized incrementally: default folds for the primitives that already have
components (timeline, tools) first; resources/roots/MCP-info default components with Wave 4b. The
reconciler→compiler rename (#243) is the separate mechanical sweep that aligns the name.
