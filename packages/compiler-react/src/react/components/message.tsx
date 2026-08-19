/**
 * `<Message>` — typed PascalCase wrapper around the `<message>` intrinsic.
 *
 * Author-facing surface for emitting a role-bearing context entry.
 * Mirrors the contributor's prop shape (see `collect/contributors/message.ts`)
 * so persisted timeline message records can be spread directly:
 *
 *   <Message {...entry.message} />
 *
 * Children ARE the content. `content` is the shorthand for a message with
 * none, so a persisted record can be spread and still composed with:
 *
 *   <Message {...entry.message}>
 *     <TurnMetadata message={entry.message} />
 *     <content blocks={entry.message.content} />
 *   </Message>
 *
 * The lowercase `<message>` intrinsic remains the host primitive — this
 * wrapper exists for TypeScript ergonomics (typed prop bag without
 * augmenting `JSX.IntrinsicElements`) and as the canonical author API.
 *
 * @see packages/compiler-react/src/collect/contributors/message.ts
 */

import React, { type ReactNode } from "react";
import type { ContentBlock, MessageMetadata, MessageRole } from "@agentick/spec";

export interface MessageProps {
  readonly role: MessageRole;
  readonly id?: string;
  /** Pre-built content blocks — used when this element has no children. */
  readonly content?: readonly ContentBlock[];
  /** Cross-provider caching intent. Maps to provider-native mechanics. */
  readonly cache?: MessageMetadata["cache"];
  readonly providerMetadata?: MessageMetadata["providerMetadata"];
  readonly metadata?: Record<string, unknown>;
  readonly children?: ReactNode;
}

/**
 * True inside any `<Message>` (and its role sugars). Position-aware
 * components read it to decide entry vs block: `<SystemEvent>` at the top
 * level forms its own event entry; inside a message it contributes just the
 * block. Both readings produce what the author meant — the context is what
 * lets one component serve both positions without double-wrapping.
 */
export const MessageScopeContext = React.createContext(false);

export function Message(props: MessageProps): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "message" as any,
    rest,
    children === undefined
      ? undefined
      : React.createElement(MessageScopeContext.Provider, { value: true }, children),
  );
}
