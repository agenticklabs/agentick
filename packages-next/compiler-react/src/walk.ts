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
  ProviderOptions,
  SpecConfig,
} from "@agentick/spec-next";

import { dispatchBlock } from "./dispatch-block.js";
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
  const entries: ContextEntry[] = [];
  const blocks: ContentBlock[] = [];
  const diagnostics: FormatDiagnostic[] = [];
  let specConfig: Partial<SpecConfig> | undefined;
  let providerOptions: ProviderOptions | undefined;
  for (const child of children) {
    const r = walkNode(child, scope);
    entries.push(...r.entries);
    blocks.push(...r.blocks);
    if (r.diagnostics?.length) diagnostics.push(...r.diagnostics);
    if (r.specConfig) specConfig = { ...specConfig, ...r.specConfig };
    if (r.providerOptions) {
      providerOptions = { ...(providerOptions ?? {}), ...r.providerOptions };
    }
  }
  return finalizeWalkResult(entries, blocks, diagnostics, specConfig, providerOptions);
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

function finalizeWalkResult(
  entries: readonly ContextEntry[],
  blocks: readonly ContentBlock[],
  diagnostics: readonly FormatDiagnostic[],
  specConfig: Partial<SpecConfig> | undefined,
  providerOptions: ProviderOptions | undefined,
): WalkResult {
  const out: {
    entries: readonly ContextEntry[];
    blocks: readonly ContentBlock[];
    diagnostics?: readonly FormatDiagnostic[];
    specConfig?: Partial<SpecConfig>;
    providerOptions?: ProviderOptions;
  } = { entries, blocks };
  if (diagnostics.length > 0) out.diagnostics = diagnostics;
  if (specConfig && Object.keys(specConfig).length > 0) out.specConfig = specConfig;
  if (providerOptions && Object.keys(providerOptions).length > 0) {
    out.providerOptions = providerOptions;
  }
  return out;
}
