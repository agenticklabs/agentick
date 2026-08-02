/**
 * Section contributor — `<section>` intrinsic.
 *
 * A section is CONTENT, not an entry. This contributor folds its children to
 * content blocks, wraps them with the section's structure in a `sectionNode`
 * carrier (`sectionBlock`), and emits a `section-content` fragment. It does
 * NOT lower: which dialect a section reads in — `# Title` or
 * `<current_user>` — is the formatter pass's call, and the pass has the live
 * formatter that collect does not.
 *
 * Where those blocks land is decided by the CONTAINER, not here:
 *
 *   - inside a `<message>` — the fold walker splices them into that
 *     message's content, whatever its role;
 *   - at entry level — the collector wraps them in an anonymous message at
 *     exactly this tree position, `role: "grounding"` unless the author
 *     named another with the `role` prop.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import type { CacheHint, MessageRole, SemanticContentBlock } from "@agentick/spec";
import { sectionBlock } from "@agentick/formatters";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

/**
 * `<section>` props. `id` defaults from {@link CollectContext.stableId};
 * `content` is folded from children.
 */
export interface SectionProps {
  readonly id?: string;
  readonly title?: string;
  /**
   * Role for the anonymous message a FREE-STANDING section becomes. Defaults
   * to `grounding`. Nested inside a message this is a diagnostic — the
   * container has already decided the role.
   */
  readonly role?: MessageRole;
  readonly cache?: CacheHint;
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  readonly metadata?: Record<string, unknown>;
}

export const sectionContributor: Contributor = {
  type: "section",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as SectionProps;
    const id = props.id ?? ctx.stableId("section", instance);
    const outbound: IRFragment[] = [];
    const content = ctx.collectContentBlocks(instance, outbound) as readonly SemanticContentBlock[];
    const renderedWith = ctx.formatter("section");

    const carrier = sectionBlock({
      id,
      content,
      ...(props.title !== undefined ? { title: props.title } : {}),
      ...(props.cache !== undefined ? { cache: props.cache } : {}),
      ...(props.providerMetadata !== undefined ? { providerMetadata: props.providerMetadata } : {}),
      ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
    });

    return [
      {
        kind: "section-content",
        id,
        blocks: [carrier],
        ...(props.role !== undefined ? { role: props.role } : {}),
        renderedWith,
        ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
      },
      ...outbound,
    ];
  },
};
