/**
 * Which timeline entry produced which part of a projected request.
 *
 * A provider rejects a REQUEST and names nothing inside it — Vertex says "the fileUri
 * parameter must be a Cloud Storage or HTTP(S) URI" without saying which of your entries it
 * read that from. Since every turn replays the whole conversation, that one entry then
 * breaks every future turn. Parsing the error text for a clue is a heuristic that differs
 * per provider; owning the projection is a mechanism.
 *
 * `provenance[i][j]` describes `buildMessages(tree)[i].content[j]`. A sibling of
 * `buildMessages` rather than a change to it, so the happy path pays nothing — this runs
 * only after something has already failed.
 *
 * **Scoped to THIS projection.** It mirrors the walk `buildMessages` does, and only that
 * walk. An adapter with its own `project` (Anthropic) or an app filtering via `<Timeline>`
 * projects differently, and these origins then name the wrong entries. The framework's
 * contribution is really the contract — *if you project, emit origins* — with this as the
 * conforming implementation for the default projection.
 */

import type { MessageEntry, RenderedTree, SectionEntry } from "@agentick/spec";

/**
 * Where one projected part came from.
 *
 * `entryId` is the timeline message id — stable across turns, unlike a position, which is
 * what lets a quarantine record survive the next message. Absent when the source entry
 * carried none, rather than fabricated.
 */
export interface PartOrigin {
  readonly entryId?: string;
  /** Index into that entry's `content`. */
  readonly blockIndex: number;
}

/**
 * Origins parallel to the projected messages. `undefined` for a part with no message-entry
 * origin — every part of the leading SYSTEM message, built from sections rather than
 * conversation, so there is nothing to quarantine and no id to name.
 *
 * Reading it is `provenance[messageIndex]?.[partIndex]`; collecting candidates is a filter.
 * Two traps if you write either, because both misattribute silently rather than erroring:
 *
 *   - **Dedupe by IDENTITY, not by value.** A `(entryId, blockIndex)` key collides across
 *     ID-LESS entries, where every first block is `{ blockIndex: 0 }`, so a real second
 *     candidate disappears. One origin object exists per position, so identity dedup can
 *     only ever collapse a genuine repeat.
 *   - **Index the UNFILTERED projection.** These coordinates describe `buildMessages(tree)`.
 *     Screening first shortens the list, and every position past the first removal then
 *     names a different part.
 */
export type MessageProvenance = ReadonlyArray<ReadonlyArray<PartOrigin | undefined>>;

/** Walk a tree the way `buildMessages` does, recording origins instead of building parts. */
export function buildMessageProvenance(tree: RenderedTree): MessageProvenance {
  const out: Array<ReadonlyArray<PartOrigin | undefined>> = [];

  // The system message, mirroring `buildMessages`' two shapes: cache-hinted sections emit
  // one part each, otherwise all sections collapse into one joined blob. Origins are
  // `undefined` either way, but the COUNT has to match or every later index is off by one.
  const sections = tree.context.entries.filter((e): e is SectionEntry => e.kind === "section");
  if (sections.some((sec) => sec.metadata?.cache !== undefined)) {
    const partCount = sections.filter((sec) => sectionTextLength(sec) > 0).length;
    if (partCount > 0) out.push(new Array<undefined>(partCount).fill(undefined));
  } else if (sections.some((sec) => sectionTextLength(sec) > 0)) {
    out.push([undefined]);
  }

  for (const entry of tree.context.entries) {
    if (entry.kind !== "message") continue;
    const message = entry as MessageEntry;
    out.push(
      message.content.map((_, blockIndex) => ({
        ...(message.id !== undefined ? { entryId: message.id } : {}),
        blockIndex,
      })),
    );
  }
  return out;
}

/**
 * The emptiness test `buildMessages` applies to a section. Duplicated rather than imported
 * so this module never concatenates a payload — it needs the length, not the string.
 */
function sectionTextLength(section: SectionEntry): number {
  let n = section.title !== undefined ? section.title.length + 2 : 0;
  for (const block of section.content) {
    if (block.type === "text") n += block.text.length;
  }
  return n;
}
