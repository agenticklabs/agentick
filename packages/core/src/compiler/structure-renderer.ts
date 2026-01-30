import { COM } from "../com/object-model";
import type { COMInput, COMSection, COMTimelineEntry } from "../com/types";
import type { ContentBlock, TextBlock } from "@tentickle/shared";
import {
  ContentRenderer,
  type SemanticContentBlock,
  MarkdownRenderer,
  type Formatter,
} from "../renderers";
import { Logger } from "../core/logger";
import type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledEphemeral,
  CompiledPolicyBoundary,
} from "../compiler/types";

const log = Logger.for("StructureRenderer");

/**
 * Consolidate contiguous text blocks into single text blocks.
 * Non-text blocks act as boundaries.
 *
 * @example
 * [text, text, image, text, text] → [consolidated-text, image, consolidated-text]
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
 * - Caching formatted content on sections
 *
 * Formatting Rules:
 * - Sections: Always formatted (system content), cached on section
 * - Timeline entries: Only formatted if explicitly wrapped in renderer tag
 */
export class StructureRenderer {
  private defaultRenderer: ContentRenderer;
  private policyBoundaries: CompiledPolicyBoundary[] = [];
  private _lastCompiled: CompiledStructure | null = null;

  constructor(private com: COM) {
    this.defaultRenderer = new MarkdownRenderer();
  }

  setDefaultRenderer(renderer: ContentRenderer): void {
    this.defaultRenderer = renderer;
  }

  /**
   * Applies compiled structure to COM and formats content.
   *
   * NOTE: Timeline entries are NOT added to COM here. They are passed
   * directly to formatInput along with previousTimeline. This keeps
   * the architecture declarative - no imperative accumulation.
   */
  apply(compiled: CompiledStructure): void {
    // Store compiled structure for formatInput to use
    this._lastCompiled = compiled;

    // 1. Apply sections (format and cache)
    for (const section of compiled.sections.values()) {
      this.applySection(section);
    }

    // 2. Timeline entries are NOT applied here - they go directly to formatInput
    // This prevents duplication from re-rendering historical messages

    // 3. Consolidate system message
    this.consolidateSystemMessage(compiled.systemMessageItems);

    // 4. Apply tools
    for (const { name: _name, tool } of compiled.tools) {
      this.com.addTool(tool);
    }

    // 5. Apply ephemeral entries (NOT persisted)
    for (const ephemeral of compiled.ephemeral) {
      this.applyEphemeral(ephemeral);
    }

    // 6. Apply metadata
    for (const [key, value] of Object.entries(compiled.metadata)) {
      this.com.addMetadata(key, value);
    }

    // 7. Store policy boundaries for formatInput processing
    if (compiled.policyBoundaries && compiled.policyBoundaries.length > 0) {
      this.policyBoundaries = compiled.policyBoundaries;
    }
  }

