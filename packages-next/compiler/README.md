# @agentick/compiler-next

AST-agnostic core for the JSX-template compiler pipeline. Per
[ADR 39](../../docs/proposals/v2/blueprint/39-jsx-template-walker.md):
each framework adapter (React, Angular, Solid, …) uses its **native
runtime** for AST walking + suspend semantics. This package ships the
cross-runtime contract — no walker, no dispatch table, no adapter
abstraction.

> Pre-1.0. Foundation for compiler-react-next + future Angular / Solid
> compilers. ADR 39 Phase 1.

## What lives here

| Surface                          | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `useData(key, fetcher)`          | Universal suspend-via-throw primitive — works in any framework whose runtime catches thrown Promises (React Suspense, Solid resources, etc.) |
| `RenderContext`                  | Ambient per-render cache + pending state `useData` reads from    |
| `withRenderContext` / `getRenderContext` / `createRenderContext` | Stack-discipline scope helpers (no `node:async_hooks`, runs on any JS runtime) |
| `isThenable`                     | Re-exported from `@agentick/utils-next`                          |
| **Intrinsic helpers** (pure functions producing `RenderedTree` IR fragments — adapter host-configs call these when their native AST walk encounters the corresponding tag) ||
| Context entries: `sectionEntry`, `messageEntry`                                                                                  | Section / role-bearing message — top-level context entries |
| Text + headings: `textBlock`, `headerBlock`                                                                                      | Plain text + semantic heading (level → markdown/xml/text via formatter) |
| Code / data: `codeBlock`, `jsonBlock`, `xmlBlock`, `htmlBlock`, `csvBlock`, `reasoningBlock`                                     | Code + structured data + reasoning content blocks |
| Media: `imageBlock`, `documentBlock`, `audioBlock`, `videoBlock`                                                                 | Typed media content blocks (per-helper mimeType union) |
| Events: `userActionBlock`, `systemEventBlock`, `stateChangeBlock`                                                                | Timeline event-content (static event-block construction) |
| Custom: `customBlock`                                                                                                            | Adopter-defined `<custom tag="…" content="…">` block |
| Semantic-html mapping: `SEMANTIC_HTML_TAGS`, `isSemanticHtmlTag`, `getSemanticHtmlEntry`                                         | Lowercase-tag → SemanticType lookup table (h1-h6, strong, em, lists, table, …) |
| **Formatter scope** (ADR 39 Phase 3 Step 3a): `FORMAT_INTRINSIC_TAG`, `isFormatTag`, `parseFormatProps`                          | `<format>` tag name + props parser (formatter ref + optional purpose) |
| `WalkScope`, `FormatterScope`, `FormatterBinding`, `createWalkScope`, `EMPTY_WALK_SCOPE`, `withFormatter`, `resolveFormatter`    | Immutable formatter binding threaded through an adapter walker. Section/message dispatch stamps `renderedWith` from the active scope. |

**Formatting is NOT this package's job.** The compiler produces
`RenderedTree` (the IR). Serialization (`RenderedTree → string` for
markdown / xml / text) lives in `@agentick/formatters-next`. Intrinsic
helpers emit SEMANTIC content (e.g. headings carry
`semanticNode: { semantic: "heading", props: { level: 1 } }`) — the
formatter chooses syntax. This keeps the IR format-agnostic: the same
template renders to markdown, XML, or any future formatter without
re-walking.

## What does NOT live here

Deliberately absent — these belong in per-framework packages because
each runtime supplies its own:

- AST walker / commit pipeline (React → react-reconciler; Angular → change detection; Solid → reactive primitives)
- Dispatch table (each adapter dispatches by tag in its native pipeline)
- Compile-until-stable loop (each framework runtime handles thrown-Promise retry natively — React Suspense, Solid, etc.)
- `defineCompiler` / `Compiler` abstraction (over-engineering; framework adapters expose a simple `compileToTree(element, opts): Promise<RenderedTree>`)

## Quick start

Adopters don't typically import from `compiler-next` directly — they
import from a framework adapter (e.g. `@agentick/compiler-react-next`).
`useData` IS the one exception: templates that load data import
`useData` from here (or re-export-side from their adapter).

```ts
import { useData } from "@agentick/compiler-next";
import { H1, List, ListItem } from "@agentick/compiler-react-next";  // future

export default function Endpoints() {
  const items = useData("endpoints", () => fetch("/api/endpoints").then((r) => r.json()));
  return (
    <>
      <H1>API Endpoints</H1>
      <List>{items.map((e) => <ListItem key={e.path}>{e.method} {e.path}</ListItem>)}</List>
    </>
  );
}
```

## Why stack-discipline (not async_hooks, not Effect)

`useData` needs ambient context inside USER function components (plain
JS). Three approaches were considered:

