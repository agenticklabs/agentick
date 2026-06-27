/**
 * Post-commit walker. After react-reconciler commits a tree to the
 * container, walk the `HostInstance` children and produce IR via
 * compiler-next's intrinsic helpers.
 *
 * The walker is synchronous. The mount lifecycle around it
 * (`compile.ts`) handles compile-until-stable for `useData` suspends.
 *
 * Two recursion modes:
 *  - **Block** (default) — accumulate `ContentBlock[]` for inline
 *    content + `ContextEntry[]` for sections/messages. Dispatch lives
 *    in `dispatch-block.ts`.
 *  - **Semantic** — entered when we hit a semantic-html intrinsic
 *    (`<strong>`, `<em>`, `<ul>`, …). Accumulates `SemanticNode[]`
 *    instead, producing one `SemanticContentBlock` with a nested
 *    tree. Dispatch lives in `dispatch-semantic.ts`.
 *
 * This file is intentionally small: top-level orchestration only.
 */

import { isSemanticHtmlTag, textBlock } from "@agentick/compiler-next";
import type { ElementInstance, HostInstance, TextInstance } from "@agentick/reconciler-next";
import type { ContentBlock, ContextEntry } from "@agentick/spec-next";

import { dispatchBlock } from "./dispatch-block.js";
import { walkSemanticHtml } from "./dispatch-semantic.js";

export interface WalkResult {
  readonly entries: readonly ContextEntry[];
  readonly blocks: readonly ContentBlock[];
}

/**
 * Walk a list of host nodes (a container's children, or any
 * element's children). Accumulates the combined block-mode result.
 */
export function walkChildren(children: readonly HostInstance[]): WalkResult {
  const entries: ContextEntry[] = [];
  const blocks: ContentBlock[] = [];
  for (const child of children) {
    const r = walkNode(child);
    entries.push(...r.entries);
    blocks.push(...r.blocks);
  }
  return { entries, blocks };
}

function walkNode(node: HostInstance): WalkResult {
  if (node.kind === "text") {
    return { entries: [], blocks: [textBlock((node as TextInstance).text)] };
  }
  return walkElement(node);
}

function walkElement(node: ElementInstance): WalkResult {
  const type = node.type;
  if (typeof type !== "string") {
    // Function/class components are already evaluated by react-reconciler
    // and won't appear here. Defensive: recurse children gracefully.
    return walkChildren(node.children);
  }

  // Semantic-html intrinsic? Switch to SemanticNode-mode recursion.
  if (isSemanticHtmlTag(type)) {
    return walkSemanticHtml(type, node.props, node.children);
  }

  // Block-mode: walk children, then combine via the block dispatch.
  const inner = walkChildren(node.children);
  return dispatchBlock(type, node.props, inner);
}
