/**
 * `fsTimelineStore` — zero-dependency JSONL {@link TimelineStore} adapter
 * (ADR 49, "stores, not snapshots"; reference-adapter rung 2, the
 * local-pole durable shape).
 *
 * One **append-only JSONL file per session**, `<dir>/<encoded-id>.jsonl`,
 * where each line is:
 *
 * ```json
 * { "seq": 7, "entry": { ...TimelineEntry } }
 * ```
 *
 * Storing `seq` explicitly per line makes the ordering identity durable in
 * the file and survivable across `prune` — a restarting process re-seeds
 * its cursor from the max `seq` present, so survivors keep their `seq` and
 * a later append never reuses one. The file is human-greppable: `jq` over
 * the lines gives you the whole transcript.
 *
 * ## `seq` bookkeeping (mirrors {@link MemoryTimelineStore})
 *
 *   - An in-memory per-session `nextSeq` cursor is the source of assignment
 *     while the process holds the session. The harness guarantees a single
 *     writer per session (the execution lease), so the cursor is safe.
 *   - The cursor is **seeded lazily from the file on first touch** — max
 *     line `seq` + 1, or 0 for an unseen session. This makes `seq`
 *     monotonic across process restarts as long as at least one line
 *     survives.
 *   - `prune` rewrites the file keeping only `seq >= before.seq`; it does
 *     **not** touch the cursor, so survivors keep their `seq` and the next
 *     append continues past the high-water mark.
 *   - `delete` removes the file **and** the cursor — the session ends, so a
 *     subsequent append starts a fresh `seq` sequence from 0.
 *
 * **Prune-to-empty is restart-durable via a high-water-mark sidecar.**
 * When `prune` erases every line, the `.jsonl` has no line to re-seed the
 * cursor from — so `prune` also writes the high-water mark (next `seq`) to a
 * sibling `<encoded-id>.hwm` file (an integer only — NO entry data, so
 * erasure stays GDPR-clean). The (now-empty) `.jsonl` is **retained** so
 * `delete` still reports the session as present (matching
 * {@link MemoryTimelineStore}, whose record persists after a prune-to-empty)
 * and `keys()` still excludes it by size. On restart, `seed` falls back
 * to the sidecar, so a later append continues past the erased seqs and never
 * reuses one — honoring the frozen contract's "never reused across `prune`"
 * clause even across a process restart. (Normal seeding still reads the
 * `.jsonl`'s max seq; the sidecar only matters once the log is empty.)
 *
 * ## Path safety
 *
 * The filename is `base64url(sessionId) + ".jsonl"`. base64url emits only
 * `[A-Za-z0-9_-]`, so a session id can never escape `dir` — path traversal
 * (`../`, absolute paths, NUL bytes) is *structurally* impossible, not
 * merely validated against. `keys()` decodes the names back.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  LogHistoryOptions,
  LogMutation,
  LogQuery,
  SeqTagged,
  StoreCtx,
  TimelineEntry,
  TimelineStore,
} from "@agentick/timeline";

export interface FsTimelineStoreOptions {
  /**
   * Directory the per-session JSONL files live in. Created lazily
   * (`mkdir -p`) on first write. Reads against a missing directory
   * resolve empty rather than throwing.
   */
  readonly dir: string;
}

/** JSONL line shape — `seq` is durable in the file alongside the entry. */
interface Line {
  readonly seq: number;
  readonly entry: TimelineEntry;
}

const EXT = ".jsonl";

/** Sidecar holding ONLY the integer high-water mark (nextSeq). Contains no
 *  entry payloads, so it is GDPR-clean; it survives `prune`-to-empty so the
 *  `seq` counter is durable across a process restart. */
const HWM_EXT = ".hwm";

/** base64url encoding of the session id (closed over `[A-Za-z0-9_-]`). */
const encodeId = (sessionId: string): string =>
  Buffer.from(sessionId, "utf8").toString("base64url");

/** `sessionId` → transcript filename. base64url can never contain a path
 *  separator or `..`, so a session id can't escape `dir` — traversal-proof. */
const fileName = (sessionId: string): string => `${encodeId(sessionId)}${EXT}`;

/** Inverse of {@link fileName}; `undefined` for names we didn't write (incl.
 *  the `.hwm` sidecars, so `keys()` never enumerates them). */
