import type { ContentBlock, TextBlock } from "@agentick/shared";

/**
 * Formatter function type.
 * Transforms semantic content blocks into formatted content blocks.
 * This is the public API for formatting - ContentRenderer is an internal implementation detail.
 */
export type Formatter = (blocks: SemanticContentBlock[]) => ContentBlock[];

/**
 * Semantic node representing structured content with formatting information.
 * This is a tree structure where each node can have text, semantic type, and children.
 *
 * Design principle:
 * - Capitalized components (<Image>, <Audio>) create native ContentBlocks (structural)
 * - Lowercase HTML elements (<img>, <audio>) become semantic nodes with props
 *   and the formatter converts them to inline representations (e.g., markdown ![alt](url))
 *
 * Example:
 * ```typescript
 * {
 *   children: [
 *     { text: 'Hello ' },
 *     {
 *       semantic: 'strong',
 *       children: [{ text: 'world' }]
 *     },
 *     { text: ' with ' },
 *     {
 *       semantic: 'image',
 *       props: { src: 'photo.jpg', alt: 'A photo' }
 *     }
 *   ]
 * }
 * ```
 */
export type SemanticNode = {
  /** Plain text content (leaf nodes) */
  text?: string;
  /** Semantic type for formatting (strong, em, code, etc.) */
  semantic?: SemanticType;
  /** Props for semantic nodes (e.g., src/alt for images, href for links) */
  props?: Record<string, any>;
  /** Child nodes (for nested formatting) */
  children?: SemanticNode[];
  /** Formatter to use for this subtree (enables nested formatter switching) */
  formatter?: Formatter;
};

/**
 * Semantic types for inline and block formatting.
 *
 * Note: Media types (image, audio, video) are for semantic usage only (from <img>, <audio>, <video>).
 * The capitalized components (<Image>, <Audio>, <Video>) create native ContentBlocks, not semantic nodes.
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
  // Media (from native HTML elements like <img>, <audio>, <video>, converted to inline representation)
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
  // Custom (unknown XML tags)
  | "custom"
  | "preformatted";

/**
 * Extended ContentBlock with semantic information for renderers.
 * Semantic metadata helps renderers format content appropriately.
 *
 * Note: This is a type alias that extends ContentBlock with optional semantic metadata.
 * All SemanticContentBlocks are valid ContentBlocks.
 */
export type SemanticContentBlock = ContentBlock & {
  /** Semantic node tree representing structured content with formatting hints */
  semanticNode?: SemanticNode;

  /** Legacy semantic metadata (kept for backward compatibility) */
  semantic?: {
    type: SemanticType;
    level?: number; // For headings (1-6)
    structure?: any; // For tables, lists, etc.
    href?: string; // For links
    // For custom renderer tags
    rendererTag?: string; // 'timestamp', 'custom-tag', etc.
    rendererAttrs?: Record<string, any>;
    // For pre-formatted content (e.g., from model output)
    // If true, renderer can choose to pass through or re-format
    preformatted?: boolean;
  };
};

/**
 * Abstract base class for content renderers.
 * Renderers transform SemanticContentBlocks into formatted ContentBlocks.
 *
 * Renderers can:
 * - Format semantic primitives (H1, List, Table, etc.)
 * - Handle custom renderer-specific tags
 * - Format standard ContentBlocks
 */
export abstract class Renderer {
  /**
   * Optional: Define custom primitives this renderer understands.
   * These are custom tags that can be used inside this renderer's scope.
   *
   * Example: XMLRenderer might return ['timestamp', 'custom-tag']
   */
  getCustomPrimitives?(): string[] {
    return [];
  }

  format(blocks: SemanticContentBlock[]): ContentBlock[] {
    const formatted: ContentBlock[] = [];

    for (const block of blocks) {
      // Handle pre-formatted blocks (from model output)
      // By default, pass through pre-formatted blocks unchanged
      // Renderer can choose to re-format if desired
      if (block.semantic?.type === "preformatted" || block.semantic?.preformatted) {
        // Pass through as-is (already formatted)
        formatted.push(block);
        continue;
      }

      // Handle semantic node tree (new semantic-first approach)
      if (block.semanticNode) {
        const node = block.semanticNode;
        // If this node has a formatter, delegate to it
        if (node.formatter) {
          // IMPORTANT: Clear the formatter before calling to prevent infinite recursion
          // The formatter may call renderer.format() internally, which would see the
          // formatter and call it again, causing infinite recursion.
          const formatterFn = node.formatter;
          node.formatter = undefined;
          // Call the formatter with this block - it handles everything
          const formattedBlocks = formatterFn([block]);
          formatted.push(...formattedBlocks);
          continue;
        }

        let formattedText = this.formatNode(node);

        // Apply block-level formatting if needed (e.g., headings)
        formattedText = this.applyBlockLevelFormatting(block, formattedText);

        formatted.push({
          type: "text",
          text: formattedText,
        } as TextBlock);
        continue;
      }

      // Handle legacy semantic primitives
      if (block.semantic) {
        const formattedBlock = this.formatSemantic(block);
        if (formattedBlock) {
          formatted.push(formattedBlock);
          continue;
        }
      }

      // Handle standard ContentBlocks
      // Format if block has semantic metadata OR if it's an event block
      // Code/json blocks are passed through as-is (they'll be formatted to markdown later in fromEngineState/adapter)
      // Native content blocks without semantic metadata should be passed through as-is
      // This preserves native code/json/image/audio/video blocks from structural components
      const isEventBlock =
        block.type === "user_action" ||
        block.type === "system_event" ||
        block.type === "state_change";

      if (block.semanticNode || block.semantic || isEventBlock) {
        formatted.push(...this.formatStandard(block));
      } else {
        // Pass through native content blocks as-is (e.g., code, json, image, audio, video from capitalized components)
        formatted.push(block);
      }
    }

    return formatted;
  }

  /**
   * Format child blocks into a single text string.
   *
   * Unlike format() which passes through non-semantic blocks as-is,
   * this ensures ALL blocks are converted to text — code blocks become
   * fenced code, json becomes fenced json, etc. Used by collapsed
   * content rendering where everything must be text.
   */
  formatChildBlocksToText(childBlocks: SemanticContentBlock[]): string {
    const textParts: string[] = [];

    for (const child of childBlocks) {
      // Route through format() for semantic/semanticNode handling
      const formatted = this.format([child]);

      for (const fb of formatted) {
        if (fb.type === "text") {
          textParts.push((fb as TextBlock).text);
        } else {
          // Non-text blocks (code, json, image, etc.) — force through formatStandard
          const standardized = this.formatStandard(fb as SemanticContentBlock);
          for (const sb of standardized) {
            if (sb.type === "text") {
              textParts.push((sb as TextBlock).text);
            }
            // Non-text types that can't be rendered as text are dropped
          }
        }
      }
    }

    return textParts.join("\n\n");
  }

  abstract formatNode(node: SemanticNode): string;
  abstract formatSemantic(block: SemanticContentBlock): ContentBlock | null;
  abstract formatStandard(block: SemanticContentBlock): ContentBlock[];
  protected abstract applyBlockLevelFormatting(
    block: SemanticContentBlock,
    formattedText: string,
  ): string;
}
