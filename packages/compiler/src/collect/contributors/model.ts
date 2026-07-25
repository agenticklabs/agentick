/**
 * Model contributor — `<model>` intrinsic.
 *
 * Produces a partial `SpecConfig` (model selection + generation knobs)
 * and optionally a partial `ProviderOptions` payload. Adapter-specific
 * model components (`<openai>`, `<google>`, …) may register their own
 * contributors that include provider namespaces in `providerOptions`.
 *
 * Props derive from {@link SpecConfig} (minus the transformed `model`
 * selection, which the contributor builds from the `id`/`ref` props) plus
 * a `providerOptions` escape. Every other generation knob — `topP`,
 * `frequencyPenalty`, `presencePenalty`, `stopSequences`, … — forwards by
 * spread, so a new `SpecConfig` field flows through by default; the
 * {@link _conformance} assertion fails `tsc` until it is partitioned.
 */

import type { ProviderOptions, ModelSelection, SpecConfig } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<model>` props, derived from {@link SpecConfig}. Deltas: the `model`
 * selection is not authored directly — the contributor builds it from
 * the `id` (`by-id`) / `ref` (`by-ref`) props; `providerOptions` is a
 * per-call provider escape emitted as a separate IR fragment.
 */
export type ModelProps = Omit<SpecConfig, "model"> & {
  readonly id?: string;
  readonly ref?: string;
  readonly providerOptions?: ProviderOptions;
};

type ModelForwarded =
  | "responseFormat"
  | "toolChoice"
  | "maxOutputTokens"
  | "temperature"
  | "topP"
  | "frequencyPenalty"
  | "presencePenalty"
  | "stopSequences"
  | "metadata";
type ModelSupplied = "model";
type _conformance = Exhausted<UnhandledSpecKeys<SpecConfig, ModelForwarded, ModelSupplied>>;

export const modelContributor: Contributor = {
  type: "model",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ModelProps;
    const { id, ref, providerOptions, ...specFields } = props;

    const model: ModelSelection | undefined =
      id !== undefined
        ? { kind: "by-id", id }
        : ref !== undefined
          ? { kind: "by-ref", ref }
          : undefined;

    // Spread every authored SpecConfig knob (undefined stripped), then
    // overlay the transformed model selection. New SpecConfig fields ride
    // the spread; the conformance assertion keeps the partition total.
    const partial: Partial<SpecConfig> = omitUndefined({
      ...specFields,
      ...(model ? { model } : {}),
    });

    const out: IRFragment[] = [];
    if (Object.keys(partial).length > 0) out.push({ kind: "spec-config", partial });
    if (providerOptions && Object.keys(providerOptions).length > 0) {
      out.push({ kind: "provider-options", partial: providerOptions });
    }
    return out;
  },
};
