import { Renderer, type SemanticContentBlock, type SemanticNode } from "./base";
import type { ContentBlock, TextBlock, CodeBlock } from "@agentick/shared";
import { extractText } from "@agentick/shared";

/**
 * Markdown renderer.
 * Formats semantic ContentBlocks into markdown-formatted text.
 *
 * Supports:
 * - Semantic primitives: H1-H6, List, Table, etc.
 * - Standard ContentBlocks: Text, Code, Image, etc.
 *
 * Usage:
 * ```jsx
 * <Markdown>
 *   <H1>Title</H1>
 *   <Text>Content</Text>
 * </Markdown>
 * ```
 */
export class MarkdownRenderer extends Renderer {
  constructor(private flavor?: "github" | "commonmark" | "gfm") {
    super();
  }

  /**
   * Formats a semantic node tree into markdown text.
   * Recursively processes nested semantic nodes.
   * Supports nested formatter switching when node.formatter is present.
   */
  formatNode(node: SemanticNode): string {
    // If this node has a formatter, delegate to it for the subtree
    if (node.formatter) {
      // Create a temporary block with this node's children
      const childNode: SemanticNode = { children: node.children || [] };
      const tempBlock = { type: "text" as const, text: "", semanticNode: childNode };
      // Call the formatter and extract the text
      const formatted = node.formatter([tempBlock]);
      return formatted
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Process children first
    const childTexts: string[] = [];

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        childTexts.push(this.formatNode(child));
      }
    } else if (node.text !== undefined) {
      // Leaf node with text
      childTexts.push(node.text);
    }

    const content = childTexts.join("");

    // Apply semantic formatting if present
    if (node.semantic) {
      switch (node.semantic) {
        case "strong":
          return `**${content}**`;
        case "em":
          return `*${content}*`;
        case "code":
          return `\`${content}\``;
        case "mark":
          return `==${content}==`;
        case "underline":
          return `<u>${content}</u>`;
        case "strikethrough":
          return `~~${content}~~`;
        case "subscript":
          return `<sub>${content}</sub>`;
        case "superscript":
          return `<sup>${content}</sup>`;
        case "small":
          return `<small>${content}</small>`;

        // Native HTML media elements (from <img>, <audio>, <video>) - convert to inline markdown
        case "image":
          const alt = node.props?.alt || "";
          const imgSrc = node.props?.src || "";
          return `![${alt}](${imgSrc})`;

        case "audio":
          const audioSrc = node.props?.src || "";
          return `[Audio: ${audioSrc}]`;

        case "video":
          const videoSrc = node.props?.src || "";
          return `[Video: ${videoSrc}]`;

        // Block-level elements
        // In markdown, paragraphs are just content separated by blank lines
        // so we return content as-is (no special formatting needed)
        case "paragraph":
          return content;

        case "blockquote":
          // Markdown blockquotes: prefix each line with >
          return content
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");

        // Semantic elements
        case "link":
          const href = node.props?.href || "";
          return href ? `[${content}](${href})` : content;

        case "quote":
          return `"${content}"`;

        case "citation":
          return `*${content}*`; // Could also be <cite>${content}</cite>

        case "keyboard":
          return `\`${content}\``;

        case "variable":
          return `*${content}*`;

        // Custom XML tags - pass through as-is in markdown
        case "custom":
          // For custom tags, just return the content (no special formatting)
          // Alternatively, could wrap in HTML-like syntax if needed
          return content;

        default:
          return content;
      }
    }

