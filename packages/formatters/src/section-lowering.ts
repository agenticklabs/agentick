/**
 * The one place a section becomes content.
 *
 * A `<Section>` is not a wire concept — a model call is system instructions
 * plus ordered messages and nothing else. So a section is lowered into the
 * content blocks of the message that contains it, and that lowering is
 * written ONCE, here, for every case: a section inside `<System>`, a section
 * inside `<User>`, and a free-floating section (which becomes an anonymous
 * `role: "grounding"` message whose content is this same lowering).
 *
 * Owning it in the formatters package is the point — `# ${title}` hardcoded
 * in a projection was a formatter bypass, and it is why an XML tree still
 * emitted markdown headings for its sections.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import type { CacheHint, ContentBlock, FormatterRef, TextBlock } from "@agentick/spec";

/**
 * Block-metadata key marking which section a block came from. Read by the
 * collector to decide separation between ADJACENT sections that landed in
 * the same message: two sections are two blocks, and a provider that
 * concatenates text parts with no separator would otherwise run them
 * together.
 */
export const SECTION_STAMP = "section";

/**
 * A section as the compiler sees it, before it becomes content. Deliberately
 * NOT an IR type — `SectionEntry` was deleted with ADR 94, and reintroducing
 * it as an interface would put the same idea back in the type system under a
 * different name. This is the argument shape of one function.
 */
export interface SectionSource {
  /** Stable id — survives recompiles, rides the produced blocks. */
  readonly id: string;
  readonly title?: string;
  readonly content: readonly ContentBlock[];
  /** Prompt-cache breakpoint for this section (#185). Rides the LAST block. */
  readonly cache?: CacheHint;
  /** Per-section provider knobs (Anthropic `cacheControl`). Rides the LAST block. */
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  /** Author-supplied bag. Rides EVERY block, so it survives wherever the
   *  section landed — including inside a message, where there is no entry
   *  left to carry it. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Section title → XML tag name: lowercase, every run of non-alphanumerics
 * collapsed to a single underscore, edges trimmed. `"Current User"` →
 * `current_user`. Returns `undefined` when nothing survives (a title of
 * `"???"`), which is the caller's signal to fall back to `<section id="…">`.
 */
export function sectionTagName(title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length === 0) return undefined;
  // A tag may not start with a digit; prefix rather than drop the leading
  // token, so `"2 Factor Auth"` stays distinguishable from `"Factor Auth"`.
  return /^[0-9]/.test(slug) ? `_${slug}` : slug;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

interface Frame {
  readonly open?: string;
  readonly close?: string;
}

function frameFor(section: SectionSource, format: string | undefined): Frame {
  if (format === "xml") {
    const tag = section.title !== undefined ? sectionTagName(section.title) : undefined;
    return tag !== undefined
      ? { open: `<${tag}>`, close: `</${tag}>` }
      : { open: `<section id="${escapeAttr(section.id)}">`, close: "</section>" };
  }
  if (section.title === undefined) return {};
  // `text` drops the marker; markdown (the default, and any formatter that
  // does not declare its own dialect) keeps the `# ` heading.
  return { open: format === "text" ? section.title : `# ${section.title}` };
}

/**
 * Lower a section to the content blocks it contributes to its containing
 * message.
 *
 * Text runs COALESCE: a title plus text blocks produce ONE `TextBlock`, whose
 * lines are joined with `\n`. That is not cosmetic — one block is one
 * projected message part, and splitting a section across parts changes the
 * bytes a provider assembles (OpenAI concatenates text parts with no
 * separator). Non-text blocks (an image inside a section) break the run and
 * pass through untouched, so nothing is dropped.
 *
 * `id` and the author's `metadata` ride EVERY produced block — inside a
 * message there is no entry left to carry them, so anything not on the blocks
 * is silently lost. `cache` and `providerMetadata` ride the LAST block, which
 * is the one a prompt-cache breakpoint should close over, matching how
 * Anthropic marks a message's last block.
 *
 * TODO(section-formatter-thread): the dialect is chosen from the in-scope
 * `FormatterRef.format` hint, not from the resolved formatter instance. A
 * third-party formatter with its own section dialect cannot express it until
 * the live formatter registry is threaded into the collect walk.
 */
export function lowerSection(
  section: SectionSource,
  formatter?: FormatterRef,
): readonly ContentBlock[] {
  const { open, close } = frameFor(section, formatter?.format);
  const out: ContentBlock[] = [];
  let run: string[] = open !== undefined ? [open] : [];

  const flush = (): void => {
    if (run.length === 0) return;
    out.push({
      type: "text",
      text: run.join("\n"),
      id: section.id,
      metadata: { ...section.metadata, [SECTION_STAMP]: section.id },
    } satisfies TextBlock);
    run = [];
  };

  for (const block of section.content) {
    // A block carrying a semantic sidecar is NOT plain text yet — the
    // formatter pass has not run, so its `text` is empty and its content
    // lives in the sidecar tree. Joining it here would erase it.
    if (block.type === "text" && (block as { semanticNode?: unknown }).semanticNode === undefined) {
      run.push(block.text);
      continue;
    }
    flush();
    out.push({
      ...block,
      id: block.id ?? section.id,
      metadata: { ...section.metadata, ...block.metadata, [SECTION_STAMP]: section.id },
    });
  }
  if (close !== undefined) run.push(close);
  flush();

  if (out.length === 0) return out;
  const last = out[out.length - 1]!;
  if (section.cache !== undefined || section.providerMetadata !== undefined) {
    out[out.length - 1] = {
      ...last,
      ...(section.cache !== undefined ? { cache: section.cache } : {}),
      ...(section.providerMetadata !== undefined
        ? { providerMetadata: { ...last.providerMetadata, ...section.providerMetadata } }
        : {}),
    };
  }
  return out;
}
