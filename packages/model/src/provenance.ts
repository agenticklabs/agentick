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

import type { RenderedTree } from "@agentick/spec";

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
 * Origins parallel to the projected messages. `undefined` for a part with no id to
 * name — a system part built from a `<Section>` the adopter never gave an id, rather
 * than fabricated.
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
  // Mirrors the fold exactly: system entries merge into one leading message,
  // everything else keeps its position. The COUNT has to match part for part or
  // every later index is off by one.
  const system: Array<PartOrigin | undefined> = [];
  const rest: Array<ReadonlyArray<PartOrigin | undefined>> = [];

  for (const entry of tree.context.entries) {
    // A block keeps the id of whatever produced it — for a section that
    // lowered into this message's content, that is the SECTION's stable id,
    // which is what makes a system part attributable at all now that it is
    // no longer a top-level entry (ADR 94).
    const origins = entry.content.map((block, blockIndex) => {
      const entryId = block.id ?? entry.id;
      return { ...(entryId !== undefined ? { entryId } : {}), blockIndex };
    });
    if (entry.role === "system") system.push(...origins);
    else rest.push(origins);
  }

  return system.length > 0 ? [system, ...rest] : rest;
}
