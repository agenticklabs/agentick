import type { AdapterDelta } from "@agentick/core/model";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Streaming parser that extracts `<think>...</think>` blocks from text deltas
 * and converts them to reasoning deltas.
 *
 * For OpenAI-compatible servers (LM Studio, ollama) that don't extract
 * reasoning content server-side and instead emit raw think tags in
 * `delta.content`.
 *
 * State machine with two modes:
 * - "text": content outside think tags → emitted as text deltas
 * - "reasoning": content inside think tags → emitted as reasoning deltas
 *
 * Handles tags that span chunk boundaries via an internal buffer.
 */
export class ThinkTagParser {
  private mode: "text" | "reasoning" = "text";
  private buffer = "";

  /**
   * Process an AdapterDelta. Non-text deltas pass through unchanged.
   * Text deltas are parsed for think tags.
   */
  process(delta: AdapterDelta): AdapterDelta[] {
    if (delta.type !== "text") {
      return [delta];
    }
    this.buffer += delta.delta;
    return this.drain();
  }

  /**
   * Flush any remaining buffered content at stream end.
   */
  flush(): AdapterDelta[] {
    if (this.buffer.length === 0) {
      return [];
    }
    // Whatever remains, emit as current mode
    const content = this.buffer;
    this.buffer = "";
    return content ? [this.emit(content)] : [];
  }

  private drain(): AdapterDelta[] {
    const results: AdapterDelta[] = [];

    while (this.buffer.length > 0) {
      const tag = this.mode === "text" ? OPEN_TAG : CLOSE_TAG;
      const tagIndex = this.buffer.indexOf(tag);

      if (tagIndex !== -1) {
        // Found a complete tag
        const before = this.buffer.slice(0, tagIndex);
        if (before) {
          results.push(this.emit(before));
        }
        this.buffer = this.buffer.slice(tagIndex + tag.length);
        this.mode = this.mode === "text" ? "reasoning" : "text";
      } else {
        // No complete tag found — check for partial tag at the end
        const partialLen = this.partialTagLength(tag);
        if (partialLen > 0) {
          // Emit everything before the potential partial tag
          const safe = this.buffer.slice(0, this.buffer.length - partialLen);
          if (safe) {
            results.push(this.emit(safe));
          }
          this.buffer = this.buffer.slice(this.buffer.length - partialLen);
          break;
        } else {
          // No partial tag either — emit everything
          results.push(this.emit(this.buffer));
          this.buffer = "";
        }
      }
    }

    return results;
  }

  /**
   * Check if the end of the buffer is a prefix of the target tag.
   * Returns the length of the partial match, or 0 if none.
   */
  private partialTagLength(tag: string): number {
    // Check decreasing suffix lengths of the buffer against tag prefixes
    const maxCheck = Math.min(this.buffer.length, tag.length - 1);
    for (let len = maxCheck; len > 0; len--) {
      const suffix = this.buffer.slice(this.buffer.length - len);
      if (tag.startsWith(suffix)) {
        return len;
      }
    }
    return 0;
  }

  private emit(content: string): AdapterDelta {
    if (this.mode === "reasoning") {
      return { type: "reasoning", delta: content };
    }
    return { type: "text", delta: content };
  }
}
