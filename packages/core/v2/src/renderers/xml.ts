/**
 * XML Renderer
 */

import type { Renderer, SemanticContentBlock, SemanticNode } from "./types";

export class XMLRenderer implements Renderer {
  name = "xml";

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
        return this.escapeXml(String(block.text ?? ""));
    }
  }

  renderBlocks(blocks: SemanticContentBlock[]): string {
    return blocks.map((b) => this.render(b)).join("\n");
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  private renderText(block: SemanticContentBlock): string {
    if (block.semanticNode) {
      return this.renderSemanticNode(block.semanticNode);
    }
    return this.escapeXml(block.text ?? "");
  }

  private renderSemanticNode(node: SemanticNode): string {
    if (node.text !== undefined) return this.escapeXml(node.text);

    const children = node.children?.map((c) => this.renderSemanticNode(c)).join("") ?? "";

    switch (node.semantic) {
      case "strong":
        return `<strong>${children}</strong>`;
      case "emphasis":
        return `<em>${children}</em>`;
      case "code":
        return `<code>${children}</code>`;
      case "link":
        return `<a href="${this.escapeXml(node.href ?? "")}">${children}</a>`;
      case "heading":
        const level = node.level ?? 1;
        return `<h${level}>${children}</h${level}>`;
      default:
        return children;
    }
  }

  private renderCode(block: SemanticContentBlock): string {
    const lang = block.language ?? "";
    const code = this.escapeXml(block.code ?? "");
    return `<code-block language="${lang}">\n${code}\n</code-block>`;
  }

  private renderImage(block: SemanticContentBlock): string {
    const alt = this.escapeXml(block.alt ?? "");
    const src = this.escapeXml(block.source ?? "");
    return `<image src="${src}" alt="${alt}" />`;
  }

  private renderJson(block: SemanticContentBlock): string {
    const json = this.escapeXml(JSON.stringify(block.json, null, 2));
    return `<json>\n${json}\n</json>`;
  }
}

export const xmlRenderer = new XMLRenderer();
