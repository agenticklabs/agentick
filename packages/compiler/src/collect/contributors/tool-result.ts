/**
 * `<tool_result>` — the answer to a tool call, authored in JSX. Children fold
 * into `content` (a `<Formatted>` subtree, blocks, text); the `content` prop
 * is the verbatim alternative for blocks already in spec shape.
 */

import type { ContentBlock, ToolResultBlock } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import type { BaseBlockKey, Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

export type ToolResultProps = Omit<ToolResultBlock, "type" | "content"> & {
  readonly content?: readonly ContentBlock[];
};

type ToolResultForwarded = BaseBlockKey | "toolUseId" | "name" | "isError" | "executedBy";
type _conformance = Exhausted<
  UnhandledSpecKeys<ToolResultBlock, ToolResultForwarded, "type" | "content">
>;

export const toolResultContributor: Contributor = {
  type: "tool_result",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ToolResultProps;
    if (!props.toolUseId || !props.name) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_TOOL_USE_ID",
            message: `<tool_result> requires "toolUseId" and "name" props`,
          },
        },
      ];
    }
    const outbound: IRFragment[] = [];
    const fromChildren = ctx.collectContentBlocks(instance, outbound);
    const content = fromChildren.length > 0 ? fromChildren : (props.content ?? []);
    const block: ToolResultBlock = {
      ...(omitUndefined({ ...props }) as Partial<ToolResultBlock>),
      type: "tool_result",
      toolUseId: props.toolUseId,
      name: props.name,
      content,
    };
    return [{ kind: "content-block", block }, ...outbound];
  },
};
