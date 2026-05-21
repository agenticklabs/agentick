/**
 * `<content>` — passthrough intrinsic for spec-shape content blocks.
 *
 * Re-emits a list of pre-built `ContentBlock`s as content-block fragments,
 * folding them into the enclosing container's content collection. Works
 * inside any container that calls `ctx.collectContentBlocks()` —
 * `<section>`, `<ephemeral>`, `<grounding>`, `<message>` (when used
 * without its `content` prop), and any custom container that opts in.
 *
 * When blocks are already in spec shape — RAG results, MCP tool output,
 * snapshot replay, cross-session quoting — this is the escape hatch that
 * avoids translating each block back into the matching JSX intrinsic.
 *
 * For a single persisted timeline entry, `<Message {...entry} />` is more
 * direct (the contributor's `content` prop accepts `ContentBlock[]`
 * verbatim). Reach for `<content>` when (a) the container has no
 * `content` prop, or (b) you need to mix authored blocks with pre-built
 * ones inside the same container.
 *
 * @example
 *   <section title="Retrieved facts">
 *     <text>The model also has access to:</text>
 *     <content blocks={ragResults} />
 *   </section>
 *
 * @see packages/reconciler-react/src/collect/contributors/message.ts
 */

import type { ContentBlock } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface ContentProps {
  readonly blocks?: readonly ContentBlock[];
}

export const contentPassthroughContributor: Contributor = {
  type: "content",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ContentProps;
    if (!props.blocks || props.blocks.length === 0) return [];
    return props.blocks.map((block) => ({ kind: "content-block", block }));
  },
};
