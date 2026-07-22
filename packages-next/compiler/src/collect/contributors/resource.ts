/**
 * Resource contributor — `<resource>` intrinsic.
 *
 * Produces a `ResourceDeclaration`. Resource content is resolved by
 * the runtime on demand via `handlerRef` (same pattern as tool
 * handlers) — not eagerly folded into context, and not the compiler's
 * concern.
 *
 * Props derive from {@link ResourceDeclaration}; every field forwards by
 * spread. The {@link _conformance} assertion fails `tsc` if a new spec
 * field is added without being partitioned.
 */

import type { ResourceDeclaration } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<resource>` props, derived from {@link ResourceDeclaration}. Delta:
 * `id` re-typed OPTIONAL (defaulted from {@link CollectContext.stableId}).
 */
export type ResourceProps = Omit<ResourceDeclaration, "id"> & { readonly id?: string };

type ResourceForwarded = "uri" | "name" | "description" | "mimeType" | "handlerRef" | "metadata";
type ResourceSupplied = "id";
type _conformance = Exhausted<
  UnhandledSpecKeys<ResourceDeclaration, ResourceForwarded, ResourceSupplied>
>;

export const resourceContributor: Contributor = {
  type: "resource",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ResourceProps;
    const resource: ResourceDeclaration = {
      ...(omitUndefined({ ...props }) as Partial<ResourceDeclaration>),
      id: props.id ?? ctx.stableId("resource", instance),
    };
    return [{ kind: "resource-declaration", resource }];
  },
};
