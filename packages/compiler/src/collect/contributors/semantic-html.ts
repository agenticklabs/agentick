/**
 * Semantic HTML contributors.
 *
 * Each contributor emits a single `semantic-node` IRFragment carrying a
 * `SemanticNode` subtree. The grouping pass in the collect walker
 * coalesces contiguous semantic-node + text fragments into a single
 * `TextBlock` whose `semanticNode` sidecar holds the assembled tree;
 * the formatter then walks that tree to produce wire-shape text.
 *
 * The walker does NOT distinguish inline (`<strong>`, `<em>`) from
 * block-level (`<h1>`, `<p>`, `<ul>`) elements. Spacing, markup, and
 * line breaks are the formatter's job — markdown adds `\n\n` after
 * `paragraph`, XML wraps in `<p>...</p>`, etc.
 *
 * Adopters add custom semantic types by calling `makeSemanticContributor`
 * with their own `(type, semantic, propsMapper)` triple.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D5
 */

import type { CustomContentBlock, SemanticNode, SemanticType } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import type { ElementInstance, HostInstance } from "../../host/host-instance.js";
import { isTextInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

// ── Spec conformance ────────────────────────────────────────────────────
// Semantic HTML elements have NO spec declaration type — their props are
// raw HTML attributes (`href`, `src`, level synthesized from the tag),
// mapped into the OPEN `SemanticNode.props` record by each `propsMapper`.
// So there is no props-derivation partition; instead the assertion guards
// the OUTPUT shape: every `SemanticNode` field is compiler-supplied
// (`semantic` from options, `children` collected, `props` from the mapper,
// `text` on leaves, `rendererRef` reserved). A new `SemanticNode` field
// fails `tsc` here until `makeSemanticContributor` handles it.
type SemanticNodeSupplied = "text" | "semantic" | "props" | "children" | "rendererRef";
type _semanticNodeConformance = Exhausted<
  UnhandledSpecKeys<SemanticNode, never, SemanticNodeSupplied>
>;

// ============================================================================
// Factory
// ============================================================================

export interface SemanticContributorOptions {
  /** Semantic type the produced node carries. */
  readonly semantic: SemanticType;
  /**
   * Map the element's props into the `SemanticNode.props` field. Default:
   * `() => undefined` (no props). Use for elements where attributes
   * carry meaning the formatter needs — `<a href>`, `<img src>`,
   * `<h1 level>` (synthesized from the element type), etc.
   */
  readonly propsMapper?: (
    instance: ElementInstance,
  ) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * Build a `Contributor` for a semantic HTML element. The contributor
 * walks the element's children, collecting nested semantic + text into
 * a single `SemanticNode` subtree, and emits exactly one
 * `semantic-node` fragment.
 */
export function makeSemanticContributor(
  type: string,
  options: SemanticContributorOptions,
): Contributor {
  return {
    type,
    contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
      const node: SemanticNode = {
        semantic: options.semantic,
        ...(options.propsMapper
          ? (() => {
              const p = options.propsMapper!(instance);
              return p !== undefined ? { props: p } : {};
            })()
          : {}),
        children: collectSemanticChildren(instance, ctx),
      };
      return [{ kind: "semantic-node", node }];
    },
  };
}

/**
 * Walk a parent element's children and return them as `SemanticNode[]`.
 * Bare text instances become `{ text }` leaves; nested semantic
 * contributors recursively produce their own subtrees.
 *
 * Anything that isn't text or a semantic-node fragment is dropped here
 * (it's surfaced upstream by the enclosing section/message contributor
 * via the normal fold path). Semantic HTML can't contain native
 * ContentBlocks inline — the inline/block distinction means an `<image>`
 * inside `<strong>` is a misuse, and silently dropping it is safer than
 * crashing.
 */
export function collectSemanticChildren(
  parent: HostInstance,
  ctx: CollectContext,
): readonly SemanticNode[] {
  if (parent.kind !== "element") return [];
  const out: SemanticNode[] = [];
  for (const child of parent.children) {
    if (isTextInstance(child)) {
      if (child.text.length > 0) out.push({ text: child.text });
      continue;
    }
    // Recurse via the walker so nested semantic elements pick up their
    // own contributors. The walker returns fragments — we extract
    // semantic-node fragments and pass through children of unknown
    // wrapper components (Fragments, function components without a
    // contributor).
    const fragments = ctx.walk(child);
    for (const frag of fragments) {
      if (frag.kind === "semantic-node") {
        out.push(frag.node);
        continue;
      }
      // A leaf `<custom>` contributes a content-block, not a semantic node —
      // dropping it here is what made a nested custom lose its tag while the
      // parent's `collectText` still scraped its bare words. It is the one
      // ContentBlock with a faithful node form, so convert rather than drop.
      if (frag.kind === "content-block" && frag.block.type === "custom") {
        out.push(customNode(frag.block));
      }
    }
  }
  return out;
}

/** The node form of a custom content block — same tag, attrs and content. */
export function customNode(block: CustomContentBlock): SemanticNode {
  return {
    semantic: "custom",
    props: omitUndefined({
      tag: block.tag,
      attrs: block.attrs,
      selfClosing: block.selfClosing,
    }),
    children: block.content.length > 0 ? [{ text: block.content }] : [],
  };
}

// ============================================================================
// Built-in semantic HTML registrations
// ============================================================================

/**
 * Returns the full set of semantic HTML contributors for the standard
 * elements. `createBuiltInRegistry()` registers them automatically.
 *
 * Add or override by registering your own contributors AFTER the
 * built-ins — last-writer-wins on type collision.
 */
export function semanticHtmlContributors(): readonly Contributor[] {
  return [
    // Inline emphasis
    makeSemanticContributor("strong", { semantic: "strong" }),
    makeSemanticContributor("b", { semantic: "strong" }),
    makeSemanticContributor("em", { semantic: "em" }),
    makeSemanticContributor("i", { semantic: "em" }),
    makeSemanticContributor("mark", { semantic: "mark" }),
    makeSemanticContributor("u", { semantic: "underline" }),
    makeSemanticContributor("s", { semantic: "strikethrough" }),
    makeSemanticContributor("del", { semantic: "strikethrough" }),
    makeSemanticContributor("sub", { semantic: "subscript" }),
    makeSemanticContributor("sup", { semantic: "superscript" }),
    makeSemanticContributor("small", { semantic: "small" }),

    // Inline code & semantic phrasing
    // NOTE: lowercase `<code>` (the JSX intrinsic) is already claimed
    // by the v2 code-block contributor — it produces a native CodeBlock
    // with a `language` prop. Use the semantic `<inline-code>` or
    // wrap in `<strong>` for inline emphasis. Adopters can shadow this
    // with their own contributor if they want `<code>` to be semantic.
    makeSemanticContributor("kbd", { semantic: "keyboard" }),
    makeSemanticContributor("var", { semantic: "variable" }),
    makeSemanticContributor("q", { semantic: "quote" }),
    makeSemanticContributor("cite", { semantic: "citation" }),

    // Links
    makeSemanticContributor("a", {
      semantic: "link",
      propsMapper: (i) =>
        typeof (i.props as { href?: unknown }).href === "string"
          ? { href: (i.props as { href: string }).href }
          : undefined,
    }),

    // Headings — synthesize level prop from the element name
    ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
      makeSemanticContributor(`h${level}`, {
        semantic: "heading",
        propsMapper: () => ({ level }),
      }),
    ),

    // Paragraph + block prose
    makeSemanticContributor("p", { semantic: "paragraph" }),
    makeSemanticContributor("blockquote", { semantic: "blockquote" }),
    makeSemanticContributor("pre", { semantic: "preformatted" }),

    // Void / separators
    makeSemanticContributor("br", { semantic: "line-break" }),
    makeSemanticContributor("hr", { semantic: "horizontal-rule" }),

    // Lists
    makeSemanticContributor("ul", {
      semantic: "list",
      propsMapper: () => ({ ordered: false }),
    }),
    makeSemanticContributor("ol", {
      semantic: "list",
      propsMapper: () => ({ ordered: true }),
    }),
    makeSemanticContributor("li", { semantic: "list-item" }),

    // Tables
    makeSemanticContributor("table", { semantic: "table" }),
    // `<tr>` / `<td>` / `<th>` carry no semantic of their own — they're
    // structural children of `<table>`. We model them as generic
    // semantic nodes carrying their tag so the formatter can render
    // them correctly. (The table formatter expects children to be rows
    // of cells.)
    makeSemanticContributor("thead", { semantic: "custom", propsMapper: () => ({ tag: "thead" }) }),
    makeSemanticContributor("tbody", { semantic: "custom", propsMapper: () => ({ tag: "tbody" }) }),
    makeSemanticContributor("tr", { semantic: "custom", propsMapper: () => ({ tag: "tr" }) }),
    makeSemanticContributor("td", { semantic: "custom", propsMapper: () => ({ tag: "td" }) }),
    makeSemanticContributor("th", { semantic: "custom", propsMapper: () => ({ tag: "th" }) }),

    // Lowercase media tags — semantic inline forms. Capitalized
    // `<Image>` / `<Audio>` / `<Video>` produce native ContentBlocks via
    // their own contributors.
    makeSemanticContributor("img", {
      semantic: "image",
      propsMapper: (i) => {
        const p = i.props as { src?: unknown; alt?: unknown };
        const out: Record<string, unknown> = {};
        if (typeof p.src === "string") out.src = p.src;
        if (typeof p.alt === "string") out.alt = p.alt;
        return Object.keys(out).length > 0 ? out : undefined;
      },
    }),

    // Generic HTML structural containers — adopters writing "portable
    // React-y templates" use these without committing to a specific
    // semantic type. Each formatter (markdown / xml / text) frames
    // them per its conventions: markdown adds paragraph breaks for
    // `block`; xml wraps in <div>/<span>; text uses block breaks.
    //
    // Note: `<section>` is intentionally NOT here — it's claimed by
    // the agentick `<section id title priority>` declaration
    // intrinsic. Adopters wanting an HTML-section-as-container use
    // `<div>` (or `<article>` for semantic richness).
    makeSemanticContributor("div", { semantic: "block" }),
    makeSemanticContributor("span", { semantic: "inline" }),
    makeSemanticContributor("article", { semantic: "block" }),
    makeSemanticContributor("aside", { semantic: "block" }),
    makeSemanticContributor("main", { semantic: "block" }),
    makeSemanticContributor("header", { semantic: "block" }),
    makeSemanticContributor("footer", { semantic: "block" }),
    makeSemanticContributor("nav", { semantic: "block" }),
    makeSemanticContributor("figure", { semantic: "block" }),
    makeSemanticContributor("figcaption", { semantic: "block" }),
    makeSemanticContributor("address", { semantic: "block" }),
  ];
}
