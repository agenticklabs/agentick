/**
 * Section contributor — `<section>` intrinsic.
 *
 * Produces a `SectionEntry` carrying the section's content blocks (folded
 * from text + content-block child fragments) and metadata derived from
 * props. The in-scope formatter is recorded as `renderedWith`.
 */

import type { SectionEntry, SectionMetadata } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface SectionProps {
  readonly id?: string;
  readonly title?: string;
  readonly priority?: number;
  readonly cache?: SectionMetadata["cache"];
  readonly providerMetadata?: SectionMetadata["providerMetadata"];
  readonly metadata?: Record<string, unknown>;
}

export const sectionContributor: Contributor = {
  type: "section",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as SectionProps;
    const id = props.id ?? ctx.stableId("section", instance);
    const outbound: IRFragment[] = [];
    const content = ctx.collectContentBlocks(instance, outbound);

    const metadata: SectionMetadata | undefined =
      props.priority !== undefined ||
      props.cache !== undefined ||
      props.providerMetadata !== undefined ||
      props.metadata !== undefined
        ? {
            ...(props.priority !== undefined ? { priority: props.priority } : {}),
            ...(props.cache !== undefined ? { cache: props.cache } : {}),
            ...(props.providerMetadata !== undefined
              ? { providerMetadata: props.providerMetadata }
              : {}),
            ...(props.metadata ?? {}),
          }
        : undefined;

    const entry: SectionEntry = {
      kind: "section",
      id,
      ...(props.title !== undefined ? { title: props.title } : {}),
      content,
      renderedWith: ctx.formatter("section"),
      ...(metadata ? { metadata } : {}),
    };

    return [{ kind: "context-entry", entry }, ...outbound];
  },
};
