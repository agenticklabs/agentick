/**
 * Message contributor — `<message>` intrinsic.
 *
 * Produces a `MessageEntry` carrying the message's content blocks and
 * an Agentick semantic role (user/assistant/system/tool/event/...).
 *
 * **Children win.** They are the content; `content` is the shorthand for a
 * message that has none:
 *
 *   1. If children produce content blocks → use those.
 *   2. Else → the `content` prop, verbatim.
 *   3. Else → empty content array.
 *
 * The prop cannot shadow children, because `<Message {...entry.message}>` is
 * how a persisted message is replayed with something added to it — a metadata
 * section ahead of the body, retrieved context after it — and a spread that
 * silently dropped every child made the whole composition unwritable.
 *
 * Props derive from {@link MessageEntry}; `role`/`id` forward, the rest
 * are compiler-supplied (see the {@link _conformance} partition below).
 */

import type { ContentBlock, MessageEntry, MessageMetadata } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<message>` props, derived from {@link MessageEntry}. Deltas: `kind`
 * is the compiler-set constant discriminant (omitted); `content` is
 * re-typed OPTIONAL (folded from children when absent);
 * `cache`/`providerMetadata` are {@link MessageMetadata} fields folded
 * into `metadata` (they are NOT `MessageEntry` keys).
 */
export type MessageProps = Omit<
  MessageEntry,
  "kind" | "content" | "renderedWith" | "renderTrace"
> & {
  /** Pre-built content blocks — used when the element has no children. */
  readonly content?: readonly ContentBlock[];
  readonly cache?: MessageMetadata["cache"];
  readonly providerMetadata?: MessageMetadata["providerMetadata"];
};

type MessageForwarded = "role" | "id";
/** `kind` = constant; `content`/`renderedWith` computed; `renderTrace` is
 *  formatter-populated (never tree-authored); `metadata` is assembled from
 *  the `cache`/`providerMetadata`/`metadata` props. */
type MessageSupplied = "kind" | "content" | "renderedWith" | "renderTrace" | "metadata";
type _conformance = Exhausted<UnhandledSpecKeys<MessageEntry, MessageForwarded, MessageSupplied>>;

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
    const fromChildren = ctx.collectContentBlocks(instance, outbound);
    const content: readonly ContentBlock[] =
      fromChildren.length > 0 ? fromChildren : (props.content ?? []);

    const metadata: MessageMetadata | undefined =
      props.cache !== undefined ||
      props.providerMetadata !== undefined ||
      props.metadata !== undefined
        ? {
            ...omitUndefined({ cache: props.cache, providerMetadata: props.providerMetadata }),
            ...(props.metadata ?? {}),
          }
        : undefined;

    const entry: MessageEntry = {
      kind: "message",
      role: props.role,
      content,
      renderedWith: ctx.formatter("message"),
      ...omitUndefined({ id: props.id }),
      ...(metadata ? { metadata } : {}),
    };

    return [{ kind: "context-entry", entry }, ...outbound];
  },
};
