/**
 * IRFragment — discriminated-union pieces that contributors produce.
 *
 * The collector walks the host tree, dispatches to a Contributor per
 * element instance, and folds the resulting fragments into a
 * `RenderedTree`. This split keeps the collector small (~50 lines of
 * dispatch) and primitive logic local (one contributor per JSX type).
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer B
 */

import type {
  ContentBlock,
  ContextEntry,
  FormatDiagnostic,
  MCPDeclaration,
  OutputDeclaration,
  ProviderOptions,
  ResourceDeclaration,
  SemanticNode,
  SpecConfig,
  ToolDeclaration,
} from "@agentick/spec-next";

export type IRFragment =
  | { readonly kind: "context-entry"; readonly entry: ContextEntry }
  | { readonly kind: "tool-declaration"; readonly tool: ToolDeclaration }
  | { readonly kind: "resource-declaration"; readonly resource: ResourceDeclaration }
  | { readonly kind: "output-declaration"; readonly output: OutputDeclaration }
  | { readonly kind: "mcp-declaration"; readonly mcp: MCPDeclaration }
  | { readonly kind: "free-root-content"; readonly blocks: readonly ContentBlock[] }
  | { readonly kind: "spec-config"; readonly partial: Partial<SpecConfig> }
  | { readonly kind: "provider-options"; readonly partial: ProviderOptions }
  | { readonly kind: "diagnostic"; readonly diagnostic: FormatDiagnostic }
  | { readonly kind: "metadata"; readonly key: string; readonly value: unknown }
  | { readonly kind: "content-block"; readonly block: ContentBlock }
  /**
   * Semantic node produced by JSX semantic-HTML contributors (`<strong>`,
   * `<h1>`, `<ul>`, etc.). The grouping pass in `foldContentBlocks`
   * coalesces contiguous semantic-node + text contributions into a
   * single `TextBlock` (with `semanticNode` sidecar). Native ContentBlock
   * fragments (Image, Code, etc.) break the run.
   *
   * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D5
   */
  | { readonly kind: "semantic-node"; readonly node: SemanticNode };

/**
 * Convenience: produce an empty fragment array. Useful for contributors
 * that no-op on certain props.
 */
export const NO_FRAGMENTS: readonly IRFragment[] = Object.freeze([]);