function decodeName(name: string): string | undefined {
  if (!name.endsWith(EXT)) return undefined;
  return Buffer.from(name.slice(0, -EXT.length), "base64url").toString("utf8");
}

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";

class FsTimelineStore implements TimelineStore {
  readonly backend = "fs" as const;

  private readonly dir: string;

  /** Per-session `seq` cursor — the seq the next appended entry receives.
   *  Seeded lazily from the file (see {@link seed}). */
  private readonly nextSeq = new Map<string, number>();

  /** Per-session serialization: chains operations so cursor-seeding and
   *  append are atomic even under concurrent calls (defence in depth over
   *  the harness's single-writer lease). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: FsTimelineStoreOptions) {
    this.dir = options.dir;
  }

  private path(sessionId: string): string {
    return join(this.dir, fileName(sessionId));
  }

  private hwmPath(sessionId: string): string {
    return join(this.dir, `${encodeId(sessionId)}${HWM_EXT}`);
  }

  /** Read the persisted high-water mark, if any. `undefined` when absent. */
  private async readHwm(sessionId: string): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.hwmPath(sessionId), "utf8");
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw e;
    }
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isNaN(n) ? undefined : n;
  }

  /** Persist the high-water mark so `seq` survives `prune`-to-empty across a
   *  restart. Holds only the integer — never any entry payload. */
  private async writeHwm(sessionId: string, nextSeq: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.hwmPath(sessionId), String(nextSeq), "utf8");
  }

  /** Run `fn` after any in-flight op for `sessionId` — a per-session mutex. */
  private lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep the chain alive but swallow the settled value so a rejection in
    // one op doesn't poison the next waiter's `.then`.
    this.locks.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Parse a session's file into ordered lines. Missing file → []. */
  private async readLines(sessionId: string): Promise<Line[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const lines: Line[] = [];
    for (const text of raw.split("\n")) {
      if (text.length === 0) continue;
      lines.push(JSON.parse(text) as Line);
    }
    // Written in seq order, but sort defensively so callers get seq order
    // regardless of how the file was produced.
    lines.sort((a, b) => a.seq - b.seq);
    return lines;
  }

  /**
   * Ensure `nextSeq` for `sessionId` is seeded. Precedence:
   *   1. the in-memory cursor (already seeded this process);
   *   2. the transcript's max line `seq` + 1 (the normal case);
   *   3. the `.hwm` sidecar — survives `prune`-to-empty across a restart;
   *   4. 0 for a truly unseen session.
   */
  private async seed(sessionId: string): Promise<number> {
    const cached = this.nextSeq.get(sessionId);
    if (cached !== undefined) return cached;
    const lines = await this.readLines(sessionId);
    const next =
      lines.length > 0 ? lines[lines.length - 1]!.seq + 1 : ((await this.readHwm(sessionId)) ?? 0);
    this.nextSeq.set(sessionId, next);
    return next;
  }

  read(sessionId: string, _ctx: StoreCtx): Promise<readonly TimelineEntry[]> {
    return this.lock(sessionId, async () => {
      const lines = await this.readLines(sessionId);
      // Fresh parse per call → inherently a defensive copy.
      return lines.map((l) => l.entry);
    });
  }

  history(
    sessionId: string,
    options: LogHistoryOptions | undefined,
    _ctx: StoreCtx,
  ): Promise<readonly SeqTagged<TimelineEntry>[]> {
    return this.lock(sessionId, async () => {
      const lines = await this.readLines(sessionId);
      const { fromSeq, toSeq, limit } = options ?? {};
      const matched = lines.filter(
        (l) =>
          (fromSeq === undefined || l.seq >= fromSeq) && (toSeq === undefined || l.seq <= toSeq),
      );
      // The anchor rule: `fromSeq` present ⇒ the FIRST `limit` (forward);
      // absent ⇒ the LAST `limit` (backward). Order stays ascending either way.
      const limited =
        limit === undefined
          ? matched
          : fromSeq !== undefined
            ? matched.slice(0, limit)
            : matched.slice(Math.max(matched.length - limit, 0));
      return limited.map((l): SeqTagged<TimelineEntry> => ({ seq: l.seq, entry: l.entry }));
    });
  }

  append(
    sessionId: string,
    entries: readonly TimelineEntry[],
    _ctx: StoreCtx,
  ): Promise<readonly number[]> {
    return this.lock(sessionId, async () => {
      if (entries.length === 0) return [];
      const start = await this.seed(sessionId);
      const seqs = entries.map((_, i) => start + i);
      const payload =
        entries
          .map((entry, i) => JSON.stringify({ seq: seqs[i]!, entry } satisfies Line))
          .join("\n") + "\n";
      await mkdir(this.dir, { recursive: true });
      // One syscall for the whole batch (the write-behind pump hands us N).
      await appendFile(this.path(sessionId), payload, "utf8");
      this.nextSeq.set(sessionId, start + entries.length);
      return seqs;
    });
  }

  keys(_ctx: StoreCtx): Promise<readonly string[]> {
    return this.lock("\x00sessions", async () => {
      let names: string[];
      try {
        names = await readdir(this.dir);
      } catch (e) {
        if (isEnoent(e)) return [];
        throw e;
      }
      const held: string[] = [];
      for (const name of names) {
        const id = decodeName(name);
        if (id === undefined) continue;
        // A file that exists but holds no lines (pruned-empty) is not
        // enumerated — matches MemoryTimelineStore.keys(). Size 0 ⟺ no
        // lines, since we only ever write whole `<json>\n` records.
        const info = await stat(join(this.dir, name)).catch(() => undefined);
        if (info && info.size > 0) held.push(id);
      }
      return held;
    });
  }

  delete(sessionId: string, _ctx: StoreCtx): Promise<boolean> {
    return this.lock(sessionId, async () => {
      // The session ends — drop the cursor AND the hwm sidecar so a later
      // append starts a fresh seq sequence from 0.
      this.nextSeq.delete(sessionId);
      // Sidecar removal is best-effort; it may not exist.
      await rm(this.hwmPath(sessionId)).catch((e) => {
        if (!isEnoent(e)) throw e;
      });
      try {
        await rm(this.path(sessionId));
        return true;
      } catch (e) {
        if (isEnoent(e)) return false;
        throw e;
      }
    });
  }

  prune(sessionId: string, before: { seq: number }, _ctx: StoreCtx): Promise<number> {
    return this.lock(sessionId, async () => {
      // Seed the cursor first so the persisted hwm reflects the true
      // high-water mark even when we erase every line.
      const nextSeq = await this.seed(sessionId);
      const lines = await this.readLines(sessionId);
      if (lines.length === 0) return 0;
      const survivors = lines.filter((l) => l.seq >= before.seq);
      const removed = lines.length - survivors.length;
      if (removed === 0) return 0;
      // Rewrite the transcript with survivors only (empty file if none). The
      // cursor is untouched: survivors keep their seq and the next append
      // continues past the high-water mark, never reusing an erased seq.
      const payload =
        survivors.length === 0 ? "" : survivors.map((l) => JSON.stringify(l)).join("\n") + "\n";
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path(sessionId), payload, "utf8");
      // Persist the hwm so the counter survives prune-to-empty across a
      // restart (the empty transcript has no line to re-seed from). Holds
      // only the integer — no entry payload, so it stays GDPR-clean.
      await this.writeHwm(sessionId, nextSeq);
      return removed;
    });
  }

  // ── Store seam — required now `LogStore extends Store`. `query` projects a log
  // window (JSONL read/slice via {@link history}, `seq` tags dropped); `mutate`
  // appends. `logKey` is the `sessionId`.
  async query(q: LogQuery | undefined, ctx: StoreCtx): Promise<readonly TimelineEntry[]> {
    if (q === undefined) return [];
    const { logKey, ...window } = q;
    const tagged = await this.history(logKey, window, ctx);
    return tagged.map((t) => t.entry);
  }

  async mutate(m: LogMutation<TimelineEntry>, ctx: StoreCtx): Promise<void> {
    await this.append(m.append.logKey, m.append.entries, ctx);
  }
}

/**
 * Construct a JSONL-file-backed {@link TimelineStore}. One append-only
 * transcript file per session under `dir`. Zero third-party dependencies —
 * Node built-ins only.
 */
export function fsTimelineStore(options: FsTimelineStoreOptions): TimelineStore {
  return new FsTimelineStore(options);
}
