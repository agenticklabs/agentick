/**
 * `MemoryLog<T>` — the generic, `Map`-backed default backing for the **log**
 * store archetype (data-layer plan §2.2). The log-side sibling of
 * {@link MemoryCollection}.
 *
 * The survey's "trivial custom store" criterion, made real for logs: a
 * store-backed *log* harness gets its in-memory default by **parameterizing
 * this one generic** over its entry type `T` — instead of hand-rolling a
 * per-log `{ entries, baseSeq }` window + the `seq` math. It fully backs
 * `MemoryTimelineStore` (`@agentick/timeline-next`, `T = TimelineEntry`) and is
 * the target for any future event-sourced entry log.
 *
 * Implements {@link LogStore} so shape drift breaks the build. `:memory:`
 * semantics — state is lost on process exit; a durable adapter (JSONL, SQLite,
 * Postgres, …) conforms to the same port with its own storage.
 *
 * ## Opinion-free by design (data-layer plan §2.7)
 *
 * A **full in-memory array per log is the intended default** — there is NO
 * bounding / eviction / window here. "How much of the log lives in RAM" is a
 * *durable adapter's* concern, not a framework mandate: the framework contract
 * is append + cursored read + ordering, nothing more. The one thing this holds
 * is the append-only log itself; a consuming harness holds its own bounded
 * projection separately.
 *
 * ## `seq` — the frozen ordering identity
 *
 * `seq` is tracked as `baseSeq + index`: each log holds a contiguous window of
 * its history, and `baseSeq` (the absolute `seq` of the first live entry)
 * advances on {@link prune} so survivors keep their `seq` and the next append
 * never reuses one. This is the reference the conformance suite validates every
 * adapter against.
 *
 * @see docs/proposals/v2/data-layer-plan.md §2.2, §2.7
 * @verifiedBy packages-next/store/src/__tests__/memory-log.spec.ts
 */

import type { LogStore, SeqTagged } from "@agentick/spec-next";

/** Per-log record: the live entries plus the `seq` of `entries[0]`. */
interface LogWindow<T> {
  entries: T[];
  /** Absolute `seq` of `entries[0]`. Advances as leading entries are pruned. */
  baseSeq: number;
}

/**
 * The per-store parameterization. The only store-specific knob for a log is its
 * `backend` label — the log's mechanics (append→seq, cursored read, defensive
 * copy, prune-by-absolute-seq, empty-log enumerate filter) are the generic's
 * and payload-agnostic over `T`.
 */
export interface MemoryLogConfig {
  /** Self-identifying backend label. Defaults to `"memory"`. */
  readonly backend?: string;
}

export class MemoryLog<T> implements LogStore<T> {
  readonly backend: string;
  private readonly logs = new Map<string, LogWindow<T>>();

  constructor(config: MemoryLogConfig = {}) {
    this.backend = config.backend ?? "memory";
  }

  read(logKey: string): Promise<readonly T[]> {
    const rec = this.logs.get(logKey);
    // Defensive copy — callers must not mutate our backing array, and our
    // append must not be visible through a reference the caller retained.
    return Promise.resolve(rec ? [...rec.entries] : []);
  }

  history(
    logKey: string,
    options?: { readonly fromSeq?: number; readonly limit?: number },
  ): Promise<readonly SeqTagged<T>[]> {
    const rec = this.logs.get(logKey);
    if (!rec) return Promise.resolve([]);
    const fromSeq = options?.fromSeq ?? 0;
    // seq = baseSeq + index; slice from the first index at/after fromSeq.
    const start = Math.max(fromSeq - rec.baseSeq, 0);
    const end =
      options?.limit !== undefined
        ? Math.min(start + options.limit, rec.entries.length)
        : rec.entries.length;
    const out: SeqTagged<T>[] = [];
    for (let i = start; i < end; i++) {
      out.push({ seq: rec.baseSeq + i, entry: rec.entries[i]! });
    }
    return Promise.resolve(out);
  }

  append(logKey: string, entries: readonly T[]): Promise<readonly number[]> {
    if (entries.length === 0) return Promise.resolve([]);
    let rec = this.logs.get(logKey);
    if (!rec) {
      rec = { entries: [], baseSeq: 0 };
      this.logs.set(logKey, rec);
    }
    // nextSeq = baseSeq + entries.length (the seq the first new entry gets).
    const start = rec.baseSeq + rec.entries.length;
    rec.entries.push(...entries);
    return Promise.resolve(entries.map((_, i) => start + i));
  }

  keys(): Promise<readonly string[]> {
    // Only logs that currently hold entries — a pruned-empty log retains its
    // `seq` counter but has nothing to enumerate.
    const held: string[] = [];
    for (const [id, rec] of this.logs) {
      if (rec.entries.length > 0) held.push(id);
    }
    return Promise.resolve(held);
  }

  delete(logKey: string): Promise<boolean> {
    return Promise.resolve(this.logs.delete(logKey));
  }

  prune(logKey: string, before: { seq: number }): Promise<number> {
    const rec = this.logs.get(logKey);
    if (!rec) return Promise.resolve(0);
    // Erase entries with absolute seq < before.seq. entries[i] has absolute
    // seq baseSeq + i, so cut = clamp(before.seq - baseSeq, 0, length).
    const cut = Math.max(0, Math.min(before.seq - rec.baseSeq, rec.entries.length));
    if (cut === 0) return Promise.resolve(0);
    rec.entries.splice(0, cut);
    // Advance baseSeq so survivors keep their absolute seq and the next append
    // continues monotonically. The record is retained even when now empty — the
    // log lives; only `delete` ends the seq sequence.
    rec.baseSeq += cut;
    return Promise.resolve(cut);
  }
}
