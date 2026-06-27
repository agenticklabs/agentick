/**
 * Post-commit walker. After react-reconciler commits a tree to the
 * container, walk the `HostInstance` children and produce IR via
 * compiler-next's intrinsic helpers.
 *
 * The walker is synchronous. The mount lifecycle around it
 * (`compile.ts`) handles compile-until-stable for `useData` suspends.
 *
 * Three recursion modes:
 *  - **Block** (default) — accumulate `ContentBlock[]` for inline
 *    content + `ContextEntry[]` for sections/messages. Dispatch lives
 *    in `dispatch-block.ts`.
 *  - **Semantic** — entered when we hit a semantic-html intrinsic
 *    (`<strong>`, `<em>`, `<ul>`, …). Accumulates `SemanticNode[]`
 *    instead, producing one `SemanticContentBlock` with a nested
 *    tree. Dispatch lives in `dispatch-semantic.ts`.
 *  - **Format scope** — `<format formatter={ref} purpose?>` is a
 *    passthrough that derives a new `WalkScope` and recurses
 *    children with it. The intrinsic itself contributes no entry
 *    or block; descendants stamp `renderedWith` from the active
 *    scope.
 *
 * This file is intentionally small: top-level orchestration only.
 */

import {
  EMPTY_WALK_SCOPE,
  isFormatTag,
  isSemanticHtmlTag,
  parseFormatProps,
  textBlock,
  withFormatter,
  type WalkScope,
} from "@agentick/compiler-next";
import type { ElementInstance, HostInstance, TextInstance } from "@agentick/reconciler-next";
import type {
  ContentBlock,
  ContextEntry,
  FormatDiagnostic,
  MCPDeclaration,
  OutputDeclaration,
  ProviderOptions,
  ResourceDeclaration,
  SpecConfig,
  ToolDeclaration,
} from "@agentick/spec-next";

import { dispatchBlock } from "./dispatch-block.js";
import { isDeclarationTag, dispatchDeclaration } from "./dispatch-declarations.js";
import { walkSemanticHtml } from "./dispatch-semantic.js";
import { getRegisteredIntrinsic } from "./register-intrinsic.js";

export interface WalkResult {
  readonly entries: readonly ContextEntry[];
  readonly blocks: readonly ContentBlock[];
  /** Walker-time diagnostics — malformed props, dropped blocks, etc. */
  readonly diagnostics?: readonly FormatDiagnostic[];
  /** Partial SpecConfig merged onto the RenderedTree by `finalize()`. */
  readonly specConfig?: Partial<SpecConfig>;
  /** Provider option overrides merged onto the RenderedTree. */
  readonly providerOptions?: ProviderOptions;
  /** Tool declarations (`<tool>` intrinsic). */
  readonly tools?: readonly ToolDeclaration[];
  /** MCP server declarations (`<mcp>` intrinsic). */
  readonly mcps?: readonly MCPDeclaration[];
  /** Resource declarations (`<resource>` intrinsic). */
  readonly resources?: readonly ResourceDeclaration[];
  /** Output declarations (`<output>` intrinsic). */
  readonly outputs?: readonly OutputDeclaration[];
}

/**
 * Walk a list of host nodes (a container's children, or any
 * element's children). Accumulates the combined block-mode result
 * under the given scope. Scope defaults to {@link EMPTY_WALK_SCOPE}.
 */
export function walkChildren(
  children: readonly HostInstance[],
  scope: WalkScope = EMPTY_WALK_SCOPE,
): WalkResult {
  const acc: MutableWalkAccumulator = {
    entries: [],
    blocks: [],
    diagnostics: [],
    specConfig: undefined,
    providerOptions: undefined,
    tools: [],
    mcps: [],
    resources: [],
    outputs: [],
  };
  for (const child of children) {
    foldInto(acc, walkNode(child, scope));
  }
  return finalizeWalkResult(acc);
}

function walkNode(node: HostInstance, scope: WalkScope): WalkResult {
  if (node.kind === "text") {
    return { entries: [], blocks: [textBlock((node as TextInstance).text)] };
  }
  return walkElement(node, scope);
}

