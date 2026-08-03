/**
 * Rendering for the three event blocks (`user_action`, `system_event`,
 * `state_change`).
 *
 * These blocks carry STRUCTURE — a name, a source, and a payload bag — and
 * the durable timeline stores that structure, not a rendering of it. The text
 * a model sees is derived here, so an event authored in JSX and the same event
 * replayed from a store a month later render identically.
 *
 * `block.text`, when present, replaces the derived body. The identifying
 * attributes still render.
 */

import type { EventBlock } from "@agentick/spec";

type Pair = readonly [string, string];

interface EventParts {
  /** Short identifiers — attributes in a tagged dialect. */
  readonly attrs: readonly Pair[];
  /** The payload — child elements in a tagged dialect. */
  readonly fields: readonly Pair[];
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

function entries(bag: Record<string, unknown> | undefined): Pair[] {
  return Object.entries(bag ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, scalar(value)] as const);
}

function present(pairs: readonly (readonly [string, string | undefined])[]): Pair[] {
  return pairs.filter((pair): pair is Pair => pair[1] !== undefined);
}

function eventParts(block: EventBlock): EventParts {
  switch (block.type) {
    case "user_action":
      return {
        attrs: present([
          ["action", block.action],
          ["actor", block.actor],
          ["target", block.target],
        ]),
        fields: entries(block.details),
      };
    case "system_event":
      return {
        attrs: present([
          ["event", block.event],
          ["source", block.source],
        ]),
        fields: entries(block.data),
      };
    case "state_change":
      return {
        attrs: present([
          ["entity", block.entity],
          ["field", block.field],
          ["trigger", block.trigger],
        ]),
        fields: [
          ["from", scalar(block.from)],
          ["to", scalar(block.to)],
        ],
      };
  }
}

export interface TagEscapers {
  readonly attr: (s: string) => string;
  readonly content: (s: string) => string;
}

/** `<system_event event="compaction"><summary>…</summary></system_event>` */
export function renderEventTag(block: EventBlock, escape: TagEscapers): string {
  const { attrs, fields } = eventParts(block);
  const head = attrs.map(([key, value]) => ` ${key}="${escape.attr(value)}"`).join("");
  const body =
    block.text !== undefined
      ? escape.content(block.text)
      : fields.map(([key, value]) => `<${key}>${escape.content(value)}</${key}>`).join("\n");
  return body.length === 0
    ? `<${block.type}${head} />`
    : `<${block.type}${head}>\n${body}\n</${block.type}>`;
}

/** `[system_event event=compaction]` followed by `key: value` lines. */
export function renderEventPlain(block: EventBlock): string {
  const { attrs, fields } = eventParts(block);
  const head = `[${block.type}${attrs.map(([key, value]) => ` ${key}=${value}`).join("")}]`;
  const body = block.text ?? fields.map(([key, value]) => `${key}: ${value}`).join("\n");
  return body.length === 0 ? head : `${head}\n${body}`;
}
