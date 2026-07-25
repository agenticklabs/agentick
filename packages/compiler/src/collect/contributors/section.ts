/**
 * Section contributor — `<section>` intrinsic.
 *
 * Produces a `SectionEntry` carrying the section's content blocks (folded
 * from text + content-block child fragments) and metadata derived from
 * props. The in-scope formatter is recorded as `renderedWith`.
 *
 * Props derive from {@link SectionEntry}; `title` forwards, the rest are
 * compiler-supplied (see the {@link _conformance} partition below).
 */

import type { SectionEntry, SectionMetadata } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<section>` props, derived from {@link SectionEntry}. Deltas: `kind` is
 * the compiler-set constant discriminant (omitted); `id` re-typed OPTIONAL
 * (defaulted from {@link CollectContext.stableId}); `content` is folded
 * from children; `priority`/`cache`/`providerMetadata` are
 * {@link SectionMetadata} fields folded into `metadata`.
 */
export type SectionProps = Omit<
  SectionEntry,
  "kind" | "id" | "content" | "renderedWith" | "renderTrace"
> & {
  readonly id?: string;
  readonly priority?: SectionMetadata["priority"];
  readonly cache?: SectionMetadata["cache"];
  readonly providerMetadata?: SectionMetadata["providerMetadata"];
};

type SectionForwarded = "title";
/** `kind` = constant; `id`/`content`/`renderedWith` computed; `renderTrace`
 *  is formatter-populated; `metadata` is assembled from the
 *  `priority`/`cache`/`providerMetadata`/`metadata` props. */
type SectionSupplied = "kind" | "id" | "content" | "renderedWith" | "renderTrace" | "metadata";
type _conformance = Exhausted<UnhandledSpecKeys<SectionEntry, SectionForwarded, SectionSupplied>>;

export const sectionContributor: Contributor = {
  type: "section",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as SectionProps;
    const id = props.id ?? ctx.stableId("section", instance);
    const outbound: IRFragment[] = [];
    const content = ctx.collectContentBlocks(instance, outbound);

    const metadata: SectionMetadata | undefined =
      props.priority !== undefined ||
      props.cache !== undefined ||
      props.providerMetadata !== undefined ||
      props.metadata !== undefined
        ? {
            ...omitUndefined({
              priority: props.priority,
              cache: props.cache,
              providerMetadata: props.providerMetadata,
            }),
            ...(props.metadata ?? {}),
          }
        : undefined;

    const entry: SectionEntry = {
      kind: "section",
      id,
      ...omitUndefined({ title: props.title }),
      content,
      renderedWith: ctx.formatter("section"),
      ...(metadata ? { metadata } : {}),
    };

    return [{ kind: "context-entry", entry }, ...outbound];
  },
};
