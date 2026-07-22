/**
 * Tool contributor — `<tool>` intrinsic.
 *
 * Produces a `ToolDeclaration`. Children are folded into the tool's
 * description text (so authors can write JSX prose inside `<tool>` and
 * have it land in the declaration).
 *
 * Props are DERIVED from `ToolDeclaration` (spec is the single sync
 * point) and forwarded by spread, so a new spec field flows through the
 * declaration by default. The {@link _conformance} assertion makes a
 * new field fail `tsc` here until it is partitioned into forwarded /
 * supplied.
 */

import type { ToolDeclaration, ToolExposure } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<tool>` props, derived from {@link ToolDeclaration}.
 *
 * Deltas (documented): `id` / `description` / `exposure` are re-typed
 * OPTIONAL — the contributor defaults `id` from {@link CollectContext.stableId},
 * `description` from folded child text, and `exposure` to `["model"]`.
 * Every other spec field (`aliases`, `providerOptions`, `outputSchema`,
 * `handlerRef`, `annotations`, `metadata`) forwards verbatim.
 */
export type ToolProps = Omit<ToolDeclaration, "id" | "description" | "exposure"> & {
  readonly id?: string;
  readonly description?: string;
  readonly exposure?: readonly ToolExposure[];
};

/** Spec keys forwarded verbatim from props. */
type ToolForwarded =
  | "name"
  | "inputSchema"
  | "outputSchema"
  | "aliases"
  | "handlerRef"
  | "annotations"
  | "metadata"
  | "providerOptions";
/** Spec keys the compiler supplies / defaults / folds from children. */
type ToolSupplied = "id" | "description" | "exposure";
type _conformance = Exhausted<UnhandledSpecKeys<ToolDeclaration, ToolForwarded, ToolSupplied>>;

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

    // Spread-forward every authored spec field (undefined stripped), then
    // override the compiler-supplied ones. New spec fields ride the spread
    // automatically; the conformance assertion above forces this partition
    // to stay total.
    const tool: ToolDeclaration = {
      ...(omitUndefined({ ...props }) as Partial<ToolDeclaration>),
      id: props.id ?? ctx.stableId("tool", instance),
      name: props.name,
      description,
      inputSchema: props.inputSchema,
      exposure: props.exposure ?? ["model"],
    };

    return [{ kind: "tool-declaration", tool }];
  },
};
