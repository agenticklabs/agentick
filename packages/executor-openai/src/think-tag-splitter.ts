/**
 * Streaming text splitter for inline `<think>...</think>` tags.
 *
 * OpenAI-compatible servers that don't extract reasoning server-side
 * (LM Studio, ollama, some local quantized models) emit chain-of-thought
 * as literal `<think>...</think>` blocks inside `delta.content`. This
 * splitter consumes a streaming string and partitions it into
 * `text` segments (outside think tags) and `reasoning` segments
 * (inside think tags), buffering across chunks when a tag spans a
 * boundary.
 *
 * It is provider-agnostic — a pure text-stream transform — so it
 * can be wired into any provider adapter that needs the same
 * behavior. v2 adapters that natively expose reasoning via
 * non-standard fields (vLLM `reasoning_content`, LM Studio
 * `reasoning`) DON'T need this parser; the adapter consumes those
 * fields directly. This parser is for adopters whose server emits
 * raw tags in the content channel.
 *
 * Ported from v1 `@agentick/openai/think-tag-parser`, restructured
 * as a pure splitter so v2's AdapterDelta block-index machinery
 * stays in the executor (see `mapChunkToAdapterDeltas` for how the
 * segments translate to content-delta / reasoning-delta events).
 */

export type ThinkSegmentMode = "text" | "reasoning";

export interface ThinkSegment {
  readonly mode: ThinkSegmentMode;
  readonly content: string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * State machine that buffers across chunk boundaries to detect tags
 * that arrive split across two or more provider chunks. After
 * `feed()`, call `flush()` at stream end to drain any remaining
 * buffered content (assumed to be in whichever mode the state
 * machine landed in).
 */
export class ThinkTagSplitter {
  private mode: ThinkSegmentMode = "text";
  private buffer = "";

  feed(chunk: string): ThinkSegment[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    return this.drain();
  }

  flush(): ThinkSegment[] {
    if (this.buffer.length === 0) return [];
    const seg: ThinkSegment = { mode: this.mode, content: this.buffer };
    this.buffer = "";
    return [seg];
  }

  private drain(): ThinkSegment[] {
    const out: ThinkSegment[] = [];
    while (this.buffer.length > 0) {
      const tag = this.mode === "text" ? OPEN_TAG : CLOSE_TAG;
      const idx = this.buffer.indexOf(tag);
      if (idx !== -1) {
        const before = this.buffer.slice(0, idx);
        if (before.length > 0) {
          out.push({ mode: this.mode, content: before });
        }
        this.buffer = this.buffer.slice(idx + tag.length);
        this.mode = this.mode === "text" ? "reasoning" : "text";
        continue;
      }
      // No complete tag in the buffer — check whether the buffer ends
      // with a prefix of the target tag (split-tag-across-chunks case).
      const partial = this.partialTagSuffixLength(tag);
      if (partial > 0) {
        const safeLen = this.buffer.length - partial;
        if (safeLen > 0) {
          out.push({ mode: this.mode, content: this.buffer.slice(0, safeLen) });
        }
        this.buffer = this.buffer.slice(safeLen);
        break;
      }
      // No tag, no partial — flush the rest in the current mode.
      out.push({ mode: this.mode, content: this.buffer });
      this.buffer = "";
    }
    return out;
  }

  /**
   * Returns the length of the longest suffix of the buffer that is
   * also a prefix of `tag`. Used to defer emission when a tag may be
   * split across the chunk boundary. Returns 0 if no overlap exists.
   */
  private partialTagSuffixLength(tag: string): number {
    const max = Math.min(this.buffer.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      const suffix = this.buffer.slice(this.buffer.length - len);
      if (tag.startsWith(suffix)) return len;
    }
    return 0;
  }
}

/**
 * One-shot helper for non-streaming text. Convenience around the
 * splitter for normalize() paths that receive the complete content.
 */
export function splitThinkTags(input: string): ThinkSegment[] {
  const s = new ThinkTagSplitter();
  return [...s.feed(input), ...s.flush()];
}
