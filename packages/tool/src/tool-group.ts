/**
 * `createToolGroup` — authoring sugar for the capability-tree path.
 *
 * A group is not a runtime entity. The call eagerly flattens its members to
 * plain `ToolDeclaration`s, prepending its own name onto each descendant's
 * `group` path, and returns that flat array. Nesting a group is nesting an
 * array. Adopters spread the result into any `tools:` slot.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { ToolDeclaration } from "@agentick/spec";

import { isCreatedTool, type CreatedTool } from "./create-tool.js";

/** A tool, a raw declaration, or a nested group's flattened output. */
export type ToolGroupMember = CreatedTool | ToolDeclaration | readonly ToolGroupMember[];

export interface ToolGroupSpec {
  /** Path segment prepended to every descendant's {@link ToolDeclaration.group}. */
  readonly name: string;
  /**
   * One sentence of group prose — what this capability area IS. Not consumed
   * by the flatten (nothing group-shaped survives it): it exists so ONE
   * authored literal serves both registration and the app's capability
   * section, where the group's prose does most of the talking and tool names
   * carry themselves. The deferred `groups` wire enumeration (BACKLOG §A)
   * reads it too, when the dock builds that panel.
   */
  readonly summary?: string;
  readonly tools: readonly ToolGroupMember[];
}

export function createToolGroup(spec: ToolGroupSpec): readonly ToolDeclaration[] {
  return spec.tools.flatMap(toDeclarations).map((tool) => ({
    ...tool,
    group: [spec.name, ...(tool.group ?? [])],
  }));
}

function isNestedGroup(member: ToolGroupMember): member is readonly ToolGroupMember[] {
  return Array.isArray(member);
}

function toDeclarations(member: ToolGroupMember): readonly ToolDeclaration[] {
  if (isNestedGroup(member)) return member.flatMap(toDeclarations);
  return [isCreatedTool(member) ? member.declaration : member];
}
