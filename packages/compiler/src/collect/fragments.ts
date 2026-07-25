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
  ModelDeclaration,
  OutputDeclaration,
  ProviderOptions,
  ProviderToolDeclaration,
  ResourceDeclaration,
  SemanticNode,
  SpecConfig,
  ToolDeclaration,
} from "@agentick/spec";

export type IRFragment =
  | { readonly kind: "context-entry"; readonly entry: ContextEntry }
  /**
   * A component overriding its harness's projection for `key` (ADR 63).
   * Emitted by the `<project>` contributor; carries the entries (and/or
   * tools) the override produced. Presence of this fragment for a key
   * SUPPRESSES that harness's lazy default projection (last-writer-wins
   * per key). `<Timeline>{fn}` ≡ `ctx.project("timeline", fn)`.
   */
  | {
      readonly kind: "projection-override";
      readonly key: string;
      readonly result: import("./projection.js").ProjectionResult;
    }
  | { readonly kind: "tool-declaration"; readonly tool: ToolDeclaration }
  /**
   * A PROVIDER-EXECUTED tool request (Pass D). Unlike `tool-declaration`
   * (a dispatchable source the `tools` projection surfaces), this bypasses
   * the tool executor entirely — the collector folds it straight onto
   * `RenderedTree.declarations.providerTools`, which the loop threads to
   * the executor's `project` phase. Emitted by the `<provider-tool>`
   * contributor.
   */
  | { readonly kind: "provider-tool-declaration"; readonly providerTool: ProviderToolDeclaration }
  | { readonly kind: "model-declaration"; readonly model: ModelDeclaration }
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
