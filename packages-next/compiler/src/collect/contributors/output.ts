/**
 * Output contributor — `<output>` intrinsic.
 *
 * Produces an `OutputDeclaration`. Distinct from `SpecConfig.responseFormat`:
 * outputs are runtime-side registrations for named extraction, while
 * responseFormat is a generation-time provider directive.
 *
 * Props derive from {@link OutputDeclaration}; every field forwards by
 * spread, guarded by the {@link _conformance} assertion.
 */

import type { OutputDeclaration } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<output>` props, derived from {@link OutputDeclaration}. Delta: `id`
 * re-typed OPTIONAL (defaulted from {@link CollectContext.stableId}).
 */
export type OutputProps = Omit<OutputDeclaration, "id"> & { readonly id?: string };

type OutputForwarded = "schema" | "mode" | "name" | "description" | "strategy" | "metadata";
type OutputSupplied = "id";
type _conformance = Exhausted<
  UnhandledSpecKeys<OutputDeclaration, OutputForwarded, OutputSupplied>
>;

export const outputContributor: Contributor = {
  type: "output",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as OutputProps;
    const output: OutputDeclaration = {
      ...(omitUndefined({ ...props }) as Partial<OutputDeclaration>),
      id: props.id ?? ctx.stableId("output", instance),
    };
    return [{ kind: "output-declaration", output }];
  },
};
