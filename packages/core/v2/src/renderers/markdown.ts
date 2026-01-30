/**
 * Markdown Renderer
 */

import type { Renderer, SemanticContentBlock, SemanticNode } from "./types";

export class MarkdownRenderer implements Renderer {
  name = "markdown";

  render(block: SemanticContentBlock): string {
    switch (block.type) {
      case "text":
        return this.renderText(block);
      case "code":
        return this.renderCode(block);
      case "image":
        return this.renderImage(block);
      case "json":
        return this.renderJson(block);
      default:
        return String(block.text ?? "");
    }
  }

  renderBlocks(blocks: SemanticContentBlock[]): string {
    return blocks.map((b) => this.render(b)).join("\n\n");
  }

  private renderText(block: SemanticContentBlock): string {
    if (block.semanticNode) {
      return this.renderSemanticNode(block.semanticNode);
    }
    return block.text ?? "";
  }

  private renderSemanticNode(node: SemanticNode): string {
    if (node.text !== undefined) return node.text;

    const children = node.children?.map((c) => this.renderSemanticNode(c)).join("") ?? "";

    switch (node.semantic) {
      case "strong":
        return `**${children}**`;
      case "emphasis":
        return `*${children}*`;
      case "code":
        return `\`${children}\``;
      case "link":
        return `[${children}](${node.href ?? ""})`;
      case "heading":
        return `${"#".repeat(node.level ?? 1)} ${children}`;
      default:
        return children;
    }
  }

  private renderCode(block: SemanticContentBlock): string {
    const lang = block.language ?? "";
    const code = block.code ?? "";
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }

  private renderImage(block: SemanticContentBlock): string {
    const alt = block.alt ?? "";
    const src = block.source ?? "";
    return `![${alt}](${src})`;
  }

  private renderJson(block: SemanticContentBlock): string {
    return `\`\`\`json\n${JSON.stringify(block.json, null, 2)}\n\`\`\``;
  }
}

export const markdownRenderer = new MarkdownRenderer();
