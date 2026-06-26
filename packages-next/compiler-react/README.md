# @agentick/compiler-react-next

React adapter for the Agentick v2 JSX-template compiler. Per
[ADR 39](../../docs/proposals/v2/blueprint/39-jsx-template-walker.md):
compiles a React element tree (function components called as plain JS,
host elements dispatched through compiler-next's intrinsic helpers,
`useData` suspending via thrown-Promise) into `RenderedTree`. Optional
`render(...)` composes that with the formatter pipeline for a string.

> Pre-1.0. ADR 39 Phase 1b.

## Why no react-reconciler

Static templates that use only walker-portable APIs (`useData`) don't
need React's reactive scaffold. We call function components as plain
functions, recurse on their output, dispatch host elements by tag —
that's the whole walker.

Hooks that DO need React's dispatcher (`useState` / `useEffect` /
`useSignal`) **throw naturally** because no dispatcher is set up.
That's exactly the contract from ADR 39: reactive-only APIs reject
loudly in static templates.

When you need reactivity in a template, use the reactive walker
(`@agentick/reconciler-react-next` via `createApp`). The static
compiler is "data fetch + render, no reactivity."

## API

```ts
import { compileToTree, render, type CompileToTreeOptions, type RenderOptions } from "@agentick/compiler-react-next";

// JSX → RenderedTree (IR)
const tree = await compileToTree(<Template />);

// JSX → markdown string (default) or via opts.formatter
const md = await render(<Template />);
const xml = await render(<Template />, { formatter: xmlFormatter });
```

Both calls are async because `useData` can suspend at any depth
(compile-until-stable). Both return Promises.

## Supported JSX

| What                  | Example                                            |
| --------------------- | -------------------------------------------------- |
| Function components   | `const Tpl = () => <section>…</section>`           |
| Fragments             | `<>foo {bar}</>`                                   |
| Strings / numbers     | rendered as text content                           |
| Arrays / `.map()`     | flattened transparently                            |
| `<section id audience priority>` | top-level context entry (HTML overlap — see below) |
| `<message role>` / `<system>` / `<user>` / `<assistant>` / `<tool>` | role-bearing context entry |
| `<h1>`–`<h6>`         | semantic heading (formatter chooses syntax)        |
| `<code language>`     | fenced code block (HTML overlap — see below)       |
| `<json data>`         | JSON content block                                 |
| `<paragraph>` / `<p>` | pass-through wrapper                               |
| `useData(key, fetcher)` | suspend-via-throw async data primitive           |

## Rejected JSX (throws cleanly)

- `useState`, `useEffect`, `useSignal`, `useContext`, etc. — any hook
  that needs React's dispatcher. The walker doesn't set one up; React
  itself throws "Hooks can only be called inside the body of a
  function component" because there's no current dispatcher.
- Unknown host elements — `<not-a-real-tag>` throws with a precise
  error naming the unknown tag.
- Class components, refs, forwardRef, lazy, memo — currently unsupported.
- Context providers/consumers — not yet wired (consider for Phase 2).
- Reactive intrinsics (`<Tool>`, `<Knobs>`, `<MCP>`) — those belong in
  the reactive walker. Future work: emit effects from the dispatch
  table and throw on static.

## HTML-overlap caveat

The standard JSX namespace has `<section>` and `<code>` as HTML
elements with HTML-specific props. TypeScript interface-merging
rejects conflicting redeclarations, so we DON'T augment those tags
with Agentick-specific props. Workaround until uppercase
function-component wrappers ship (Phase 2):

```tsx
// Agentick-specific props via createElement:
{React.createElement("section", { audience: "model" }, ...)}
{React.createElement("code", { language: "typescript" }, "...")}

// HTML-only attributes work directly:
<section id="intro">{children}</section>   // id from HTML attrs
```

## Verified by

- `src/__tests__/compile.spec.tsx` — JSX → IR → markdown round-trip
  for sections, messages, headings, code blocks, JSON blocks,
  control flow, `useData` integration, rejection propagation,
  unknown-tag error, formatter override, IR shape pin.

## Roadmap

- **Phase 2:** uppercase function-component wrappers (`<Section>`,
  `<Code>`, `<H1>`, …) — cleaner ergonomic without the HTML-overlap caveat.
- **Phase 2:** wire into PromptDeclaration (#121), Resource runtime
  (#123), tool descriptions, MCP server harness (#171).
- **Phase 3:** reconciler-react-next refactors to delegate intrinsic
  handling to the same dispatch — one place where "what `<Section>`
  means in the IR" lives.

## Known gaps

- **Vocabulary is initial.** No `<List>` / `<Table>` / `<Image>` /
  semantic inline marks (`<Strong>` / `<Em>`) yet. Add as call sites
  demand.
- **No streaming.** `render()` returns a final string. Future:
  `renderStream()` yielding fragments as they stabilize.
- **No formatter scopes.** Adopters who want to mix markdown + xml
  within the same template (e.g. `<Markdown>` / `<XML>` providers)
  aren't supported yet — `format()` takes one formatter for the whole
  tree. The reactive walker supports per-entry overrides via
  `<XML>`/`<Markdown>` providers; mirror that here when needed.
