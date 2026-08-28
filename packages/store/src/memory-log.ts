/**
 * `MemoryLog<T>` — the generic, `Map`-backed default backing for the **log**
 * store archetype (data-layer plan §2.2). The log-side sibling of
 * {@link MemoryCollection}.
 *
 * The survey's "trivial custom store" criterion, made real for logs: a
 * store-backed *log* harness gets its in-memory default by **parameterizing
 * this one generic** over its entry type `T` — instead of hand-rolling a
 * per-log `{ entries, baseSeq }` window + the `seq` math. It fully backs
 * `MemoryTimelineStore` (`@agentick/timeline`, `T = TimelineEntry`) and is
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
 * @verifiedBy packages/store/src/__tests__/memory-log.spec.ts
 */

import type {
  LogHistoryOptions,
  LogMutation,
  LogQuery,
  LogStore,
  SeqTagged,
  StoreCtx,
} from "@agentick/spec";
import { copyLogPrefix } from "./log-branch.js";

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

  read(logKey: string, _ctx: StoreCtx): Promise<readonly T[]> {
    const rec = this.logs.get(logKey);
    // Defensive copy — callers must not mutate our backing array, and our
    // append must not be visible through a reference the caller retained.
    return Promise.resolve(rec ? [...rec.entries] : []);
  }

  history(
    logKey: string,
    options: LogHistoryOptions | undefined,
    _ctx: StoreCtx,
  ): Promise<readonly SeqTagged<T>[]> {
    const rec = this.logs.get(logKey);
    if (!rec) return Promise.resolve([]);
    const { fromSeq, toSeq, limit } = options ?? {};
    // seq = baseSeq + index, so a seq bound maps to an index by subtracting
    // baseSeq. Both bounds are inclusive; clamp into [0, length].
    const clamp = (i: number): number => Math.max(0, Math.min(i, rec.entries.length));
    let start = clamp((fromSeq ?? rec.baseSeq) - rec.baseSeq);
    let end = toSeq !== undefined ? clamp(toSeq - rec.baseSeq + 1) : rec.entries.length;
    if (end < start) end = start;
    if (limit !== undefined) {
      // The anchor rule: `fromSeq` present ⇒ truncate at the far end (forward);
      // absent ⇒ truncate at the near end (backward — the last `limit`).
      if (fromSeq !== undefined) end = Math.min(start + limit, end);
      else start = Math.max(end - limit, start);
    }
    const out: SeqTagged<T>[] = [];
    for (let i = start; i < end; i++) {
      out.push({ seq: rec.baseSeq + i, entry: rec.entries[i]! });
    }
    return Promise.resolve(out);
  }

  branch(
    source: string,
    target: string,
    opts: { readonly toSeq?: number },
    ctx: StoreCtx,
  ): Promise<void> {
    return copyLogPrefix(this, source, target, opts, ctx);
  }

  append(logKey: string, entries: readonly T[], _ctx: StoreCtx): Promise<readonly number[]> {
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

  keys(_ctx: StoreCtx): Promise<readonly string[]> {
    // Only logs that currently hold entries — a pruned-empty log retains its
    // `seq` counter but has nothing to enumerate.
    const held: string[] = [];
    for (const [id, rec] of this.logs) {
      if (rec.entries.length > 0) held.push(id);
    }
    return Promise.resolve(held);
  }

  delete(logKey: string, _ctx: StoreCtx): Promise<boolean> {
    return Promise.resolve(this.logs.delete(logKey));
  }

  prune(logKey: string, before: { seq: number }, _ctx: StoreCtx): Promise<number> {
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

  // ─────────── Store seam (query / mutate over the log window) ───────────

  /**
   * The seam READ — a projection of a log window shaped by a {@link LogQuery}.
   * `{ logKey }` alone projects the whole log; `fromSeq` / `toSeq` / `limit`
   * project a cursored window (`{ limit: n }` the log's last `n` — the anchor
   * rule). Delegates to {@link history} and drops the `seq` tags (the seam
   * returns bare entries). An `undefined` query identifies no log → `[]`.
   */
  async query(q: LogQuery | undefined, ctx: StoreCtx): Promise<readonly T[]> {
    if (q === undefined) return [];
    const { logKey, ...window } = q;
    const tagged = await this.history(logKey, window, ctx);
    return tagged.map((t) => t.entry);
  }

  /**
   * The seam WRITE — the single append mutation ({@link LogMutation}). Delegates
   * to {@link append}, discarding the assigned seqs to satisfy the
   * `Promise<void>` seam.
   */
  async mutate(m: LogMutation<T>, ctx: StoreCtx): Promise<void> {
    await this.append(m.append.logKey, m.append.entries, ctx);
  }
}
