/**
 * `@agentick/compiler-next` — AST-agnostic core for the JSX-template
 * compiler pipeline. Per ADR 39: each framework adapter (React,
 * Angular, Solid, …) uses its native runtime for AST walking +
 * suspend semantics; compiler-next ships the cross-runtime contract:
 *
 *  - `useData(key, fetcher)` — universal suspend-via-throw primitive
 *    + the `RenderContext` ambient state it reads from
 *  - Intrinsic semantic helpers (`sectionEntry`, `headerBlock`, etc.)
 *    — pure functions producing `RenderedTree` fragments that adapter
 *    host-configs call when their native runtime encounters the
 *    corresponding tag.
 *
 * No walker, no dispatch table, no adapter abstraction lives here —
 * those concerns belong to the per-framework packages because each
 * runtime supplies its own.
 *
 * @see docs/proposals/v2/blueprint/39-jsx-template-walker.md
 */

export {
  createRenderContext,
  getRenderContext,
  isThenable,
  withRenderContext,
} from "./render-context.js";
export type { RenderContext } from "./render-context.js";

export { useData } from "./use-data.js";

export {
  codeBlock,
  headerBlock,
  jsonBlock,
  messageEntry,
  sectionEntry,
  textBlock,
} from "./intrinsics.js";
export type { MessageProps, SectionProps } from "./intrinsics.js";
