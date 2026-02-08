/**
 * Compilation Testing Utilities
 *
 * Test agent compilation without running full ticks.
 * Useful for unit testing component output.
 */

import React from "react";
import { FiberCompiler } from "../compiler/fiber-compiler";
import type { CompiledStructure, CompiledTool } from "../compiler/types";
import type { ComponentFunction } from "../app/types";
import type { ContentBlock } from "@agentick/shared";
import type { SemanticContentBlock, SemanticNode } from "../renderers/base";

// ============================================================================
// Types
// ============================================================================

export interface CompileAgentOptions<P extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Props to pass to the agent component.
   */
  props?: P;

  /**
   * Current tick number.
   * @default 1
   */
  tick?: number;

  /**
   * Maximum compilation iterations.
   * @default 10
   */
  maxIterations?: number;
}

export interface CompileAgentResult {
  /**
   * The compiled structure.
   */
  compiled: CompiledStructure;

  /**
   * Sections from the compiled tree.
   */
  sections: Map<string, string>;

  /**
   * Tools from the compiled structure.
   */
  tools: CompiledTool[];

  /**
   * System messages.
   */
  systemMessages: string[];

  /**
   * Number of compilation iterations.
   */
  iterations: number;

  /**
   * Whether compilation was forced to stabilize.
   */
  forcedStable: boolean;

  /**
   * Reasons for recompilation.
   */
  recompileReasons: string[];

  /**
   * Get section content by ID.
   */
  getSection: (id: string) => string | undefined;

  /**
   * Check if a section contains text.
   */
  sectionContains: (id: string, text: string) => boolean;

  /**
   * Get a tool by name.
   */
  getTool: (name: string) => CompiledTool | undefined;

  /**
   * Check if a tool exists.
   */
  hasTool: (name: string) => boolean;
}

// Use shared mocks
import { createMockCom, createMockTickState } from "./mocks";

// ============================================================================
// Main API
// ============================================================================

/**
 * Compile an agent component and return the result for assertions.
 *
 * This is a lightweight way to test what an agent component renders
 * without executing a full tick (no model calls, no session management).
 *
 * @example
 * ```tsx
 * import { compileAgent } from '@agentick/core/testing';
 *
 * test('agent renders correct system prompt', async () => {
 *   const { sections, tools } = await compileAgent(MyAgent, {
 *     props: { mode: "helpful" },
 *   });
 *
 *   expect(sections.get('system')).toContain('You are helpful');
 *   expect(tools).toHaveLength(2);
 * });
 * ```
 *
 * @example Using helper methods
 * ```tsx
 * const result = await compileAgent(MyAgent);
 *
 * expect(result.sectionContains('instructions', 'Be concise')).toBe(true);
 * expect(result.hasTool('search')).toBe(true);
 * expect(result.getTool('calculator')?.description).toBe('Perform math');
 * ```
 */
export async function compileAgent<P extends Record<string, unknown> = Record<string, unknown>>(
  Agent: ComponentFunction<P>,
  options: CompileAgentOptions<P> = {},
): Promise<CompileAgentResult> {
  const { props = {} as P, tick = 1, maxIterations = 10 } = options;

  // Create mock COM and compiler
  const ctx = createMockCom();
  const compiler = new FiberCompiler(ctx as any);

  // Create tick state
  const tickState = createMockTickState(tick);

  // Create element with props
  const element = React.createElement(Agent as any, props);

  // Compile until stable
  const { compiled, iterations, forcedStable, recompileReasons } =
    await compiler.compileUntilStable(element, tickState as any, { maxIterations });

  // Extract sections as string map
  const sections = new Map<string, string>();
  for (const [id, section] of compiled.sections) {
    // Render section content blocks to string
    const content = extractContentBlocksText(section.content);
    sections.set(id, content);
  }

  // Extract tools
  const tools: CompiledTool[] = compiled.tools ?? [];

  // Extract system messages
  const systemMessages: string[] = (compiled.systemEntries ?? [])
    .map((entry) => {
      // CompiledTimelineEntry has content: SemanticContentBlock[]
      if (entry.content) {
        return extractContentBlocksText(entry.content);
      }
      return "";
    })
    .filter(Boolean);

  // Helper methods
  const getSection = (id: string) => sections.get(id);

  const sectionContains = (id: string, text: string) => {
    const content = sections.get(id);
    return content ? content.includes(text) : false;
  };

  const getTool = (name: string) => tools.find((t) => t.name === name);

  const hasTool = (name: string) => tools.some((t) => t.name === name);

  return {
    compiled,
    sections,
    tools,
    systemMessages,
    iterations,
    forcedStable,
    recompileReasons,
    getSection,
    sectionContains,
    getTool,
    hasTool,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract text from content blocks.
 */
function extractContentBlocksText(content: ContentBlock[] | SemanticContentBlock[]): string {
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }

  return content
    .map((block) => {
      // Handle text blocks
      if (block.type === "text") {
        return (block as { type: "text"; text: string }).text;
      }

      // Handle semantic content blocks with semanticNode
      const semanticBlock = block as SemanticContentBlock;
      if (semanticBlock.semanticNode) {
        return extractSemanticNodeText(semanticBlock.semanticNode);
      }

      // Fallback for other block types
      if ("text" in block && typeof block.text === "string") {
        return block.text;
      }

      return "";
    })
    .join("");
}

/**
 * Extract text from a semantic node tree.
 */
function extractSemanticNodeText(node: SemanticNode): string {
  if (node.text) {
    return node.text;
  }

  if (node.children) {
    return node.children.map(extractSemanticNodeText).join("");
  }

  return "";
}
