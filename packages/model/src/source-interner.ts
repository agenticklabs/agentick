/**
 * `createSourceInterner` — the per-turn source registry adapters use to turn a
 * provider's repeated citation-source data into normalized {@link Source}
 * entities with turn-stable ids.
 *
 * The source/citation model (see {@link Source} / {@link Citation}) is
 * normalized: sources are entities, citations reference them by
 * {@link Source.id}. An adapter walking a provider response meets the same
 * source (the same URL, the same request-document) across many spans and blocks;
 * it MUST mint one `Source` with one id and reuse it, so a citation's `sourceId`
 * resolves and the message-level roll-up dedupes cleanly. This interner is that
 * one-source-one-id guarantee, scoped to a single normalize (one turn).
 *
 * Dedupe is by NATURAL KEY — `url`, else `doc:<documentIndex>`. A source with
 * neither (no url, no document index) has no identity to share and is interned
 * as its own distinct entity every call. Ids are `s0`, `s1`, … in first-seen
 * order; `all()` returns them in that order (the natural "Sources" ordering).
 *
 * @verifiedBy packages/model/src/__tests__/source-interner.spec.ts
 */

import type { Source } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

export interface SourceInterner {
  /**
   * Return the canonical {@link Source} (with its turn-stable {@link Source.id})
   * for this source data, minting one on first sight and reusing it thereafter
   * (keyed by `url` ?? `doc:<documentIndex>`). Pass the source WITHOUT an id —
   * the interner assigns it. Use the returned `.id` as a {@link Citation.sourceId}
   * and push the returned `Source` onto the citing block's `sources`.
   */
  intern(source: Omit<Source, "id">): Source;
  /** Every interned source, in first-seen order. */
  all(): readonly Source[];
}

export function createSourceInterner(): SourceInterner {
  const byKey = new Map<string, Source>();
  const order: Source[] = [];
  let seq = 0;

  return {
    intern(source: Omit<Source, "id">): Source {
      const key =
        source.url ??
        (source.documentIndex !== undefined ? `doc:${source.documentIndex}` : undefined);
      if (key !== undefined) {
        const existing = byKey.get(key);
        if (existing) return existing;
      }
      const interned: Source = {
        id: `s${seq++}`,
        ...omitUndefined({
          url: source.url,
          title: source.title,
          documentIndex: source.documentIndex,
        }),
      };
      if (key !== undefined) byKey.set(key, interned);
      order.push(interned);
      return interned;
    },
    all: (): readonly Source[] => order,
  };
}
