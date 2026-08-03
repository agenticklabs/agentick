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
import { Section, type SectionProps } from "./section.js";

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

/**
 * `<Event>...</Event>` — a record of something that happened. Sugar for
 * `<Message role="event">`.
 *
 * The idiom is a structured event block, not prose — the formatter derives the
 * rendering, so an event authored here and the same event replayed from a store
 * read identically:
 *
 *   <Event><system_event event="compaction" data={{ summary }} /></Event>
 */
export const Event = passThrough("event");

/**
 * `<Grounding>...</Grounding>` — non-conversational context at this position
 * in the conversation: what the user is looking at, who they are, what the
 * retrieval returned. Not an instruction and not a human turn.
 *
 * It is a `grounding` message wrapping a `<Section>`, which is exactly what
 * a free-floating `<Section>` compiles to — this is the explicit spelling of
 * the same thing (ADR 94). The section wrapper is load-bearing: providers
 * without a non-user role (Anthropic, Google) receive this as `user`, and
 * the structure in the content is what keeps it distinguishable from
 * something the human typed. OpenAI receives it as `developer`.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */
export function Grounding({ title, id, cache, children }: GroundingProps): React.ReactElement {
  return React.createElement(
    Message,
    { role: "grounding" },
    React.createElement(
      Section,
      {
        ...(title !== undefined ? { title } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(cache !== undefined ? { cache } : {}),
      },
      children,
    ),
  );
}

export interface GroundingProps {
  readonly title?: string;
  readonly id?: string;
  readonly cache?: SectionProps["cache"];
  readonly children?: ReactNode;
}

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
