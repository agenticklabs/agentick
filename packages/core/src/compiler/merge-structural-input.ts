/**
 * Merge Structural Input
 *
 * Pure function that merges programmatic structural fields from SendInput
 * into a CompiledStructure. JSX compilation is primary; this is the
 * programmatic escape hatch for injecting context without JSX.
 *
 * Mutates `compiled` in place.
 */

import type { EphemeralInput, GroundingInput, SectionInput, ContentBlock } from "@agentick/shared";
import type { SemanticContentBlock } from "../renderers/index.js";
import type {
  CompiledStructure,
  CompiledTimelineEntry,
  CompiledEphemeral,
  CompiledSection,
} from "./types.js";

export interface StructuralInput {
  system?: string[];
  grounding?: GroundingInput[];
  sections?: SectionInput[];
  ephemeral?: EphemeralInput[];
}

function normalizeContent(content: string | ContentBlock[] | undefined): SemanticContentBlock[] {
  if (content === undefined) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content } as SemanticContentBlock];
  }
  return content as SemanticContentBlock[];
}

export function mergeStructuralInput(compiled: CompiledStructure, input: StructuralInput): void {
  // System strings → CompiledTimelineEntry with role "system"
  if (input.system) {
    for (const text of input.system) {
      const entry: CompiledTimelineEntry = {
        role: "system",
        content: [{ type: "text", text } as SemanticContentBlock],
        renderer: null,
      };
      compiled.systemEntries.push(entry);
    }
  }

  // Grounding → CompiledEphemeral with _grounding metadata (matches <Grounding> output)
  if (input.grounding) {
    for (const g of input.grounding) {
      const ephemeral: CompiledEphemeral = {
        content: normalizeContent(g.content),
        position: g.position ?? "start",
        order: g.order ?? 0,
        renderer: null,
        metadata: {
          ...g.metadata,
          _grounding: {
            audience: g.audience ?? "model",
            title: g.title,
          },
        },
      };
      compiled.ephemeral.push(ephemeral);
    }
  }

  // Sections → CompiledSection; JSX wins on ID collision (skip if ID exists)
  if (input.sections) {
    for (const s of input.sections) {
      const id = s.id ?? `structural-section-${compiled.sections.size}`;
      if (compiled.sections.has(id)) continue;

      const section: CompiledSection = {
        id,
        title: s.title,
        content: normalizeContent(s.content),
        renderer: null,
        visibility: s.visibility,
        audience: s.audience,
        tags: s.tags,
        metadata: s.metadata,
      };
      compiled.sections.set(id, section);
    }
  }

  // Ephemeral → CompiledEphemeral appended with position/order preserved
  if (input.ephemeral) {
    for (const e of input.ephemeral) {
      const ephemeral: CompiledEphemeral = {
        content: normalizeContent(e.content),
        position: e.position ?? "end",
        order: e.order ?? 0,
        renderer: null,
        metadata: e.metadata,
      };
      compiled.ephemeral.push(ephemeral);
    }
  }
}
