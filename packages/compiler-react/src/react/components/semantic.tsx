/**
 * Semantic JSX wrappers — short author-facing aliases over the
 * `<message>` intrinsic and the semantic-HTML intrinsics (`<h1>`–`<h3>`,
 * `<p>`).
 *
 * Avoids the awkward `<Message role="system">...</Message>` boilerplate
 * for the common role cases. `<System>...</System>` reads like prose.
 *
 * These are TRIVIAL wrappers — pure prop shape over the intrinsics the
 * built-in contributors handle. No additional behavior. The block
 * wrappers therefore emit the tag `semanticHtmlContributors()` CLAIMS
 * (`h2`, not a bespoke `heading level={2}`): an unclaimed intrinsic has
 * no contributor, so the walker collects only its text children and the
 * heading semantics vanish from the compiled context.
 *
 * @see packages/compiler/src/collect/contributors/semantic-html.ts
 * @verifiedBy packages/compiler-react/src/__tests__/semantic-wrappers.spec.tsx
 */

import React, { type ReactNode } from "react";
import { Message, type MessageProps } from "./message.js";

const passThrough = (role: MessageProps["role"]) =>
  function RoleMessage(props: Omit<MessageProps, "role">): React.ReactElement {
    return React.createElement(Message, { ...props, role });
  };

/**
 * `<System>...</System>` — system prompt message.
 * Sugar for `<Message role="system">`.
 */
export const System = passThrough("system");

/**
 * `<User>...</User>` — user message. Sugar for `<Message role="user">`.
 */
export const User = passThrough("user");

/**
 * `<Assistant>...</Assistant>` — assistant message. Sugar for
 * `<Message role="assistant">`.
 */
export const Assistant = passThrough("assistant");

// ─── Block-level semantic wrappers ───────────────────────────────────

/** `<Paragraph>...</Paragraph>` — paragraph block. Sugar for `<p>`. */
export function Paragraph({ children }: BlockProps): React.ReactElement {
  return React.createElement("p", null, children);
}

interface BlockProps {
  readonly children?: ReactNode;
}

/** `<H1>...</H1>` — level-1 heading. Sugar for `<h1>`. */
export function H1({ children }: BlockProps): React.ReactElement {
  return React.createElement("h1", null, children);
}

/** `<H2>...</H2>` — level-2 heading. Sugar for `<h2>`. */
export function H2({ children }: BlockProps): React.ReactElement {
  return React.createElement("h2", null, children);
}

/** `<H3>...</H3>` — level-3 heading. Sugar for `<h3>`. */
export function H3({ children }: BlockProps): React.ReactElement {
  return React.createElement("h3", null, children);
}
