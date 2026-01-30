/**
 * V2 Renderer Types
 *
 * Renderers transform semantic content into formatted output.
 */

/**
 * Semantic content block - the internal representation of content.
 */
export interface SemanticContentBlock {
  type: "text" | "code" | "image" | "document" | "audio" | "video" | "json";
  text?: string;
  code?: string;
  language?: string;
  source?: string;
  alt?: string;
  mimeType?: string;
  json?: unknown;
  semanticNode?: SemanticNode;
}

/**
 * Semantic node for rich text formatting within a text block.
 */
export interface SemanticNode {
  text?: string;
  semantic?: "strong" | "emphasis" | "code" | "link" | "heading";
  href?: string;
  level?: number;
  children?: SemanticNode[];
}

/**
 * A renderer that transforms content blocks into formatted text.
 */
export interface Renderer {
  /** Unique name for this renderer */
  name: string;

  /**
   * Render a semantic content block to formatted text.
   */
  render(block: SemanticContentBlock): string;

  /**
   * Render multiple blocks, joining them appropriately.
   */
  renderBlocks(blocks: SemanticContentBlock[]): string;
}

/**
 * Formatter interface (alias for compatibility).
 */
export type Formatter = Renderer;
