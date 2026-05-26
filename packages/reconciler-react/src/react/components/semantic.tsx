/**
 * Semantic JSX wrappers — short author-facing aliases over the
 * `<message>` / `<paragraph>` / `<heading>` intrinsics.
 *
 * Avoids the awkward `<Message role="system">...</Message>` boilerplate
 * for the common role cases. `<System>...</System>` reads like prose.
 *
 * These are TRIVIAL wrappers — pure prop shape over the intrinsics the
 * built-in contributors handle. No additional behavior.
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

export function Paragraph({ children }: { children?: ReactNode }): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("paragraph" as any, null, children);
}

interface HeaderProps {
  readonly children?: ReactNode;
}

export function H1({ children }: HeaderProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("heading" as any, { level: 1 }, children);
}

export function H2({ children }: HeaderProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("heading" as any, { level: 2 }, children);
}

export function H3({ children }: HeaderProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("heading" as any, { level: 3 }, children);
}