| Approach                  | Verdict                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `node:async_hooks`        | Node-only. Won't work on browser, Deno, Bun, edge runtimes. Rejected. |
| Effect FiberRef           | Doesn't propagate into plain-JS user components. Wrong layer. Rejected. |
| **Stack-discipline singleton** | Lexically-scoped module state. Safe under the contract: `withRenderContext` wraps SYNCHRONOUS work only; suspended Promises are awaited OUTSIDE the wrapper. Works on every JS runtime. ✓ |

The contract: callers (framework adapters) MUST NOT `await` inside
`withRenderContext`'s body. They set the context, drive a sync render
pass, restore on exit. Concurrent compile invocations are safe because
their setup/teardown is bounded by the sync pass — no two ever hold
the singleton across an await.

## `<format>` and WalkScope (Step 3a)

`<format formatter={ref} purpose?>` is a passthrough intrinsic that
derives a new `WalkScope` for its descendants. An adapter walker
recognizes the tag via `isFormatTag(tag)`, parses props via
`parseFormatProps(props)`, and threads the derived scope down via
`withFormatter(scope, binding)`. Section/message dispatch then reads
`resolveFormatter(scope, "section" | "message")` and stamps the
formatter onto produced `ContextEntry`s as `renderedWith`.

`purpose` is honored ONLY for `"section"` and `"message"` today;
spec-valid values for `"context"` / `"free-root"` / `"resource"` /
`"output"` are silently downgraded to default-scope replacement —
those dispatch sites haven't landed in any walker yet. See the
inline doc on `SUPPORTED_PURPOSES` in `format-intrinsic.ts` for the
rationale + Phase 4+ pointer.

`WalkScope` mirrors the structural shape of reconciler-next's
`HostScope` and is positioned to replace it in Step 3d (collect/
retirement). Until then, the two coexist — no new HostScope
consumers should be added.

## Verified by

- `src/__tests__/use-data.spec.ts` — suspend-via-throw contract,
  de-duplication, cache isolation across renders, rejection caching,
  out-of-scope throw
- `src/__tests__/intrinsics.spec.ts` — IR-fragment shape for every
  intrinsic helper
- `src/__tests__/semantic-html.spec.ts` — semantic-html mapping table
- `src/__tests__/format.spec.ts` — formatter pipeline (markdown / xml /
  text dispatch, framing rules)

## Status & roadmap

**Shipped (Phase 1a — ADR 39):**
- `useData` + RenderContext + stack-discipline
- Intrinsic helpers (section, message, h1-h6, code, json, text)

**Shipped (Phase 1b, ADR 39):**
- `@agentick/compiler-react-next` — react-reconciler-backed adapter,
  `compileToTree(element, opts): Promise<RenderedTree>` + `render()`
  composing with the formatter pipeline.

**Shipped (Phase 3 Step 1a):**
- Flat-block intrinsic helpers: media (image/audio/video/document),
  textual variants (xml/html/csv/reasoning), event blocks
  (user_action/system_event/state_change), customBlock.

**In progress (Phase 3):**
- Step 1b — semantic-html vocabulary (`<strong>`, `<em>`, `<list>`,
  `<table>`, etc.). Needs nested `SemanticNode` walker upgrade.
- Step 2 — `registerIntrinsic(tag, handler)` extension surface in
  compiler-react-next.
- Step 3 — reconciler-react-next refactors to delegate JSX→IR to
  compiler-react-next; differential gate against the existing test
  corpus.
- Step 4 — retire the unused contributor protocol from reconciler-next.

**Future:**
- `@agentick/compiler-angular-next` — Angular change-detection adapter
- `@agentick/compiler-solid-next` — Solid reactive-primitive adapter
- SpecConfig field helpers (model + output) — pending walker's
  WalkResult growing `specConfig` + `providerOptions` channels.

## Known gaps

- **Semantic-html vocabulary not yet ported** (ADR 39 Phase 3 Step 1b).
  Missing: `<strong>`, `<em>`, `<mark>`, `<a>`, lists (`<ul>` / `<ol>`
  / `<li>`), tables, blockquote, pre, `<br>` / `<hr>`. Needs walker
  upgrade for nested `SemanticNode` trees. Tracked.
- **SpecConfig helpers not ported.** `<model>` and `<output>` produce
  SpecConfig + ProviderOptions fragments (not ContentBlocks). Walker's
  WalkResult needs new channels; deferred (TODO at bottom of intrinsics.ts).
- **Cross-render caching is opt-in.** `useData`'s cache lives on the
  RenderContext, which is fresh per compile. Adopters who want
  cross-render caching (e.g. server-side memoization) wrap the
  fetcher with their own cache.
- **No streaming render.** Compile returns a final IR. Future:
  `compileStream(...)` yielding fragments as they stabilize.
