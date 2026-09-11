import type { SemanticContentBlock, SemanticNode } from "@agentick/spec";

export type CollectItem =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "semantic"; readonly value: SemanticNode }
  | { readonly kind: "block"; readonly value: SemanticContentBlock };

/**
 * Inline grouping rule (ADR 22 §D5): contiguous text + semantic-node items
 * coalesce into ONE TextBlock (carrying a `semanticNode` sidecar when any
 * semantic item appeared in the run); a native block breaks the run.
 */
export function coalesceItems(items: readonly CollectItem[]): readonly SemanticContentBlock[] {
  const result: SemanticContentBlock[] = [];
  let runText: string[] = [];
  let runSem: SemanticNode[] = [];
  let hasSemantic = false;

  const flush = (): void => {
    if (hasSemantic) {
      for (const t of runText) runSem.push({ text: t });
      result.push({
        type: "text",
        text: "",
        semanticNode: { children: runSem },
      } as SemanticContentBlock);
    } else if (runText.length > 0) {
      result.push({ type: "text", text: runText.join("") });
    }
    runText = [];
    runSem = [];
    hasSemantic = false;
  };

  for (const item of items) {
    if (item.kind === "text") {
      if (hasSemantic) {
        runSem.push({ text: item.value });
      } else {
        runText.push(item.value);
      }
    } else if (item.kind === "semantic") {
      if (!hasSemantic) {
        for (const t of runText) runSem.push({ text: t });
        runText = [];
        hasSemantic = true;
      }
      runSem.push(item.value);
    } else {
      flush();
      result.push(item.value);
    }
  }
  flush();
  return result;
}
