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
 * WHEN it runs is the other half. The compile walk emits a
 * {@link SectionNode} sidecar via {@link sectionBlock} and stops; the
 * formatter pass calls {@link expandSections}, which renders the section's
 * body in the in-scope dialect and only then frames it. Body-first-then-frame
 * is what keeps an xml tag out of the escaper and the body out of it twice.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import type {
  ContentBlock,
  FormatterRef,
  FormatterResolver,
  SectionNode,
  SemanticContentBlock,
  TextBlock,
} from "@agentick/spec";
import { isSectionContent } from "@agentick/spec";

/**
 * Block-metadata key naming which section a block came from.
 *
 * Attribution, and nothing else. It briefly also drove a merge of adjacent
 * sections into one block; that join was a TRANSPORT concern (a provider
 * concatenating text parts with no separator) and now lives at projection,
 * where every adjacent text part is joined and not just the two that happen to
 * be sections. What is left here is the honest use: a block says which section
 * produced it, and two adjacent sections stay two blocks with two ids.
 */
export const SECTION_STAMP = "section";

/**
 * Wrap a section's structure in the carrier block that rides the IR from the
 * collect walk to the formatter pass.
 *
 * The block is `text` with an empty `text` and the structure in the sidecar,
 * which is precisely the shape a semantic-node block already has — a block
 * that is not text YET. {@link expandSections} replaces it with the lowered
 * blocks; nothing downstream of the formatter pass ever sees it.
 */
export function sectionBlock(section: SectionNode): SemanticContentBlock {
  return { type: "text", text: "", sectionNode: section } as SemanticContentBlock;
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

function frameFor(section: SectionNode, format: string | undefined): Frame {
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
 * `content` is expected to be ALREADY rendered by the dialect named in
 * `formatter` — {@link expandSections} guarantees that. A block still
 * carrying a semantic sidecar is passed through rather than joined as text,
 * because its `text` is empty and joining it would erase it.
 */
export function lowerSection(
  section: SectionNode,
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

/**
 * Replace every {@link SectionNode} carrier in `blocks` with its lowering in
 * `ref`'s dialect, rendering everything else through `render`.
 *
 * This is the whole thread-through. A section's body goes through `render`
 * BEFORE the frame is applied, so an xml section emits
 * `<current_user>` around an already-escaped body — the tag never reaches the
 * escaper, and the body reaches it exactly once. It also collapses what used
 * to be two passes into one: a section whose body is semantic HTML is a single
 * coherent lowering rather than a title block followed by a body block.
 *
 * Sections nest, so the recursion is on `section.content`.
 *
 * ## Islands — the nearest declared scope decides
 *
 * A section carries the dialect declared at its position
 * ({@link SectionNode.renderedWith}). When `resolve` can turn that ref into a
 * DIFFERENT formatter than the one running, the section is an island: its body
 * is rendered by that formatter (recursively, so islands nest), framed by that
 * dialect's rule, and the resulting blocks are pushed as they are. They are
 * NOT passed through `render` — they are already wire-shape for the dialect
 * their author asked for, and running the outer dialect over them would escape
 * an xml island's tags into `&lt;current_user&gt;`, which is a rendering OF an
 * island rather than an island. See the module docblock of
 * `create-formatter.ts` for the embedding argument in full.
 *
 * With no `resolve` (a pinned formatter, a direct `markdownFormatter(blocks)`
 * call) there are no islands: one dialect renders everything, which is what
 * pinning means.
 *
 * Every formatter built with `createFormatter` runs this ahead of its own
 * block pass, which is why third-party formatters get section lowering — and
 * islands — without writing a line of either.
 */
export function expandSections(
  blocks: readonly SemanticContentBlock[],
  render: (blocks: readonly SemanticContentBlock[]) => readonly ContentBlock[],
  ref: FormatterRef,
  resolve?: FormatterResolver,
): readonly ContentBlock[] {
  if (!blocks.some(isSectionContent)) return render(blocks);

  const out: ContentBlock[] = [];
  let run: SemanticContentBlock[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    for (const b of render(run)) out.push(b);
    run = [];
  };

  for (const block of blocks) {
    if (!isSectionContent(block)) {
      run.push(block);
      continue;
    }
    flushRun();
    const section = block.sectionNode;
    const island = section.renderedWith !== undefined ? resolve?.(section.renderedWith) : undefined;
    const lowered =
      island !== undefined && island.__identity.id !== ref.id
        ? lowerSection({ ...section, content: island(section.content, resolve) }, island.__identity)
        : lowerSection(
            { ...section, content: expandSections(section.content, render, ref, resolve) },
            ref,
          );
    for (const b of lowered) out.push(b);
  }
  flushRun();
  return out;
}
