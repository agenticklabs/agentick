/**
 * Semantic-HTML tag → `SemanticType` + optional props mapping.
 *
 * This table is the framework's canonical mapping from lowercase HTML
 * intrinsic names to the semantic vocabulary the formatters
 * understand. Both the compiler-react-next walker (static) and any
 * future reconciler delegating to it use this table when they
 * encounter one of these tags.
 *
 * Why a table instead of 30 helpers: every semantic-html tag has the
 * SAME constructor shape — `semanticNode(semantic, children, props?)`.
 * A lookup table is the minimal honest representation; per-tag helper
 * functions would be repetition.
 *
 * Ported from `reconciler-next/collect/contributors/semantic-html.ts`.
 * The behavior is identical; this is the location-move part of the
 * Phase 3 consolidation.
 */

import type { SemanticType } from "@agentick/spec-next";

/**
 * Entry in the semantic-html table.
 */
export interface SemanticHtmlEntry {
  /** The semantic vocabulary slot this tag maps to. */
  readonly semantic: SemanticType;
  /**
   * Per-tag props mapper. Reads the JSX props and returns the
   * SemanticNode `props` field. Undefined → no props.
   */
  readonly propsMapper?: (
    props: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * The dispatch table. Walkers do `SEMANTIC_HTML_TAGS.get(tag)` to
 * find the entry; if present, they wrap children as a SemanticNode
 * subtree rather than the default flat-block recursion.
 */
export const SEMANTIC_HTML_TAGS: ReadonlyMap<string, SemanticHtmlEntry> = new Map<
  string,
  SemanticHtmlEntry
>([
  // Inline emphasis
  ["strong", { semantic: "strong" }],
  ["b", { semantic: "strong" }],
  ["em", { semantic: "em" }],
  ["i", { semantic: "em" }],
  ["mark", { semantic: "mark" }],
  ["u", { semantic: "underline" }],
  ["s", { semantic: "strikethrough" }],
  ["del", { semantic: "strikethrough" }],
  ["sub", { semantic: "subscript" }],
  ["sup", { semantic: "superscript" }],
  ["small", { semantic: "small" }],

  // Semantic phrasing (NOTE: lowercase `<code>` is claimed by the
  // CodeBlock contributor for native CodeBlock production with a
  // `language` prop. Inline code semantic form uses other tags or
  // wrap-with-strong.)
  ["kbd", { semantic: "keyboard" }],
  ["var", { semantic: "variable" }],
  ["q", { semantic: "quote" }],
  ["cite", { semantic: "citation" }],

  // Links
  [
    "a",
    {
      semantic: "link",
      propsMapper: (p) => (typeof p.href === "string" ? { href: p.href } : undefined),
    },
  ],

  // Headings — synthesize level prop from the tag name
  ...([1, 2, 3, 4, 5, 6] as const).map((level): [string, SemanticHtmlEntry] => [
    `h${level}`,
    { semantic: "heading", propsMapper: () => ({ level }) },
  ]),

  // Paragraph + block prose
  ["p", { semantic: "paragraph" }],
  ["blockquote", { semantic: "blockquote" }],
  ["pre", { semantic: "preformatted" }],

  // Void / separators
  ["br", { semantic: "line-break" }],
  ["hr", { semantic: "horizontal-rule" }],

  // Lists
  ["ul", { semantic: "list", propsMapper: () => ({ ordered: false }) }],
  ["ol", { semantic: "list", propsMapper: () => ({ ordered: true }) }],
  ["li", { semantic: "list-item" }],

  // Tables — `<tr>` / `<td>` / `<th>` model as `semantic: "custom"`
  // with `tag` so the table formatter can structure rows + cells.
  ["table", { semantic: "table" }],
  ["thead", { semantic: "custom", propsMapper: () => ({ tag: "thead" }) }],
  ["tbody", { semantic: "custom", propsMapper: () => ({ tag: "tbody" }) }],
  ["tr", { semantic: "custom", propsMapper: () => ({ tag: "tr" }) }],
  ["td", { semantic: "custom", propsMapper: () => ({ tag: "td" }) }],
  ["th", { semantic: "custom", propsMapper: () => ({ tag: "th" }) }],

  // Lowercase media tags — semantic inline forms. Capitalized
  // `<Image>` / `<Audio>` / `<Video>` produce native ContentBlocks
  // via the imageBlock / audioBlock / videoBlock helpers.
  [
    "img",
    {
      semantic: "image",
      propsMapper: (p) => {
        const out: Record<string, unknown> = {};
        if (typeof p.src === "string") out.src = p.src;
        if (typeof p.alt === "string") out.alt = p.alt;
        return Object.keys(out).length > 0 ? out : undefined;
      },
    },
  ],
]);

/**
 * Convenience: is `tag` a semantic-html intrinsic?
 */
export function isSemanticHtmlTag(tag: string): boolean {
  return SEMANTIC_HTML_TAGS.has(tag);
}

/**
 * Convenience: look up a semantic-html entry. Returns `undefined`
 * for non-semantic tags.
 */
export function getSemanticHtmlEntry(tag: string): SemanticHtmlEntry | undefined {
  return SEMANTIC_HTML_TAGS.get(tag);
}
