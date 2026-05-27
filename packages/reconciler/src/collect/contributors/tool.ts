/**
 * Tool contributor — `<tool>` intrinsic.
 *
 * Produces a `ToolDeclaration`. Children are folded into the tool's
 * description text (so authors can write JSX prose inside `<tool>` and
 * have it land in the declaration).
 */

import type { JsonSchema, ToolAnnotations, ToolDeclaration, ToolExposure } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface ToolProps {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly exposure?: readonly ToolExposure[];
  readonly handlerRef?: string;
  readonly annotations?: ToolAnnotations;
  readonly metadata?: Record<string, unknown>;
}

export const toolContributor: Contributor = {
  type: "tool",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ToolProps;
    if (!props.name) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<tool> without name at ${ctx.scope.path.join("/")}`,
            code: "MISSING_NAME",
          },
        },
      ];
    }
    if (!props.inputSchema) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<tool name="${props.name}"> without inputSchema`,
            code: "MISSING_INPUT_SCHEMA",
          },
        },
      ];
    }

    const childText = ctx.collectText(instance);
    const description = props.description ?? (childText.length > 0 ? childText : "");

    const tool: ToolDeclaration = {
      id: props.id ?? ctx.stableId("tool", instance),
      name: props.name,
      description,
      inputSchema: props.inputSchema,
      exposure: props.exposure ?? ["model"],
      ...(props.handlerRef !== undefined ? { handlerRef: props.handlerRef } : {}),
      ...(props.annotations !== undefined ? { annotations: props.annotations } : {}),
      ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
    };

    return [{ kind: "tool-declaration", tool }];
  },
};
