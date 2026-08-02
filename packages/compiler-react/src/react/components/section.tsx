/**
 * `<Section>` — typed PascalCase wrapper around the `<section>` intrinsic.
 *
 * A section is CONTENT, and where it lands is decided by what contains it:
 *
 *   - inside `<System>` / `<User>` / any `<Message>` — it becomes part of
 *     that message's content. `<System>` is not special; it is simply the
 *     message whose content becomes the provider's system parameter.
 *   - on its own between messages — it becomes a message at exactly that
 *     position, `role: "grounding"` unless `role` names another. A
 *     `<Section>` below `<Timeline />` is the last message the model
 *     receives.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 * @see packages/compiler/src/collect/contributors/section.ts
 */

import React, { type ReactNode } from "react";
import type { CacheHint, MessageRole } from "@agentick/spec";

export interface SectionProps {
  readonly id?: string;
  readonly title?: string;
  /**
   * Role for the anonymous message a FREE-STANDING section becomes —
   * `grounding` by default, which is what non-conversational context is.
   * Name another when the section IS a turn: `role="user"` makes it a plain
   * user message whose content is still the section structure.
   *
   * Inside a message this is a compile diagnostic, not a silent no-op: the
   * container has already decided the role, and honouring the prop would
   * mean breaking the section out of its parent — the hoisting ADR 94
   * removed.
   */
  readonly role?: MessageRole;
  /**
   * Prompt-cache breakpoint for this section. Rides the block the section
   * lowers to, so it stays a real boundary inside its message (#185).
   */
  readonly cache?: CacheHint;
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  readonly metadata?: Record<string, unknown>;
  readonly children?: ReactNode;
}

export function Section(props: SectionProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("section" as any, props);
}
