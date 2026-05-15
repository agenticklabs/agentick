/**
 * Message contributor — `<message>` intrinsic.
 *
 * Produces a `MessageEntry` carrying the message's content blocks and
 * an Agentick semantic role (user/assistant/system/tool/event/...).
 */

import type { MessageEntry, MessageMetadata, MessageRole } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface MessageProps {
  readonly id?: string;
  readonly role: MessageRole;
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

    const content = ctx.collectContentBlocks(instance);
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

    return [{ kind: "context-entry", entry }];
  },
};
