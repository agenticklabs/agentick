import type { COM } from "../com/object-model";
import type { COMInput, COMSection, COMTimelineEntry } from "../com/types";
import type { ContentBlock, TextBlock } from "@tentickle/shared";
import type { ContentRenderer } from "../renderers";
import { type SemanticContentBlock, MarkdownRenderer } from "../renderers";
import { Logger } from "@tentickle/kernel";
import type { CompiledStructure, CompiledSection, CompiledEphemeral } from "./types";

const log = Logger.for("StructureRenderer");

/**
 * Consolidate contiguous text blocks into single text blocks.
 * Non-text blocks act as boundaries.
 */
function consolidateTextBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  let textBuffer: string[] = [];

  const flushTextBuffer = () => {
    if (textBuffer.length > 0) {
      result.push({ type: "text" as const, text: textBuffer.join("\n\n") });
      textBuffer = [];
    }
  };

  for (const block of blocks) {
    if (block.type === "text") {
      textBuffer.push((block as TextBlock).text);
    } else {
      flushTextBuffer();
      result.push(block);
    }
  }

  flushTextBuffer();
  return result;
}

/**
 * StructureRenderer: Applies CompiledStructure to COM and formats content.
 *
 * Responsibilities:
 * - Application (CompiledStructure → COM)
 * - Formatting (SemanticContentBlocks → ContentBlocks)
 */
export class StructureRenderer {
  private defaultRenderer: ContentRenderer;
  private _lastCompiled: CompiledStructure | null = null;

  constructor(private ctx: COM) {
    this.defaultRenderer = new MarkdownRenderer();
  }

  setDefaultRenderer(renderer: ContentRenderer): void {
    this.defaultRenderer = renderer;
  }

  /**
   * Applies compiled structure to COM and formats content.
   */
  async apply(compiled: CompiledStructure): Promise<void> {
    this._lastCompiled = compiled;

    // 1. Apply sections
    for (const section of compiled.sections.values()) {
      this.applySection(section);
    }

    // 2. Apply tools (must await since addTool is async for schema conversion)
    for (const tool of compiled.tools) {
      // Convert CompiledTool to ExecutableTool format
      // ExecutableTool expects { metadata: {...}, run?: Procedure }
      await this.ctx.addTool({
        metadata: {
          name: tool.name,
          description: tool.description ?? "",
          input: tool.schema,
        },
        run: tool.handler,
      } as any);
    }

    // 3. Apply ephemeral entries
    for (const ephemeral of compiled.ephemeral) {
      this.applyEphemeral(ephemeral);
    }

    // 4. Apply metadata
    for (const [key, value] of Object.entries(compiled.metadata)) {
      this.ctx.addMetadata(key, value);
    }
  }

  /**
   * Applies a section to COM.
   */
  private applySection(compiled: CompiledSection): void {
    // Format content using renderer or default
    const formattedContent = this.formatSemanticBlocks(compiled.content);

    const section: COMSection = {
      id: compiled.id,
      title: compiled.title,
      content: compiled.content,
      formattedContent,
      formattedWith: "MarkdownRenderer",
      visibility: compiled.visibility,
      audience: compiled.audience,
      tags: compiled.tags,
      metadata: compiled.metadata,
    };

    this.ctx.addSection(section);
  }

  /**
   * Applies an ephemeral entry to COM.
   */
  private applyEphemeral(compiled: CompiledEphemeral): void {
    const formattedContent = this.formatSemanticBlocks(compiled.content);
    const consolidatedContent = consolidateTextBlocks(formattedContent);

    this.ctx.addEphemeral(
      consolidatedContent,
      compiled.position,
      compiled.order,
      compiled.metadata,
    );
  }

  /**
   * Format semantic content blocks to content blocks.
   */
  private formatSemanticBlocks(blocks: SemanticContentBlock[]): ContentBlock[] {
    return this.defaultRenderer.format(blocks);
  }

  /**
   * Formats COMInput for model input.
   *
   * The compiled structure IS the complete projection of what the model sees.
   * Components render history via `<Message>`, which becomes compiled.timelineEntries.
   */
  async formatInput(comInput: COMInput): Promise<COMInput> {
    const compiledEntries = this._lastCompiled?.timelineEntries ?? [];

    // Format compiled timeline entries
    const formattedTimeline: COMTimelineEntry[] = [];

    for (const compiled of compiledEntries) {
      const formattedContent = this.formatSemanticBlocks(compiled.content);

      formattedTimeline.push({
        kind: "message",
        message: {
          role: compiled.role,
          content: formattedContent,
          id: compiled.id,
          metadata: compiled.metadata,
          createdAt: compiled.createdAt?.toISOString(),
        },
        metadata: compiled.metadata,
      });
    }

    log.debug(
      { compiledCount: compiledEntries.length },
      "formatInput: processed compiled timeline entries",
    );

    // Format sections
    const formattedSections: Record<string, COMSection> = {};
    for (const [id, section] of Object.entries(comInput.sections)) {
      if (section.formattedContent) {
        formattedSections[id] = {
          ...section,
          content: section.formattedContent,
          formattedContent: undefined,
          formattedWith: undefined,
        };
      } else if (Array.isArray(section.content)) {
        formattedSections[id] = {
          ...section,
          content: this.defaultRenderer.format(section.content as SemanticContentBlock[]),
        };
      } else {
        formattedSections[id] = section;
      }
    }

    // Format compiled system entries (rebuilt each tick)
    const compiledSystem = this._lastCompiled?.systemEntries ?? [];
    const formattedSystem: COMTimelineEntry[] = compiledSystem.map((compiled) => {
      const formattedContent = this.formatSemanticBlocks(compiled.content);
      return {
        kind: "message" as const,
        message: {
          role: compiled.role,
          content: formattedContent,
          id: compiled.id,
          metadata: compiled.metadata,
          createdAt: compiled.createdAt?.toISOString(),
        },
        metadata: compiled.metadata,
      };
    });

    return {
      timeline: formattedTimeline,
      sections: formattedSections,
      tools: comInput.tools,
      ephemeral: comInput.ephemeral,
      // Use formatted system from compiled structure (rebuilt each tick)
      system: formattedSystem.length > 0 ? formattedSystem : comInput.system,
      metadata: comInput.metadata,
      modelOptions: comInput.modelOptions,
    };
  }
}
