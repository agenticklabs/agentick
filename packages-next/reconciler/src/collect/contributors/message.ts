/**
 * Message contributor — `<message>` intrinsic.
 *
 * Produces a `MessageEntry` carrying the message's content blocks and
 * an Agentick semantic role (user/assistant/system/tool/event/...).
 *
 * Content resolution follows v1's controlled-or-uncontrolled precedence:
 *
 *   1. If `content` prop is supplied and non-empty → use it verbatim
 *      (skip walking children).
 *   2. Else if children produce content blocks → use those.
 *   3. Else → empty content array.
 *
 * The non-empty guard on the prop is intentional: `<message content={[]}>
 * fallback</message>` still folds the children, matching v1.
 */

import type { ContentBlock, MessageEntry, MessageMetadata, MessageRole } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface MessageProps {
  readonly id?: string;
  readonly role: MessageRole;
  /**
   * Pre-built content blocks. When supplied and non-empty, takes
   * precedence over children — useful when re-emitting persisted
   * timeline messages via `<Message {...entry.message} />`.
   */
  readonly content?: readonly ContentBlock[];
  readonly cache?: MessageMetadata["cache"];
  readonly providerMetadata?: MessageMetadata["providerMetadata"];
  readonly metadata?: Record<string, unknown>;
}

export const messageContributor: Contributor = {
  type: "message",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as MessageProps;
    if (!props.role) {
      // Missing required prop — surface as a diagnostic and skip.
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<message> without role at ${ctx.scope.path.join("/")}`,
            code: "MISSING_ROLE",
          },
        },
      ];
    }

    const outbound: IRFragment[] = [];
    let content: readonly ContentBlock[];
    if (Array.isArray(props.content) && props.content.length > 0) {
      content = props.content;
    } else {
      content = ctx.collectContentBlocks(instance, outbound);
    }

    const metadata: MessageMetadata | undefined =
      props.cache !== undefined ||
      props.providerMetadata !== undefined ||
      props.metadata !== undefined
        ? {
            ...(props.cache !== undefined ? { cache: props.cache } : {}),
            ...(props.providerMetadata !== undefined
              ? { providerMetadata: props.providerMetadata }
              : {}),
            ...(props.metadata ?? {}),
          }
        : undefined;

    const entry: MessageEntry = {
      kind: "message",
      role: props.role,
      content,
      renderedWith: ctx.formatter("message"),
      ...(props.id !== undefined ? { id: props.id } : {}),
      ...(metadata ? { metadata } : {}),
    };

    return [{ kind: "context-entry", entry }, ...outbound];
  },
};
