/**
 * Semantic node tree — structured intermediate produced by JSX components
 * and consumed by the formatter harness.
 *
 * Promoted from v1's `Renderer` base (`packages/core/src/renderers/base.ts`)
 * with one breaking change: the live `formatter: Formatter` function field
 * is replaced by `rendererRef?: FormatterRef`. Function references cannot
 * cross the spec firewall — formatter identity is data, behavior lives
 * behind the formatter harness.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §Content blocks
 * @see docs/proposals/v2/blueprint/04-formatters.md
 */

import type { CacheHint, ContentBlock } from "./content-blocks.js";
import type { FormatterRef } from "./formatter.js";

/**
 * Semantic types for inline and block formatting.
 *
 * Media types (image/audio/video) are semantic-only — `<img>`/`<audio>`/
 * `<video>` lowered to inline markdown/XML. The capitalized components
 * (`<Image>` / `<Audio>` / `<Video>`) produce native {@link ContentBlock}s
 * instead of semantic nodes.
 */
export type SemanticType =
  // Inline formatting
  | "strong"
  | "em"
  | "mark"
  | "underline"
  | "strikethrough"
  | "subscript"
  | "superscript"
  | "small"
  | "code"
  // Block formatting
  | "heading"
  | "list"
  | "table"
  | "paragraph"
  | "blockquote"
  | "line-break"
  | "horizontal-rule"
  // Generic structural containers (the HTML <div>/<span>/<article>/...
  // semantics — adopters who want portable React-y templates can use
  // these without committing to a specific semantic type). Formatters
  // render them per their conventions: markdown adds paragraph breaks
  // for `block`; xml wraps in <div>/<span>; text uses block breaks.
  | "block"
  | "inline"
  | "inline-block"
  // Media (inline lowered form)
  | "image"
  | "audio"
  | "video"
  // Semantic elements
  | "link"
  | "quote"
  | "citation"
  | "keyboard"
  | "variable"
  | "list-item"
  // Custom / pre-formatted
  | "custom"
  | "preformatted";

/**
 * Tree node carrying structured content with formatting hints. Lives inside
 * a {@link SemanticContentBlock} and is interpreted by a formatter.
 */
export interface SemanticNode {
  /** Plain text content (leaf nodes). */
  readonly text?: string;
  /** Semantic type (strong, em, code, heading, ...). */
  readonly semantic?: SemanticType;
  /** Props for semantic nodes (e.g., src/alt for images, href for links). */
  readonly props?: Record<string, unknown>;
  /** Child nodes (for nested formatting). */
  readonly children?: readonly SemanticNode[];
  /**
   * Reference to a formatter for this subtree. Enables nested formatter
   * switching across the spec firewall. `[V1-REPLACED]` of v1's
   * `formatter: Formatter` function field.
   */
  readonly rendererRef?: FormatterRef;
}

/**
 * Legacy compact semantic metadata. Kept for v1 wire compatibility and for
 * cases where a full {@link SemanticNode} tree is unnecessary.
 */
export interface SemanticMetadata {
  readonly type: SemanticType;
  /** Heading level (1–6). */
  readonly level?: number;
  /** Structure hint for tables, lists, etc. */
  readonly structure?: unknown;
  /** Link target for `link`/`citation`. */
  readonly href?: string;
  /** Custom renderer tag (e.g., `timestamp`, application tags). */
  readonly rendererTag?: string;
  readonly rendererAttrs?: Record<string, unknown>;
  /** If true, formatter MAY pass content through verbatim. */
  readonly preformatted?: boolean;
}

/**
 * A `<Section>`'s STRUCTURE, before a dialect has been chosen for it.
 *
 * The compiler's collect walk knows what a section IS — id, title, the
 * content it contains, its cache boundary — but not how it should READ. The
 * `# Title` of markdown and the `<current_user>` of xml are the same section
 * told in two dialects, and only the formatter pass knows which one is in
 * scope. So collect emits this node as a sidecar and the formatter pass lowers
 * it, exactly as it already does for {@link SemanticNode} (ADR 94).
 *
 * `content` is the section's own blocks, still unlowered — the formatter
 * renders them FIRST (escaping and all) and frames the result afterwards, so a
 * tag frame is never escaped and a body never escapes twice.
 */
export interface SectionNode {
  /** Stable id — survives recompiles, rides every block the section produces. */
  readonly id: string;
  readonly title?: string;
  readonly content: readonly SemanticContentBlock[];
  /** Prompt-cache breakpoint for this section (#185). Rides the LAST block. */
  readonly cache?: CacheHint;
  /** Per-section provider knobs (Anthropic `cacheControl`). Rides the LAST block. */
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  /** Author-supplied bag. Rides EVERY block the section produces. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Extended {@link ContentBlock} carrying semantic metadata for the formatter
 * harness. All `SemanticContentBlock`s are valid `ContentBlock`s.
 *
 * Both sidecars mean the same thing — "this block is structure, not text yet"
 * — and both are consumed by the formatter pass. Nothing downstream of that
 * pass should ever observe one.
 */
export type SemanticContentBlock = ContentBlock & {
  readonly semanticNode?: SemanticNode;
  readonly sectionNode?: SectionNode;
  readonly semantic?: SemanticMetadata;
};
