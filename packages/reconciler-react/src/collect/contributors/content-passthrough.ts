/**
 * `<content>` — passthrough intrinsic for spec-shape content blocks.
 *
 * Re-emits a list of pre-built `ContentBlock`s as content-block fragments,
 * letting components inject persisted (or otherwise out-of-band) blocks
 * into the collect pipeline without re-authoring them as JSX intrinsics.
 *
 * Typical use — `<Timeline>` renders persisted entries via
 * `<message role={e.role}><content blocks={e.content} /></message>`. The
 * enclosing `<message>` calls `ctx.collectContentBlocks(...)` which folds
 * the passthrough's content-block fragments into `MessageEntry.content`.
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
