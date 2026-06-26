/**
 * `@agentick/compiler-react-next` — React adapter for the Agentick
 * static-template compiler. Per ADR 39.
 *
 * Two entry points:
 *
 *  - `compileToTree(element, opts?)` — JSX → `RenderedTree` (IR).
 *    Pure async function. Useful when callers want the IR (to format
 *    it themselves, inspect, cache, transport over a wire).
 *
 *  - `render(element, opts?)` — JSX → string. Composes `compileToTree`
 *    with `format()` from `@agentick/compiler-next`. Default
 *    formatter is markdown; override via `opts.formatter`.
 *
 * What works in templates:
 *  - Host elements: `<section>`, `<message role="...">`, `<user>`,
 *    `<assistant>`, `<system>`, `<h1>`–`<h6>`, `<code>`, `<json>`,
 *    `<p>` / `<paragraph>` / `<text>`
 *  - Function components (called as plain JS; hooks without a React
 *    dispatcher throw cleanly)
 *  - Fragments (`<>...</>`)
 *  - `useData` from `@agentick/compiler-next` for async data fetching
 *
 * What does NOT work in templates (throws):
 *  - `useState`, `useEffect`, `useSignal`, channels, knobs — any
 *    reactive-only API. Static templates are snapshots; reactivity
 *    is the reactive walker's (reconciler-react-next) job.
 *
 * @see docs/proposals/v2/blueprint/39-jsx-template-walker.md
 */

// JSX intrinsics augmentation — side-effect import so adopters get
// type safety for `<section>`, `<user>`, `<code language="...">`, etc.
// when they `import` anything from this package.
import "./jsx-intrinsics.js";

export { compileToTree } from "./compile.js";
export type { CompileToTreeOptions } from "./compile.js";

export { render } from "./render.js";
export type { RenderOptions } from "./render.js";

export { useData } from "./use-data.js";
