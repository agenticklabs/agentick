/**
 * Section contributor — `<section>` intrinsic.
 *
 * A section is CONTENT, not an entry. This contributor lowers its children
 * to content blocks (via the formatters package's single `lowerSection`
 * rule) and emits a `section-content` fragment. Where those blocks land is
 * decided by the CONTAINER, not here:
 *
 *   - inside a `<message>` — the fold walker splices them into that
 *     message's content, whatever its role;
 *   - at entry level — the collector wraps them in an anonymous message at
 *     exactly this tree position, `role: "grounding"` unless the author
 *     named another with the `role` prop.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import type { CacheHint, ContentBlock, MessageRole } from "@agentick/spec";
import { lowerSection } from "@agentick/formatters";
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
    const content = ctx.collectContentBlocks(instance, outbound) as readonly ContentBlock[];
    const renderedWith = ctx.formatter("section");

    // TODO(section-formatter-thread): markdown is the APPLIED dialect, even
    // under an `<XML>` scope. `lowerSection` implements the xml title→tag
    // rule and takes the ref, but wiring it here would double-process: the
    // harness's formatter pass runs AFTER collect and would escape the frame
    // this produced (`<current_user>` → `&lt;current_user&gt;`) while the
    // body — already lowered to text — would skip the escaping it needs.
    // Choosing the dialect correctly means resolving the live formatter
    // during the collect walk, which is the thread-through this names.
    const blocks = lowerSection({
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
        blocks,
        ...(props.role !== undefined ? { role: props.role } : {}),
        renderedWith,
        ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
      },
      ...outbound,
    ];
  },
};
