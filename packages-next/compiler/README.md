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
| Intrinsic helpers: `sectionEntry`, `messageEntry`, `headerBlock`, `codeBlock`, `jsonBlock`, `textBlock` | Pure functions producing `RenderedTree` IR fragments — adapter host-configs call these when their native AST walk encounters the corresponding tag |

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

## Verified by

- `src/__tests__/use-data.spec.ts` — suspend-via-throw contract,
  de-duplication, cache isolation across renders, rejection caching,
  out-of-scope throw
- `src/__tests__/intrinsics.spec.ts` — IR-fragment shape for every
  intrinsic helper

## Status & roadmap

**Shipped (Phase 1a — ADR 39):**
- `useData` + RenderContext + stack-discipline
- Intrinsic helpers (section, message, h1-h6, code, json, text)

**Next (Phase 1b):**
- `@agentick/compiler-react-next` — react-reconciler-backed adapter,
  exports JSX-shaped components (`<H1>`, `<Section>`, …) and a
  `compileToTree(element, opts): Promise<RenderedTree>` entry point

**Future:**
- `@agentick/compiler-angular-next` — Angular change-detection adapter
- `@agentick/compiler-solid-next` — Solid reactive-primitive adapter
- Reconciler-react-next refactor: delegate intrinsic-handling to
  compiler-react-next + compiler-next helpers (Phase 3, optional)

## Known gaps

- **Intrinsic vocabulary is initial.** Headers (h1–h6), section,
  message, code, json, text. Missing: `<List>`, `<Table>`, `<Image>`,
  `<Document>`, audio / video. Add as concrete use cases drive them.
- **Cross-render caching is opt-in.** `useData`'s cache lives on the
  RenderContext, which is fresh per compile. Adopters who want
  cross-render caching (e.g. server-side memoization) wrap the
  fetcher with their own cache. Future work may add a `cache` option.
- **No streaming render.** Compile returns a final IR. Future:
  `compileStream(...)` yielding fragments as they stabilize.