  /**
   * Applies a section to COM.
   * Formats content immediately and caches it on the section.
   */
  private applySection(compiled: CompiledSection): void {
    // Use formatter if provided, otherwise use default renderer's format method
    const formatter =
      compiled.formatter ||
      ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));

    let formattedContent: ContentBlock[] | undefined;

    if (Array.isArray(compiled.content)) {
      // Format SemanticContentBlocks → ContentBlocks
      formattedContent = formatter(compiled.content as SemanticContentBlock[]);
    }

    const section: COMSection = {
      id: compiled.id,
      title: compiled.title,
      content: compiled.content, // Raw content (SemanticContentBlocks)
      formattedContent, // Cached formatted content
      formattedWith: compiled.formatter ? "custom" : "MarkdownRenderer", // Track which formatter was used
      visibility: compiled.visibility,
      audience: compiled.audience,
      tags: compiled.tags,
      metadata: compiled.metadata,
      formatter: compiled.formatter, // Preserve formatter for system message consolidation
    };

    this.com.addSection(section);
  }

  /**
   * Applies an ephemeral entry to COM.
   * Ephemeral entries are NOT persisted - they provide current context.
   *
   * Consolidates contiguous text blocks for cleaner model input.
   */
  private applyEphemeral(compiled: CompiledEphemeral): void {
    // Use formatter if provided, otherwise use default renderer's format method
    const formatter =
      compiled.formatter ||
      ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));

    // Format SemanticContentBlocks → ContentBlocks
    const formattedContent = formatter(compiled.content);

    // Consolidate contiguous text blocks (like system messages)
    const consolidatedContent = consolidateTextBlocks(formattedContent);

    this.com.addEphemeral(
      consolidatedContent,
      compiled.position,
      compiled.order,
      compiled.metadata,
      compiled.id,
      compiled.tags,
      compiled.type,
    );
  }

  /**
   * Applies a timeline entry to COM.
   * Only formats if explicitly wrapped in renderer tag.
   */
  private applyTimelineEntry(compiled: CompiledTimelineEntry): void {
    if (compiled.kind === "message" && compiled.message) {
      // Store formatter reference in metadata for later formatting
      const metadata = {
        ...compiled.metadata,
        formatter: compiled.formatter, // Store formatter reference for formatInput()
      };

      this.com.addMessage(
        {
          ...compiled.message,
          // Preserve SemanticContentBlocks - will be formatted only if renderer set
          content: compiled.message.content as SemanticContentBlock[],
        } as any,
        {
          tags: compiled.tags,
          visibility: compiled.visibility,
          metadata,
        },
      );
    }
    // Note: Application events use role: 'event' on the message, handled in the message branch above
  }

  /**
   * Consolidates system message items into a single system message.
   * Creates a single, well-formatted text block for the system prompt.
   */
  private consolidateSystemMessage(
    items: Array<{
      type: "section" | "message" | "loose";
      sectionId?: string;
      content?: SemanticContentBlock[];
      index: number;
      formatter?: Formatter;
    }>,
  ): void {
    if (items.length === 0) return;

    // Sort by index (render order)
    const sorted = [...items].sort((a, b) => a.index - b.index);

    const sectionsMap = new Map<string, COMSection>();

    // Get sections from COM for reference (they're already added by applySection)
    const sections = (this.com as any).sections as Map<string, COMSection>;
    for (const section of sections.values()) {
      sectionsMap.set(section.id, section);
    }

    // Collect formatted text parts (we'll join them into a single block)
    const textParts: string[] = [];

    for (const item of sorted) {
      if (item.type === "section" && item.sectionId) {
        const section = sectionsMap.get(item.sectionId);
        if (section) {
          // Build section text with title as header
          const sectionParts: string[] = [];

          if (section.title) {
            sectionParts.push(`## ${section.title}`);
          }

          // Use pre-formatted content if available (avoids re-formatting and mutation issues)
          if (section.formattedContent) {
            const text = section.formattedContent
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            if (text) sectionParts.push(text);
          } else if (Array.isArray(section.content)) {
            // Fallback: format raw content (only if formattedContent not available)
            const formatter =
              section.formatter ||
              ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));
            const formatted = formatter(section.content as SemanticContentBlock[]);
            const text = formatted
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            if (text) sectionParts.push(text);
          } else if (typeof section.content === "string") {
            sectionParts.push(section.content);
          }

          if (sectionParts.length > 0) {
            textParts.push(sectionParts.join("\n"));
          }
        }
      } else if (item.type === "message" && item.content) {
        // Use message's formatter if specified, otherwise default renderer's format method
        const formatter =
          item.formatter ||
          ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));
        // Format message content
        const formatted = formatter(item.content);
        const text = formatted
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) textParts.push(text);
      } else if (item.type === "loose" && item.content) {
        // Use loose content's formatter if specified, otherwise default renderer's format method
        const formatter =
          item.formatter ||
          ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));
        // Format loose content
        const formatted = formatter(item.content);
        const text = formatted
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) textParts.push(text);
      }
    }

    if (textParts.length > 0) {
      // Create a single, well-formatted text block
      const consolidatedText = textParts.join("\n\n");

      this.com.addMessage({
        role: "system",
        content: [{ type: "text", text: consolidatedText }],
      });
    }
  }

  /**
   * Formats COMInput for model input.
   *
   * The compiled structure IS the complete projection of what the model sees.
   * Components render history via `<Message>`, which becomes compiled.timelineEntries.
   * No separate history merge - JSX is the single source of truth.
   *
   * Rules:
   * - Sections: Use cached formattedContent
   * - Timeline entries (from compiled structure):
   *   - Format if renderer set, semantic blocks, or event blocks
   *   - Otherwise → preserve ContentBlocks as-is
   * - Policy boundaries: Applied after formatting
   */
  async formatInput(comInput: COMInput): Promise<COMInput> {
    // Get timeline entries from compiled structure
    // This is the COMPLETE timeline - components render history as <Message>
    const compiledEntries = this._lastCompiled?.timelineEntries ?? [];

    // Format compiled entries
    const formattedTimeline: COMTimelineEntry[] = [];

    for (const compiled of compiledEntries) {
      if (compiled.kind === "message" && compiled.message) {
        const content = compiled.message.content as SemanticContentBlock[];
        const explicitFormatter = compiled.formatter;

        // Format if formatter explicitly set OR blocks have semanticNode OR blocks are event blocks
        const hasSemanticNodes = content.some((block) => block.semanticNode || block.semantic);
        const hasEventBlocks = content.some(
          (block) =>
            block.type === "user_action" ||
            block.type === "system_event" ||
            block.type === "state_change",
        );

        let formattedContent: ContentBlock[];
        if (explicitFormatter || hasSemanticNodes || hasEventBlocks) {
          const formatter =
            explicitFormatter ||
            ((blocks: SemanticContentBlock[]) => this.defaultRenderer.format(blocks));
          formattedContent = formatter(content);
        } else {
          formattedContent = content;
        }

        formattedTimeline.push({
          kind: "message",
          message: {
            ...compiled.message,
            content: formattedContent,
          },
          tags: compiled.tags,
          visibility: compiled.visibility,
          metadata: compiled.metadata,
        });
      }
    }

    log.debug(
      { compiledCount: compiledEntries.length },
      "formatInput: processed compiled timeline entries",
    );

    let resultTimeline = formattedTimeline;
    const formattedSections: Record<string, COMSection> = {};

    // Apply policy boundaries (e.g., TokenBudget)
    // Policies are applied in order (outer to inner as they appear in tree)
    for (const policy of this.policyBoundaries) {
      resultTimeline = await policy.process(resultTimeline, policy.value);
    }

    // Format sections (use cached formattedContent)
    for (const [id, section] of Object.entries(comInput.sections)) {
      if (section.formattedContent) {
        // Use cached formatted content
        formattedSections[id] = {
          ...section,
          content: section.formattedContent,
          // Remove formatting metadata from output
          formattedContent: undefined,
          formattedWith: undefined,
        };
      } else {
        // Fallback: format now (shouldn't happen if applySection worked correctly)
        const renderer = this.defaultRenderer;
        if (Array.isArray(section.content)) {
          const formattedContent = renderer.format(section.content as SemanticContentBlock[]);
          formattedSections[id] = {
            ...section,
            content: formattedContent,
          };
        } else {
          formattedSections[id] = section;
        }
      }
    }

    return {
      timeline: resultTimeline,
      sections: formattedSections,
      tools: comInput.tools,
      ephemeral: comInput.ephemeral, // Pass through ephemeral (already formatted)
      system: comInput.system,
      metadata: comInput.metadata,
      modelOptions: comInput.modelOptions, // Pass through model options (temperature, maxTokens, etc.)
    };
  }
}
