import { Renderer, type SemanticContentBlock, type SemanticNode } from "./base";
import type { ContentBlock, TextBlock, CodeBlock } from "@agentick/shared";
import { extractText } from "@agentick/shared";

/**
 * XML renderer.
 * Formats semantic ContentBlocks into XML-formatted text.
 *
 * Demonstrates that semantic-first compilation enables multiple renderers
 * from the same semantic structure.
 *
 * Usage:
 * ```jsx
 * <XMLRenderer>
 *   <H1>Title</H1>
 *   <Text>Content with <strong>bold</strong> and <inlineCode>code</inlineCode></Text>
 * </XMLRenderer>
 * ```
 */
export class XMLRenderer extends Renderer {
  constructor(private rootTag: string = "content") {
    super();
  }

  /**
   * Formats a semantic node tree into XML text.
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
      childTexts.push(this.escapeXml(node.text));
    }

    const content = childTexts.join("");

    // Apply semantic formatting as XML tags if present
    if (node.semantic) {
      switch (node.semantic) {
        case "strong":
          return `<strong>${content}</strong>`;
        case "em":
          return `<em>${content}</em>`;
        case "code":
          return `<code>${content}</code>`;
        case "mark":
          return `<mark>${content}</mark>`;
        case "underline":
          return `<u>${content}</u>`;
        case "strikethrough":
          return `<s>${content}</s>`;
        case "subscript":
          return `<sub>${content}</sub>`;
        case "superscript":
          return `<sup>${content}</sup>`;
        case "small":
          return `<small>${content}</small>`;

        // Block-level elements
        case "paragraph":
          return `<p>${content}</p>`;
        case "blockquote":
          return `<blockquote>${content}</blockquote>`;

        // Media elements (when nested)
        case "image":
          const alt = node.props?.alt || "";
          const src = node.props?.src || "";
          return `<img src="${this.escapeXml(src)}" alt="${this.escapeXml(alt)}" />`;
        case "audio":
          const audioSrc = node.props?.src || "";
          return `<audio src="${this.escapeXml(audioSrc)}" />`;
        case "video":
          const videoSrc = node.props?.src || "";
          return `<video src="${this.escapeXml(videoSrc)}" />`;

        // Semantic elements
        case "link":
          const href = node.props?.href || "";
          return href ? `<a href="${this.escapeXml(href)}">${content}</a>` : content;

        case "quote":
          return `<q>${content}</q>`;

        case "citation":
          return `<cite>${content}</cite>`;

        case "keyboard":
          return `<kbd>${content}</kbd>`;

        case "variable":
          return `<var>${content}</var>`;

        // Custom XML tags - render with tag name
        case "custom":
          const tagName = node.props?._tagName || node.props?.rendererTag || "span";
          return `<${tagName}>${content}</${tagName}>`;

        default:
          return content;
      }
    }

    // No semantic formatting, return content as-is
    return content;
  }

  /**
   * Escapes XML special characters.
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
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
          text: `<h${level}>${this.escapeXml(headingText)}</h${level}>`,
        } as TextBlock;

      case "paragraph":
        return {
          type: "text",
          text: `<p>${this.escapeXml(extractText([block]))}</p>`,
        } as TextBlock;

      case "strong":
        return {
          type: "text",
          text: `<strong>${this.escapeXml(extractText([block]))}</strong>`,
        } as TextBlock;

      case "em":
        return {
          type: "text",
          text: `<em>${this.escapeXml(extractText([block]))}</em>`,
        } as TextBlock;

      case "code":
        return {
          type: "text",
          text: `<code>${this.escapeXml(extractText([block]))}</code>`,
        } as TextBlock;

      case "mark":
        return {
          type: "text",
          text: `<mark>${this.escapeXml(extractText([block]))}</mark>`,
        } as TextBlock;

      case "underline":
        return {
          type: "text",
          text: `<u>${this.escapeXml(extractText([block]))}</u>`,
        } as TextBlock;

      case "strikethrough":
        return {
          type: "text",
          text: `<s>${this.escapeXml(extractText([block]))}</s>`,
        } as TextBlock;

      case "subscript":
        return {
          type: "text",
          text: `<sub>${this.escapeXml(extractText([block]))}</sub>`,
        } as TextBlock;

      case "superscript":
        return {
          type: "text",
          text: `<sup>${this.escapeXml(extractText([block]))}</sup>`,
        } as TextBlock;

      case "small":
        return {
          type: "text",
          text: `<small>${this.escapeXml(extractText([block]))}</small>`,
        } as TextBlock;

      case "blockquote":
        const quoteText = extractText([block]);
        return {
          type: "text",
          text: `<blockquote>${this.escapeXml(quoteText)}</blockquote>`,
        } as TextBlock;

      case "line-break":
        return {
          type: "text",
          text: "<br/>",
        } as TextBlock;

      case "horizontal-rule":
        return {
          type: "text",
          text: "<hr/>",
        } as TextBlock;

      case "link":
        const linkText = extractText([block]);
        const href = block.semantic?.href || "";
        return {
          type: "text",
          text: href
            ? `<a href="${this.escapeXml(href)}">${this.escapeXml(linkText)}</a>`
            : this.escapeXml(linkText),
        } as TextBlock;

      case "list":
        return this.formatList(semantic.structure);

      case "table":
        return this.formatTable(semantic.structure);

      default:
        return null;
    }
  }

  /**
   * Formats a list structure into XML/HTML list syntax.
   *
   * Supports:
   * - Ordered lists (<ol>)
   * - Unordered lists (<ul>)
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
  ): TextBlock | null {
    if (!structure) return null;

    const { ordered, task, items } = structure;
    const tag = ordered ? "ol" : "ul";
    const listClass = task ? ' class="task-list"' : "";
    const lines: string[] = [];

    lines.push(`<${tag}${listClass}>`);

    for (const item of items) {
      const text = typeof item === "string" ? item : item.text;
      const checked = typeof item === "string" ? undefined : item.checked;
      const nested = typeof item === "string" ? undefined : item.nested;

      let liContent = "";
      const liClass = task ? ' class="task-list-item"' : "";

      if (task) {
        // Task list item with checkbox
        const checkedAttr = checked ? " checked" : "";
        liContent = `<input type="checkbox"${checkedAttr} disabled />${this.escapeXml(text)}`;
      } else {
        liContent = this.escapeXml(text);
      }

      // Handle nested list
      if (nested) {
        const nestedBlock = this.formatList(nested);
        if (nestedBlock) {
          liContent += "\n" + nestedBlock.text;
        }
      }

      lines.push(`  <li${liClass}>${liContent}</li>`);
    }

    lines.push(`</${tag}>`);

    return {
      type: "text",
      text: lines.join("\n"),
    };
  }

  /**
   * Formats a table structure into XML/HTML table syntax.
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

    lines.push("<table>");

    // Header row
    if (headers.length > 0) {
      lines.push("  <thead>");
      lines.push("    <tr>");
      for (let i = 0; i < headers.length; i++) {
        const align = alignments?.[i];
        const style = align && align !== "left" ? ` style="text-align: ${align}"` : "";
        lines.push(`      <th${style}>${this.escapeXml(headers[i])}</th>`);
      }
      lines.push("    </tr>");
      lines.push("  </thead>");
    }

    // Body rows
    if (rows.length > 0) {
      lines.push("  <tbody>");
      for (const row of rows) {
        lines.push("    <tr>");
        for (let i = 0; i < row.length; i++) {
          const align = alignments?.[i];
          const style = align && align !== "left" ? ` style="text-align: ${align}"` : "";
          lines.push(`      <td${style}>${this.escapeXml(row[i])}</td>`);
        }
        lines.push("    </tr>");
      }
      lines.push("  </tbody>");
    }

    lines.push("</table>");

    return {
      type: "text",
      text: lines.join("\n"),
    };
  }

  protected applyBlockLevelFormatting(block: SemanticContentBlock, formattedText: string): string {
    // Apply heading tags if semantic type is heading
    if (block.semantic?.type === "heading") {
      const level = block.semantic.level || 1;
      return `<h${level}>${formattedText}</h${level}>`;
    }
    // Apply paragraph tags if semantic type is paragraph
    if (block.semantic?.type === "paragraph") {
      return `<p>${formattedText}</p>`;
    }
    return formattedText;
  }

  formatStandard(block: SemanticContentBlock): ContentBlock[] {
    switch (block.type) {
      case "text":
        return [block];

      case "code":
        const codeBlock = block as CodeBlock;
        const language = codeBlock.language || "";
        return [
          {
            ...codeBlock,
            type: "text",
            text: `<pre><code${language ? ` class="language-${this.escapeXml(language)}"` : ""}>${this.escapeXml(codeBlock.text)}</code></pre>`,
          } as TextBlock,
        ];

      case "image":
        const imageBlock = block as any;
        const alt = imageBlock.altText || "";
        const url = imageBlock.source?.url || "";
        return [
          {
            ...imageBlock,
            type: "text",
            text: `<img src="${this.escapeXml(url)}" alt="${this.escapeXml(alt)}"/>`,
          } as TextBlock,
        ];

      case "json":
        const jsonBlock = block as any;
        const jsonText = jsonBlock.text || JSON.stringify(jsonBlock.data || {}, null, 2);
        return [
          {
            ...jsonBlock,
            type: "text",
            text: `<pre><code class="language-json">${this.escapeXml(jsonText)}</code></pre>`,
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
          if (ua.actor) parts.push(ua.actor);
          if (ua.action) parts.push(ua.action);
          if (ua.target) parts.push(`on ${ua.target}`);
          text = parts.length > 0 ? parts.join(" ") : "User action";
        }
        const actionAttr = ua.action ? ` action="${this.escapeXml(ua.action)}"` : "";
        const actorAttr = ua.actor ? ` actor="${this.escapeXml(ua.actor)}"` : "";
        const targetAttr = ua.target ? ` target="${this.escapeXml(ua.target)}"` : "";
        return [
          {
            ...ua,
            type: "user_action",
            text: `<user-action${actorAttr}${actionAttr}${targetAttr}>${this.escapeXml(text)}</user-action>`,
          } as TextBlock,
        ];
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
        const eventAttr = se.event ? ` event="${this.escapeXml(se.event)}"` : "";
        const sourceAttr = se.source ? ` source="${this.escapeXml(se.source)}"` : "";
        return [
          {
            ...se,
            type: "system_event",
            text: `<system-event${sourceAttr}${eventAttr}>${this.escapeXml(text)}</system-event>`,
          } as TextBlock,
        ];
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
        const entityAttr = sc.entity ? ` entity="${this.escapeXml(sc.entity)}"` : "";
        const fieldAttr = sc.field ? ` field="${this.escapeXml(sc.field)}"` : "";
        return [
          {
            ...sc,
            type: "state_change",
            text: `<state-change${entityAttr}${fieldAttr}>${this.escapeXml(text)}</state-change>`,
          } as TextBlock,
        ];
      }

      // Pass through native content block types as-is
      // Note: "image" is handled above with text conversion
      case "audio":
      case "video":
      case "document":
      case "reasoning":
      case "tool_use":
      case "tool_result":
        return [block];

      default:
        // For other types, convert to text representation
        return [
          {
            type: "text",
            text: this.escapeXml(JSON.stringify(block)),
          } as TextBlock,
        ];
    }
  }
}