function walkElement(node: ElementInstance, scope: WalkScope): WalkResult {
  const type = node.type;
  if (typeof type !== "string") {
    return walkChildren(node.children, scope);
  }

  // Adopter-registered intrinsic? Highest precedence — last-writer-wins
  // over built-ins. Hands the handler raw children + a `walk` callback
  // so it controls whether/how to recurse.
  //
  // NOTE(adr-39-phase-3): the callback the handler receives does NOT
  // expose the active WalkScope today. Custom intrinsics that need
  // formatter-scope awareness will have to wait for a wider handler
  // shape — tracked as a Phase 3 follow-up. The common case (leaf
  // intrinsic that produces fixed blocks/entries) is unaffected.
  const custom = getRegisteredIntrinsic(type);
  if (custom) {
    return custom(node.props, node.children, (cs) => walkChildren(cs, scope));
  }

  // `<format>` — formatter-scope provider. Recurse children with the
  // derived scope; contribute no entry/block of our own. Malformed
  // props (missing/invalid `formatter`) emit a diagnostic and
  // recurse under the parent scope unchanged.
  if (isFormatTag(type)) {
    const parsed = parseFormatProps(node.props);
    if (!parsed) {
      const inner = walkChildren(node.children, scope);
      return {
        ...inner,
        diagnostics: [
          ...(inner.diagnostics ?? []),
          {
            severity: "warning",
            code: "format-missing-formatter",
            message: "<format> without a valid `formatter` prop; scope ignored.",
          },
        ],
      };
    }
    const nextScope = withFormatter(scope, parsed);
    return walkChildren(node.children, nextScope);
  }

  // Declaration intrinsics (`<tool>` / `<mcp>` / `<resource>` /
  // `<output>` / `<model>`) — produce runtime registrations, not
  // ContentBlocks. Routed before block-mode dispatch because
  // `<tool>` is currently in block-mode's role-shorthand fall-through
  // path; declaration semantics take precedence.
  if (isDeclarationTag(type)) {
    return dispatchDeclaration(type, node.props, walkChildren(node.children, scope), node.hostId);
  }

  // Semantic-html intrinsic? Switch to SemanticNode-mode recursion.
  // Semantic-mode produces no entries (so the active scope's
  // `renderedWith` stamp doesn't apply); we still thread the scope
  // for consistency.
  if (isSemanticHtmlTag(type)) {
    return walkSemanticHtml(type, node.props, node.children, scope);
  }

  // Block-mode: walk children, then combine via the block dispatch.
  const inner = walkChildren(node.children, scope);
  return dispatchBlock(type, node.props, inner, scope);
}

// ────────── Accumulator + finalize ──────────

interface MutableWalkAccumulator {
  entries: ContextEntry[];
  blocks: ContentBlock[];
  diagnostics: FormatDiagnostic[];
  specConfig: Partial<SpecConfig> | undefined;
  providerOptions: ProviderOptions | undefined;
  tools: ToolDeclaration[];
  mcps: MCPDeclaration[];
  resources: ResourceDeclaration[];
  outputs: OutputDeclaration[];
}

function foldInto(acc: MutableWalkAccumulator, r: WalkResult): void {
  acc.entries.push(...r.entries);
  acc.blocks.push(...r.blocks);
  if (r.diagnostics?.length) acc.diagnostics.push(...r.diagnostics);
  if (r.specConfig) acc.specConfig = { ...acc.specConfig, ...r.specConfig };
  if (r.providerOptions) {
    acc.providerOptions = { ...(acc.providerOptions ?? {}), ...r.providerOptions };
  }
  if (r.tools?.length) acc.tools.push(...r.tools);
  if (r.mcps?.length) acc.mcps.push(...r.mcps);
  if (r.resources?.length) acc.resources.push(...r.resources);
  if (r.outputs?.length) acc.outputs.push(...r.outputs);
}

function finalizeWalkResult(acc: MutableWalkAccumulator): WalkResult {
  const out: {
    entries: readonly ContextEntry[];
    blocks: readonly ContentBlock[];
    diagnostics?: readonly FormatDiagnostic[];
    specConfig?: Partial<SpecConfig>;
    providerOptions?: ProviderOptions;
    tools?: readonly ToolDeclaration[];
    mcps?: readonly MCPDeclaration[];
    resources?: readonly ResourceDeclaration[];
    outputs?: readonly OutputDeclaration[];
  } = { entries: acc.entries, blocks: acc.blocks };
  if (acc.diagnostics.length > 0) out.diagnostics = acc.diagnostics;
  if (acc.specConfig && Object.keys(acc.specConfig).length > 0) out.specConfig = acc.specConfig;
  if (acc.providerOptions && Object.keys(acc.providerOptions).length > 0) {
    out.providerOptions = acc.providerOptions;
  }
  if (acc.tools.length > 0) out.tools = acc.tools;
  if (acc.mcps.length > 0) out.mcps = acc.mcps;
  if (acc.resources.length > 0) out.resources = acc.resources;
  if (acc.outputs.length > 0) out.outputs = acc.outputs;
  return out;
}
