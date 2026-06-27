/**
 * Semantic-mode recursion — invoked when the walker hits a
 * semantic-html intrinsic (`<strong>`, `<em>`, `<ul>`, …).
 *
 * Children recurse as `SemanticNode[]`. Non-text, non-semantic
 * descendants are dropped per the semantic-html contract — block-
 * level content inside inline is a misuse, and silently dropping
 * is safer than crashing.
 */

import {
  getSemanticHtmlEntry,
  isSemanticHtmlTag,
  semanticBlock,
  semanticNode,
  type WalkScope,
} from "@agentick/compiler-next";
import type { ElementInstance, HostInstance } from "@agentick/reconciler-next";
import type { SemanticNode } from "@agentick/spec-next";

import type { WalkResult } from "./walk.js";

/**
 * Walk a semantic-html tag → one `SemanticContentBlock` whose
 * `semanticNode` is the full nested tree built from the children.
 *
 * `scope` is currently unused — semantic-mode produces no entries,
 * so the active `<format>` scope has nothing to stamp onto. Kept
 * in the signature so the walker can thread it consistently and
 * future per-semantic formatter overrides (e.g., scoped inline-code
 * rendering) drop in here without touching `walk.ts`.
 */
export function walkSemanticHtml(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly HostInstance[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _scope: WalkScope,
): WalkResult {
  const entry = getSemanticHtmlEntry(tag);
  if (!entry) return { entries: [], blocks: [] }; // shouldn't happen — caller already checked

  const semanticChildren = walkAsSemanticNodes(children);
  const mappedProps = entry.propsMapper?.(props);
  const node: SemanticNode = semanticNode(entry.semantic, semanticChildren, mappedProps);
  return { entries: [], blocks: [semanticBlock(node)] };
}

/**
 * Recurse children as `SemanticNode[]`. Bare text becomes `{text}`
 * leaves; nested semantic-html elements become `semanticNode(...)`.
 * Anything else is dropped silently.
 */
export function walkAsSemanticNodes(children: readonly HostInstance[]): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const child of children) {
    if (child.kind === "text") {
      if (child.text.length > 0) out.push({ text: child.text });
      continue;
    }
    const element = child as ElementInstance;
    const type = element.type;
    if (typeof type !== "string") continue;

    if (isSemanticHtmlTag(type)) {
      const entry = getSemanticHtmlEntry(type)!;
      const mapped = entry.propsMapper?.(element.props);
      out.push(semanticNode(entry.semantic, walkAsSemanticNodes(element.children), mapped));
      continue;
    }

    // Non-semantic-html element inside a semantic context. Silently
    // drop per the semantic-html contract.
  }
  return out;
}
