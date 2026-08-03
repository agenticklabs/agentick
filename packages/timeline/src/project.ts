/**
 * The projection, derived from the log alone.
 *
 * The timeline is an append-only log paired with a materialized view, and that
 * choice has one non-negotiable consequence: **the projection must be a pure
 * function of the log.** If rebuilding it needs state kept elsewhere, there is
 * no materialized view — there is a log and a database, and they can disagree.
 *
 * A compaction event records the range it stands in for, so this fold needs no
 * cursor, no side table, and no store call: walk the log, substitute each
 * summary at the point its range STARTS, and drop what the range covers. The
 * summary's own position records when it was written; its range records what it
 * replaces, and those are different facts.
 */

import type { TimelineEntry } from "@agentick/spec";

export interface CompactionCoverage {
  readonly summary: TimelineEntry;
  readonly coversFrom: string;
  readonly coversThrough: string;
}

const compactionData = (entry: TimelineEntry): Record<string, unknown> | undefined => {
  if (entry.kind !== "message" || entry.message.role !== "event") return undefined;
  for (const block of entry.message.content) {
    if (block.type === "system_event" && block.event === "compaction") return block.data;
  }
  return undefined;
};

const idOf = (entry: TimelineEntry): string | undefined =>
  entry.kind === "message" ? entry.message.id : undefined;

/** Compaction events that declare a range. One without a range covers nothing. */
export function coverageIn(entries: readonly TimelineEntry[]): readonly CompactionCoverage[] {
  const out: CompactionCoverage[] = [];
  for (const summary of entries) {
    const data = compactionData(summary);
    const coversFrom = data?.["coversFrom"];
    const coversThrough = data?.["coversThrough"];
    if (typeof coversFrom === "string" && typeof coversThrough === "string") {
      out.push({ summary, coversFrom, coversThrough });
    }
  }
  return out;
}

/**
 * Fold a durable log into what the model sees.
 *
 * Idempotent: folding an already-folded projection returns it unchanged, since
 * a summary whose covered entries are absent simply substitutes nothing.
 */
export function projectLog(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  const coverage = coverageIn(entries);
  if (coverage.length === 0) return entries;

  const position = new Map<string, number>();
  entries.forEach((entry, i) => {
    const id = idOf(entry);
    if (id !== undefined) position.set(id, i);
  });

  const resolved = coverage
    .map(({ summary, coversFrom, coversThrough }) => ({
      summary,
      from: position.get(coversFrom),
      to: position.get(coversThrough),
    }))
    .filter((r): r is { summary: TimelineEntry; from: number; to: number } => {
      return r.from !== undefined && r.to !== undefined && r.to >= r.from;
    })
    // Widest first, so an outer range claims the slot and the ranges nested
    // inside it stay hidden. Narrowest-first would substitute the inner summary
    // and silently drop everything the outer one covered beyond it.
    .sort((a, b) => b.to - b.from - (a.to - a.from));

  const claimedAt = new Map<number, TimelineEntry>();
  const covered = new Set<number>();
  const placed = new Set<TimelineEntry>();
  for (const { summary, from, to } of resolved) {
    if (covered.has(from)) {
      placed.add(summary); // nested — the outer summary already speaks for it
      continue;
    }
    claimedAt.set(from, summary);
    placed.add(summary);
    for (let i = from; i <= to; i++) covered.add(i);
  }

  const out: TimelineEntry[] = [];
  entries.forEach((entry, i) => {
    const claimed = claimedAt.get(i);
    if (claimed !== undefined) out.push(claimed);
    if (covered.has(i)) return;
    // A placed summary was already emitted at its range (or is hidden inside a
    // wider one). One whose range no longer resolves stays where it is — a fold
    // that dropped it would lose the conversation it stands for.
    if (placed.has(entry)) return;
    out.push(entry);
  });
  return out;
}
