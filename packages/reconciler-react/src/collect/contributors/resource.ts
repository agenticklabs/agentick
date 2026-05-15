/**
 * Resource contributor — `<resource>` intrinsic.
 *
 * Produces a `ResourceDeclaration`. Resource content is rendered on
 * demand via `renderResource`, not eagerly folded into context.
 */

import type { ResourceDeclaration } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface ResourceProps {
  readonly id?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly handlerRef?: string;
  readonly metadata?: Record<string, unknown>;
}

export const resourceContributor: Contributor = {
  type: "resource",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as ResourceProps;
    const resource: ResourceDeclaration = {
      id: props.id ?? ctx.stableId("resource", instance),
      ...(props.uri !== undefined ? { uri: props.uri } : {}),
      ...(props.name !== undefined ? { name: props.name } : {}),
      ...(props.description !== undefined ? { description: props.description } : {}),
      ...(props.mimeType !== undefined ? { mimeType: props.mimeType } : {}),
      ...(props.handlerRef !== undefined ? { handlerRef: props.handlerRef } : {}),
      ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
    };
    return [{ kind: "resource-declaration", resource }];
  },
};
