/**
 * ChatJimmy answers with the completion text followed by one
 * `<|stats|>{…}<|/stats|>` trailer. The trailer is the only structured part
 * of the response — the usage and stop reason live in it.
 */

export const STATS_OPEN = "<|stats|>";
export const STATS_CLOSE = "<|/stats|>";

export type StatsTrailer = Readonly<Record<string, unknown>>;

export interface TrailerSplit {
  readonly text: string;
  readonly stats?: StatsTrailer;
}

export function splitStatsTrailer(body: string): TrailerSplit {
  const splitter = new StatsTrailerSplitter();
  const first = splitter.push(body);
  const text = first.text + splitter.flush();
  return first.stats === undefined ? { text } : { text, stats: first.stats };
}

/**
 * Incremental form of {@link splitStatsTrailer}. Text that could be the
 * start of `<|stats|>` is held back until the next chunk settles it, so a
 * marker split across two chunks is still recognized and a stray `<` is
 * still delivered.
 */
export class StatsTrailerSplitter {
  private pending = "";
  private trailer: string | undefined;
  private parsed: StatsTrailer | undefined;

  push(chunk: string): TrailerSplit {
    if (this.trailer !== undefined) {
      this.trailer += chunk;
      return { text: "", ...this.tryCloseTrailer() };
    }
    this.pending += chunk;
    const open = this.pending.indexOf(STATS_OPEN);
    if (open >= 0) {
      const text = this.pending.slice(0, open);
      this.trailer = this.pending.slice(open + STATS_OPEN.length);
      this.pending = "";
      return { text, ...this.tryCloseTrailer() };
    }
    const held = markerPrefixLength(this.pending);
    const text = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    return { text };
  }

  /** Text still held back once the stream ends — real text, not a marker. */
  flush(): string {
    if (this.trailer !== undefined) return "";
    const text = this.pending;
    this.pending = "";
    return text;
  }

  get stats(): StatsTrailer | undefined {
    return this.parsed;
  }

  private tryCloseTrailer(): { stats?: StatsTrailer } {
    if (this.parsed !== undefined || this.trailer === undefined) return {};
    const close = this.trailer.indexOf(STATS_CLOSE);
    if (close < 0) return {};
    this.parsed = parseStats(this.trailer.slice(0, close));
    return this.parsed === undefined ? {} : { stats: this.parsed };
  }
}

function markerPrefixLength(text: string): number {
  const max = Math.min(text.length, STATS_OPEN.length - 1);
  for (let len = max; len > 0; len--) {
    if (STATS_OPEN.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

function parseStats(json: string): StatsTrailer | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as StatsTrailer) : undefined;
  } catch {
    return undefined;
  }
}
