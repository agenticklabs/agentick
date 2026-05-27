/**
 * Model contributor — `<model>` intrinsic.
 *
 * Produces a partial `SpecConfig` (model selection + generation knobs)
 * and optionally a partial `ProviderOptions` payload. Adapter-specific
 * model components (`<openai>`, `<google>`, …) may register their own
 * contributors that include provider namespaces in `providerOptions`.
 */

import type { ProviderOptions, ResponseFormat, SpecConfig } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface ModelProps {
  readonly id?: string;
  readonly ref?: string;
  readonly responseFormat?: ResponseFormat;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: Record<string, unknown>;
  readonly providerOptions?: ProviderOptions;
}

export const modelContributor: Contributor = {
  type: "model",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ModelProps;
    const draft: {
      -readonly [K in keyof SpecConfig]?: SpecConfig[K];
    } = {};
    if (props.id !== undefined) draft.model = { kind: "by-id", id: props.id };
    else if (props.ref !== undefined) draft.model = { kind: "by-ref", ref: props.ref };
    if (props.responseFormat !== undefined) draft.responseFormat = props.responseFormat;
    if (props.maxOutputTokens !== undefined) draft.maxOutputTokens = props.maxOutputTokens;
    if (props.temperature !== undefined) draft.temperature = props.temperature;
    if (props.metadata !== undefined) draft.metadata = props.metadata;
    const partial: Partial<SpecConfig> = draft;

    const out: IRFragment[] = [];
    if (Object.keys(partial).length > 0) out.push({ kind: "spec-config", partial });
    if (props.providerOptions && Object.keys(props.providerOptions).length > 0) {
      out.push({ kind: "provider-options", partial: props.providerOptions });
    }
    return out;
  },
};
