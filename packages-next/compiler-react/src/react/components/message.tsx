/**
 * `<Message>` — typed PascalCase wrapper around the `<message>` intrinsic.
 *
 * Author-facing surface for emitting a role-bearing context entry.
 * Mirrors the contributor's prop shape (see `collect/contributors/message.ts`)
 * so persisted timeline message records can be spread directly:
 *
 *   <Message {...entry.message} />
 *
 * Content resolution follows the contributor's controlled-or-uncontrolled
 * rule: a non-empty `content` prop wins; otherwise children are folded
 * via `ctx.collectContentBlocks()`.
 *
 * The lowercase `<message>` intrinsic remains the host primitive — this
 * wrapper exists for TypeScript ergonomics (typed prop bag without
 * augmenting `JSX.IntrinsicElements`) and as the canonical author API.
 *
 * @see packages/compiler-react/src/collect/contributors/message.ts
 */

import React, { type ReactNode } from "react";
import type { ContentBlock, MessageMetadata, MessageRole } from "@agentick/spec-next";

export interface MessageProps {
  readonly role: MessageRole;
  readonly id?: string;
  /**
   * Pre-built content blocks. When supplied and non-empty, takes
   * precedence over children. Empty arrays fall through to children
   * (matching v1's controlled-or-uncontrolled precedence).
   */
  readonly content?: readonly ContentBlock[];
  /** Cross-provider caching intent. Maps to provider-native mechanics. */
  readonly cache?: MessageMetadata["cache"];
  readonly providerMetadata?: MessageMetadata["providerMetadata"];
  readonly metadata?: Record<string, unknown>;
  readonly children?: ReactNode;
}

export function Message(props: MessageProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("message" as any, props);
}
