/**
 * `createFormatter` — author entry point for content formatters.
 *
 * A {@link Formatter} is a pure function `(SemanticContentBlock[]) →
 * ContentBlock[]`. `createFormatter` decorates the render function with
 * identity metadata (`id`, `format`, `version`) so the reconciler's
 * formatter registry can dispatch by {@link FormatterRef} and so traces
 * can record which formatter ran.
 *
 * Beyond block-level rendering, a formatter can also OWN its own
 * tree-level serialization rules via three optional callbacks:
 *
 *   - `frameSection(entry, body)` — wraps a SectionEntry's formatted
 *     body with format-appropriate framing (markdown `## title`, xml
 *     `<section>` tags, etc.).
 *   - `frameMessage(entry, body)` — same for MessageEntry.
 *   - `blocksToText(blocks)` — flattens the formatted ContentBlock[]
 *     into the final string. Override when block-to-text needs
 *     non-default handling (e.g., a YAML formatter that wants to emit
 *     image blocks as `image: { url: ... }`).
 *
 * When omitted, `formatTree` falls back to markdown-flavored defaults.
 * 3rd-party formatters that need full control over serialization
 * supply all three.
 *
 * Per ADR 36 (define vs create): formatters need no parent-harness
 * substrate to construct, so the verb is `create`, not `define`. The
 * return type {@link DefinedFormatter} keeps its name — type names are
 * not covered by the convention.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2 + §D6
 * @see docs/proposals/v2/blueprint/36-define-vs-create-convention.md
 */

import { omitUndefined } from "@agentick/utils-next";

import type {
  ContentBlock,
  Formatter,
  FormatterIdentity,
  FormatterRef,
  MessageEntry,
  SectionEntry,
  SemanticContentBlock,
} from "@agentick/spec-next";

export interface CreateFormatterInput extends FormatterIdentity {
  readonly render: (blocks: readonly SemanticContentBlock[]) => readonly ContentBlock[];
  /**
   * Optional: frame a SectionEntry's formatted body. Receives the
   * formatted-block string output of `blocksToText` and returns the
   * final framed string for this section.
   *
   * Omit to fall back to `formatTree`'s default (markdown `## title`).
   */
  readonly frameSection?: (entry: SectionEntry, body: string) => string;
  /**
   * Optional: frame a MessageEntry's formatted body. Same contract as
   * `frameSection`.
   *
   * Omit to fall back to `formatTree`'s default (`**role:** body`).
   */
  readonly frameMessage?: (entry: MessageEntry, body: string) => string;
  /**
   * Optional: flatten the formatter's ContentBlock[] output into a
   * single string. Override when block-to-text needs non-default
   * handling.
   *
   * Omit to fall back to `formatTree`'s default (text/code/json/event
   * blocks → their `.text`; media → markdown image/link syntax).
   */
  readonly blocksToText?: (blocks: readonly ContentBlock[]) => string;
}

/**
 * A `Formatter` function decorated with identity metadata + optional
 * tree-level serialization callbacks. The reconciler reads
 * `__identity` to build the `FormatterRef` used in
 * `MessageEntry.renderedWith` / `SectionEntry.renderedWith`.
 * `formatTree` reads `frameSection` / `frameMessage` / `blocksToText`
 * to delegate serialization to the formatter (with markdown-flavored
 * fallbacks when a formatter omits them).
 */
export interface DefinedFormatter extends Formatter {
  readonly __identity: FormatterIdentity;
  readonly frameSection?: (entry: SectionEntry, body: string) => string;
  readonly frameMessage?: (entry: MessageEntry, body: string) => string;
  readonly blocksToText?: (blocks: readonly ContentBlock[]) => string;
}

export function createFormatter(spec: CreateFormatterInput): DefinedFormatter {
  const identity: FormatterIdentity = {
    id: spec.id,
    format: spec.format,
    ...omitUndefined({ version: spec.version }),
  };
  const fn: DefinedFormatter = Object.assign(
    (blocks: readonly SemanticContentBlock[]) => spec.render(blocks),
    {
      __identity: identity,
      ...omitUndefined({
        frameSection: spec.frameSection,
        frameMessage: spec.frameMessage,
        blocksToText: spec.blocksToText,
      }),
    },
  );
  return fn;
}

/** Resolve a `FormatterRef` from a defined formatter. */
export function refOf(formatter: DefinedFormatter): FormatterRef {
  return formatter.__identity;
}