    // No semantic formatting, return content as-is
    return content;
  }

  formatSemantic(block: SemanticContentBlock): ContentBlock | null {
    const { semantic } = block;

    if (!semantic) return null;

    switch (semantic.type) {
      case "heading":
        const level = semantic.level || 1;
        const headingText = extractText([block]);
        return {
          type: "text",
          text: `${"#".repeat(level)} ${headingText}`,
        } as TextBlock;

      case "list":
        return this.formatList(semantic.structure);

      case "table":
        return this.formatTable(semantic.structure);

      case "paragraph":
        return {
          type: "text",
          text: extractText([block]),
        } as TextBlock;

      case "strong":
        return {
          type: "text",
          text: `**${extractText([block])}**`,
        } as TextBlock;

      case "em":
        return {
          type: "text",
          text: `*${extractText([block])}*`,
        } as TextBlock;

      case "code":
        // Inline code (from inlineCode element)
        return {
          type: "text",
          text: `\`${extractText([block])}\``,
        } as TextBlock;

      case "mark":
        return {
          type: "text",
          text: `==${extractText([block])}==`,
        } as TextBlock;

      case "underline":
        return {
          type: "text",
          text: `<u>${extractText([block])}</u>`,
        } as TextBlock;

      case "strikethrough":
        return {
          type: "text",
          text: `~~${extractText([block])}~~`,
        } as TextBlock;

      case "subscript":
        return {
          type: "text",
          text: `<sub>${extractText([block])}</sub>`,
        } as TextBlock;

      case "superscript":
        return {
          type: "text",
          text: `<sup>${extractText([block])}</sup>`,
        } as TextBlock;

      case "small":
        return {
          type: "text",
          text: `<small>${extractText([block])}</small>`,
        } as TextBlock;

      case "blockquote":
        const quoteText = extractText([block]);
        return {
          type: "text",
          text: quoteText
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        } as TextBlock;

      case "line-break":
        return {
          type: "text",
          text: "\n",
        } as TextBlock;

      case "horizontal-rule":
        return {
          type: "text",
          text: "\n---\n",
        } as TextBlock;

      case "link":
        const linkText = extractText([block]);
        const href = block.semantic?.href || "";
        return {
          type: "text",
          text: href ? `[${linkText}](${href})` : linkText,
        } as TextBlock;

      case "quote":
        return {
          type: "text",
          text: `"${extractText([block])}"`,
        } as TextBlock;

      case "citation":
        return {
          type: "text",
          text: `*${extractText([block])}*`,
        } as TextBlock;

      case "keyboard":
        return {
          type: "text",
          text: `\`${extractText([block])}\``,
        } as TextBlock;

      case "variable":
        return {
          type: "text",
          text: `*${extractText([block])}*`,
        } as TextBlock;

      default:
        return null;
    }
  }

  /**
   * Formats a table structure into markdown table syntax.
   */
  private formatTable(
    structure:
      | {
          headers: string[];
          rows: string[][];
          alignments?: ("left" | "center" | "right")[];
        }
      | undefined,
  ): TextBlock | null {
    if (!structure) return null;

    const { headers, rows, alignments } = structure;
    const lines: string[] = [];

    // Calculate column widths for nice formatting
    const colWidths: number[] = [];
    const allRows = headers.length > 0 ? [headers, ...rows] : rows;

    for (const row of allRows) {
      for (let i = 0; i < row.length; i++) {
        const cellLen = String(row[i] || "").length;
        colWidths[i] = Math.max(colWidths[i] || 3, cellLen);
      }
    }

    // Build header row
    if (headers.length > 0) {
      const headerCells = headers.map((h, i) => String(h || "").padEnd(colWidths[i]));
      lines.push(`| ${headerCells.join(" | ")} |`);

      // Build separator row with alignment
      const separators = headers.map((_, i) => {
        const width = colWidths[i];
        const align = alignments?.[i] || "left";
        if (align === "center") {
          return ":" + "-".repeat(width - 2) + ":";
        } else if (align === "right") {
          return "-".repeat(width - 1) + ":";
        } else {
          return "-".repeat(width);
        }
      });
      lines.push(`| ${separators.join(" | ")} |`);
    }

    // Build data rows
    for (const row of rows) {
      const cells = row.map((cell, i) => String(cell || "").padEnd(colWidths[i] || 3));
      lines.push(`| ${cells.join(" | ")} |`);
    }

    return {
      type: "text",
      text: lines.join("\n"),
    };
  }

  /**
   * Formats a list structure into markdown list syntax.
   *
   * Supports:
   * - Ordered lists (1. 2. 3.)
   * - Unordered lists (-)
   * - Task lists with checkboxes
   * - Nested lists
   */
  private formatList(
    structure:
      | {
          ordered: boolean;
          task?: boolean;
          items: (string | { text: string; checked?: boolean; nested?: any })[];
        }
      | undefined,
    indent: number = 0,
  ): TextBlock | null {
    if (!structure) return null;

    const { ordered, task, items } = structure;
    const lines: string[] = [];
    const prefix = "  ".repeat(indent);

    items.forEach((item, index) => {
      const bullet = ordered ? `${index + 1}.` : "-";
      const text = typeof item === "string" ? item : item.text;
      const checked = typeof item === "string" ? undefined : item.checked;

      // Build the checkbox prefix for task lists
      let checkbox = "";
      if (task) {
        if (this.flavor === "gfm" || this.flavor === "github") {
          // GFM: native checkbox syntax
          checkbox = checked ? "[x] " : "[ ] ";
        } else {
          // CommonMark/other: use unicode symbols
          checkbox = checked ? "✓ " : "○ ";
        }
      }

      lines.push(`${prefix}${bullet} ${checkbox}${text}`);

      // Handle nested list
      if (typeof item !== "string" && item.nested) {
        const nestedBlock = this.formatList(item.nested, indent + 1);
        if (nestedBlock) {
          lines.push(nestedBlock.text);
        }
      }
    });

    return {
      type: "text",
      text: lines.join("\n"),
    };
  }

  protected applyBlockLevelFormatting(block: SemanticContentBlock, formattedText: string): string {
    // Apply heading prefix if semantic type is heading
    if (block.semantic?.type === "heading") {
      const level = block.semantic.level || 1;
      return `${"#".repeat(level)} ${formattedText}`;
    }
    return formattedText;
  }

  formatStandard(block: SemanticContentBlock): ContentBlock[] {
    switch (block.type) {
      case "text":
        return [block];

      // Convert code/json to markdown-formatted text blocks
      case "code":
        const codeBlock = block as CodeBlock;
        const language = codeBlock.language || "";
        return [
          {
            ...codeBlock,
            type: "text",
            text: `\`\`\`${language}\n${codeBlock.text}\n\`\`\``,
          } as TextBlock,
        ];

      case "json":
        const jsonBlock = block as any;
        const jsonText = jsonBlock.text || JSON.stringify(jsonBlock.data || {}, null, 2);
        return [
          {
            ...jsonBlock,
            type: "text",
            text: `\`\`\`json\n${jsonText}\n\`\`\``,
          } as TextBlock,
        ];

      // Format event blocks into text (they need to be converted to text for the model)
      case "user_action": {
        const ua = block as any;
        // Use text if provided, otherwise generate from props
        // Ensure we always have meaningful text (don't generate "User undefined")
        let text = ua.text;
        if (!text || text.trim() === "") {
          const parts: string[] = [];
          // Capitalize actor if it's the default "user" (case-insensitive) or empty
          const actor = ua.actor || "User";
          // Capitalize "user" to "User" (case-insensitive check)
          const capitalizedActor =
            typeof actor === "string" && actor.toLowerCase() === "user" ? "User" : actor;
          parts.push(capitalizedActor);
          if (ua.action) parts.push(ua.action);
          if (ua.target) parts.push(`on ${ua.target}`);
          text = parts.length > 0 ? parts.join(" ") : "User action";
        }
        return [{ ...ua, type: "text", text } as TextBlock];
      }
      case "system_event": {
        const se = block as any;
        // Use text if provided, otherwise generate from props
        let text = se.text;
        if (!text || text.trim() === "") {
          const parts: string[] = [];
          if (se.event) parts.push(se.event);
          if (se.source) parts.push(`(${se.source})`);
          text = parts.length > 0 ? parts.join(" ") : "System event";
        }
        return [{ ...se, type: "text", text } as TextBlock];
      }
      case "state_change": {
        const sc = block as any;
        // Use text if provided, otherwise generate from props
        let text = sc.text;
        if (!text || text.trim() === "") {
          const entityPart = sc.entity || "entity";
          const fieldPart = sc.field ? `.${sc.field}` : "";
          const fromPart = sc.from !== undefined ? JSON.stringify(sc.from) : "undefined";
          const toPart = sc.to !== undefined ? JSON.stringify(sc.to) : "undefined";
          text = `${entityPart}${fieldPart}: ${fromPart} → ${toPart}`;
        }
        return [{ ...sc, type: "text", text } as TextBlock];
      }

      // Pass through native content block types as-is
      // These are valid root-level ContentBlock types consumed by the model directly
      // Note: These are from capitalized components (<Image>, <Audio>, etc.), not
      // lowercase HTML elements (<img>, <audio>) which become semantic nodes
      case "image":
      case "audio":
      case "video":
      case "document":
      case "reasoning":
      case "tool_use":
      case "tool_result":
        return [block];

      default:
        // Unknown types - pass through as-is
        return [block];
    }
  }
}

/** Default markdown renderer instance */
export const markdownRenderer = new MarkdownRenderer();
