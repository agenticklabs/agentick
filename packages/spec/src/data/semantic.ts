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
 * @see docs/proposals/v2/blueprint/04-formatter-harness.md
 */

import type { ContentBlock } from "./content-blocks.js";
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
 * Extended {@link ContentBlock} carrying semantic metadata for the formatter
 * harness. All `SemanticContentBlock`s are valid `ContentBlock`s.
 */
export type SemanticContentBlock = ContentBlock & {
  readonly semanticNode?: SemanticNode;
  readonly semantic?: SemanticMetadata;
};
