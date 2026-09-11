/**
 * `<formatted>` — its children are collected as a template root would be and
 * emitted as ONE `rendered` semantic node. The formatter pass of the enclosing
 * scope lowers that subtree in its dialect (entries that declared their own
 * keep it), frames it as a document, and composes the bytes verbatim into
 * whatever holds the node. What the model receives is a string.
 */

import { SPEC_VERSION, type MessageEntry, type RenderedTree } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import { isTextInstance } from "../../host/host-instance.js";
import { coalesceItems, type CollectItem } from "../coalesce.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

export const formattedContributor: Contributor = {
  type: "formatted",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const entries: MessageEntry[] = [];
    const items: CollectItem[] = [];
    const outbound: IRFragment[] = [];

    for (const child of instance.children) {
      if (isTextInstance(child)) {
        if (child.text.length > 0) items.push({ kind: "text", value: child.text });
        continue;
      }
      for (const frag of ctx.walk(child)) {
        switch (frag.kind) {
          case "context-entry":
            entries.push(frag.entry);
            break;
          case "section-content":
            entries.push({
              kind: "message",
              role: frag.role ?? "grounding",
              content: frag.blocks,
              id: frag.id,
              ...(frag.renderedWith ? { renderedWith: frag.renderedWith } : {}),
              ...(frag.metadata ? { metadata: frag.metadata } : {}),
            });
            break;
          case "free-root-content":
            for (const block of frag.blocks) items.push({ kind: "block", value: block });
            break;
          case "content-block":
            items.push({ kind: "block", value: frag.block });
            break;
          case "semantic-node":
            items.push({ kind: "semantic", value: frag.node });
            break;
          case "diagnostic":
            outbound.push(frag);
            break;
          default:
            break;
        }
      }
    }

    const content = coalesceItems(items);
    if (entries.length === 0 && content.length === 0) return outbound;

    const tree: RenderedTree = {
      specVersion: SPEC_VERSION,
      context: { entries },
      ...(content.length > 0 ? { content, renderedWith: ctx.formatter() } : {}),
    };
    return [{ kind: "semantic-node", node: { semantic: "rendered", tree } }, ...outbound];
  },
};
