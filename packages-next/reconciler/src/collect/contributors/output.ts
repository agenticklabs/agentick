/**
 * Output contributor — `<output>` intrinsic.
 *
 * Produces an `OutputDeclaration`. Distinct from `SpecConfig.responseFormat`:
 * outputs are runtime-side registrations for named extraction, while
 * responseFormat is a generation-time provider directive.
 */

import type { OutputDeclaration, StandardSchemaV1 } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface OutputProps {
  readonly id?: string;
  readonly schema?: StandardSchemaV1;
  readonly mode?: OutputDeclaration["mode"];
  readonly metadata?: Record<string, unknown>;
}

export const outputContributor: Contributor = {
  type: "output",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as OutputProps;
    const output: OutputDeclaration = {
      id: props.id ?? ctx.stableId("output", instance),
      ...(props.schema !== undefined ? { schema: props.schema } : {}),
      ...(props.mode !== undefined ? { mode: props.mode } : {}),
      ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
    };
    return [{ kind: "output-declaration", output }];
  },
};
