/**
 * Streaming XML-tag parser — the shared primitive that powers both
 * `customBlocks` (adopter-declared structured tags) and the
 * `parseThinkTags` preset (provider-quirk compensation for inline
 * `<think>...</think>`).
 *
 * Ported from v1 `packages/core/src/model/stream-tag-parser.ts` and
 * adapted to a v2-shaped event interface: emits plain TypeScript
 * discriminated-union events that the caller translates into proper
 * `AdapterDelta` values (text → `content-delta`; tag content →
 * `custom-block-*` or, for the think-tag preset, `reasoning-*`).
 *
 * State machine intercepts ONLY registered tag names. Unregistered
 * markup passes through as text. Handles:
 *   - attributes (`<citation source="wiki" year=2025>`)
 *   - self-closing tags (`<done/>`)
 *   - tags split across chunk boundaries
 *   - non-matching close tags emitted as content
 *   - partial tag at stream end → flush as best-effort text/content
 *
 * Pure utility. No `AdapterDelta` dependency — the executor wraps
 * emission to convert these events into provider-appropriate deltas.
 */

export interface StreamTagHandler {
  /** Called when the opening tag is found, before content arrives. */
  onStart?(attrs: Readonly<Record<string, string>>): void;
  /** Called with accumulated content when closing tag is found. */
  onContent?(content: string, attrs: Readonly<Record<string, string>>): void;
  /** Called for self-closing tags (e.g., `<done/>`). */
  onSelfClosing?(attrs: Readonly<Record<string, string>>): void;
}

export interface StreamTagParserConfig {
  /** Map of tag names to handlers. Only registered tags are intercepted. */
  readonly tags: Readonly<Record<string, StreamTagHandler>>;
}

/**
 * Events emitted from the parser. `text` segments are normal stream
 * content (caller should emit as `content-delta`). `block-*` events
 * are extracted tag content (caller translates to `custom-block-*`
 * or `reasoning-*` depending on context).
 */
export type StreamTagEvent =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "block-start";
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
    }
  | { readonly type: "block-delta"; readonly tag: string; readonly delta: string }
  | { readonly type: "block-end"; readonly tag: string }
  | {
      readonly type: "block";
      readonly tag: string;
      readonly content: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly selfClosing?: boolean;
    };

const enum State {
  TEXT,
  OPEN_ANGLE,
  ATTRS,
  CONTENT,
  CONTENT_OPEN_ANGLE,
  CONTENT_CLOSE_SLASH,
  CLOSE_TAG_NAME,
  CLOSE_TAG_END,
}

export class StreamTagParser {
  private readonly tags: Map<string, StreamTagHandler>;
  private readonly tagNames: Set<string>;

  private state = State.TEXT;

  private textBuf = "";
  private nameBuf = "";
  private attrBuf = "";

  private activeTag = "";
  private activeAttrs: Record<string, string> = {};
  private contentBuf = "";

  private closeNameBuf = "";

  /** Batches block-delta chars within a single process() call. */
  private pendingContentDelta = "";
  private pendingContentTag = "";

  private output: StreamTagEvent[] = [];

  constructor(config: StreamTagParserConfig) {
    this.tags = new Map(Object.entries(config.tags));
    this.tagNames = new Set(this.tags.keys());
  }

  /**
   * Feed a chunk of text. Returns ordered events: `text` for content
   * outside registered tags, `block-*` for tag boundaries and tag
   * content. The caller arranges these into the executor's
   * `AdapterDelta` stream.
   */
  process(chunk: string): StreamTagEvent[] {
    if (chunk.length === 0) return [];
    this.output = [];
    for (let i = 0; i < chunk.length; i++) {
      this.feed(chunk[i]!);
    }
    this.flushText();
    this.flushContentDelta();
    const result = this.output;
    this.output = [];
    return result;
  }

  /**
   * Drain remaining buffered content at stream end. Incomplete tag
   * states emit best-effort content rather than dropping bytes.
   */
  flush(): StreamTagEvent[] {
    this.output = [];

    switch (this.state) {
      case State.TEXT:
        this.flushText();
        break;
      case State.OPEN_ANGLE:
        this.textBuf += "<" + this.nameBuf;
        this.nameBuf = "";
        this.flushText();
        this.state = State.TEXT;
        break;
      case State.ATTRS:
        this.textBuf += "<" + this.activeTag + " " + this.attrBuf;
        this.attrBuf = "";
        this.resetActive();
        this.flushText();
        this.state = State.TEXT;
        break;
      case State.CONTENT:
      case State.CONTENT_OPEN_ANGLE:
      case State.CONTENT_CLOSE_SLASH:
      case State.CLOSE_TAG_NAME:
      case State.CLOSE_TAG_END: {
        let content = this.contentBuf;
        if (this.state === State.CONTENT_OPEN_ANGLE) content += "<";
        if (this.state === State.CONTENT_CLOSE_SLASH) content += "</";
        if (this.state === State.CLOSE_TAG_NAME) content += "</" + this.closeNameBuf;
        if (this.state === State.CLOSE_TAG_END) content += "</" + this.closeNameBuf;

        if (content.length > 0 || this.activeTag.length > 0) {
          this.emitBlock(this.activeTag, content, this.activeAttrs);
          this.callHandler(this.activeTag, content, this.activeAttrs);
        }
        this.closeNameBuf = "";
        this.resetActive();
        this.state = State.TEXT;
        break;
      }
    }

    const result = this.output;
    this.output = [];
    return result;
  }

  private feed(ch: string): void {
    switch (this.state) {
      case State.TEXT:
        if (ch === "<") {
          this.state = State.OPEN_ANGLE;
          this.nameBuf = "";
        } else {
          this.textBuf += ch;
        }
        break;

      case State.OPEN_ANGLE:
        if (isNameStartChar(ch)) {
          this.nameBuf += ch;
        } else if (this.nameBuf.length > 0 && isNameContinueChar(ch)) {
          this.nameBuf += ch;
        } else if (
          this.nameBuf.length > 0 &&
          (ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r")
        ) {
          if (this.tagNames.has(this.nameBuf)) {
            this.flushText();
            this.activeTag = this.nameBuf;
            this.activeAttrs = {};
            this.nameBuf = "";

            if (ch === ">") {
              this.contentBuf = "";
              this.emitBlockStart(this.activeTag, {});
              this.tags.get(this.activeTag)?.onStart?.({});
              this.state = State.CONTENT;
            } else if (ch === "/") {
              this.attrBuf = "/";
              this.state = State.ATTRS;
            } else {
              this.attrBuf = "";
              this.state = State.ATTRS;
            }
          } else {
            this.textBuf += "<" + this.nameBuf + ch;
            this.nameBuf = "";
            this.state = State.TEXT;
          }
        } else if (this.nameBuf.length === 0) {
          if (ch === "/") {
            this.textBuf += "</";
          } else {
            this.textBuf += "<" + ch;
          }
          this.state = State.TEXT;
        } else {
          this.textBuf += "<" + this.nameBuf + ch;
          this.nameBuf = "";
          this.state = State.TEXT;
        }
        break;

      case State.ATTRS: {
        this.attrBuf += ch;
        if (ch === ">") {
          const trimmed = this.attrBuf.trimEnd();
          if (trimmed.endsWith("/>")) {
            const attrStr = trimmed.slice(0, -2);
            const attrs = parseAttributes(attrStr);
            this.activeAttrs = attrs;
            this.emitBlock(this.activeTag, "", this.activeAttrs, true);
            this.tags.get(this.activeTag)?.onSelfClosing?.(this.activeAttrs);
            this.attrBuf = "";
            this.resetActive();
            this.state = State.TEXT;
          } else {
            const attrStr = this.attrBuf.slice(0, -1);
            this.activeAttrs = parseAttributes(attrStr);
            this.contentBuf = "";
            this.emitBlockStart(this.activeTag, this.activeAttrs);
            this.tags.get(this.activeTag)?.onStart?.(this.activeAttrs);
            this.attrBuf = "";
            this.state = State.CONTENT;
          }
        }
        break;
      }

      case State.CONTENT:
        if (ch === "<") {
          this.state = State.CONTENT_OPEN_ANGLE;
        } else {
          this.contentBuf += ch;
          this.emitBlockDelta(this.activeTag, ch);
        }
        break;

      case State.CONTENT_OPEN_ANGLE:
        if (ch === "/") {
          this.state = State.CONTENT_CLOSE_SLASH;
        } else {
          this.contentBuf += "<" + ch;
          this.emitBlockDelta(this.activeTag, "<" + ch);
          this.state = State.CONTENT;
        }
        break;

      case State.CONTENT_CLOSE_SLASH:
        if (isNameStartChar(ch)) {
          this.closeNameBuf = ch;
          this.state = State.CLOSE_TAG_NAME;
        } else {
          this.contentBuf += "</" + ch;
          this.emitBlockDelta(this.activeTag, "</" + ch);
          this.state = State.CONTENT;
        }
        break;

      case State.CLOSE_TAG_NAME:
        if (isNameContinueChar(ch)) {
          this.closeNameBuf += ch;
        } else if (ch === ">") {
          if (this.closeNameBuf === this.activeTag) {
            this.emitBlockEnd(this.activeTag);
            this.emitBlock(this.activeTag, this.contentBuf, this.activeAttrs);
            this.callHandler(this.activeTag, this.contentBuf, this.activeAttrs);
            this.closeNameBuf = "";
            this.resetActive();
            this.state = State.TEXT;
          } else {
            const text = "</" + this.closeNameBuf + ">";
            this.contentBuf += text;
            this.emitBlockDelta(this.activeTag, text);
            this.closeNameBuf = "";
            this.state = State.CONTENT;
          }
        } else {
          const text = "</" + this.closeNameBuf + ch;
          this.contentBuf += text;
          this.emitBlockDelta(this.activeTag, text);
          this.closeNameBuf = "";
          this.state = State.CONTENT;
        }
        break;

      case State.CLOSE_TAG_END:
        if (ch === ">") {
          this.emitBlockEnd(this.activeTag);
          this.emitBlock(this.activeTag, this.contentBuf, this.activeAttrs);
          this.callHandler(this.activeTag, this.contentBuf, this.activeAttrs);
          this.closeNameBuf = "";
          this.resetActive();
          this.state = State.TEXT;
        }
        break;
    }
  }

  // ─── Emission helpers ──────────────────────────────────────────

  private flushText(): void {
    if (this.textBuf.length > 0) {
      this.output.push({ type: "text", content: this.textBuf });
      this.textBuf = "";
    }
  }

  private emitBlockStart(tag: string, attrs: Record<string, string>): void {
    this.flushContentDelta();
    this.output.push({ type: "block-start", tag, attrs: { ...attrs } });
  }

  private emitBlockDelta(tag: string, delta: string): void {
    if (this.pendingContentTag === tag) {
      this.pendingContentDelta += delta;
    } else {
      this.flushContentDelta();
      this.pendingContentTag = tag;
      this.pendingContentDelta = delta;
    }
  }

  private flushContentDelta(): void {
    if (this.pendingContentDelta.length > 0) {
      this.output.push({
        type: "block-delta",
        tag: this.pendingContentTag,
        delta: this.pendingContentDelta,
      });
      this.pendingContentDelta = "";
      this.pendingContentTag = "";
    }
  }

  private emitBlockEnd(tag: string): void {
    this.flushContentDelta();
    this.output.push({ type: "block-end", tag });
  }

  private emitBlock(
    tag: string,
    content: string,
    attrs: Record<string, string>,
    selfClosing?: boolean,
  ): void {
    this.output.push({
      type: "block",
      tag,
      content,
      attrs: { ...attrs },
      ...(selfClosing ? { selfClosing: true } : {}),
    });
  }

  private callHandler(
    tag: string,
    content: string,
    attrs: Record<string, string>,
  ): void {
    this.tags.get(tag)?.onContent?.(content, attrs);
  }

  private resetActive(): void {
    this.activeTag = "";
    this.activeAttrs = {};
    this.contentBuf = "";
  }
}

// ============================================================================
// Attribute parsing
// ============================================================================

function parseAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const s = str.trim();

  while (i < s.length) {
    while (i < s.length && isWhitespace(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] === "/") {
      i++;
      continue;
    }
    if (!isNameStartChar(s[i]!)) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < s.length && isNameContinueChar(s[i]!)) i++;
    const name = s.slice(nameStart, i);

    while (i < s.length && isWhitespace(s[i]!)) i++;

    if (i >= s.length || s[i] !== "=") {
      attrs[name] = "";
      continue;
    }
    i++;

    while (i < s.length && isWhitespace(s[i]!)) i++;
    if (i >= s.length) {
      attrs[name] = "";
      break;
    }

    const quote = s[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valueStart = i;
      while (i < s.length && s[i] !== quote) i++;
      attrs[name] = s.slice(valueStart, i);
      if (i < s.length) i++;
    } else {
      const valueStart = i;
      while (i < s.length && !isWhitespace(s[i]!) && s[i] !== ">" && s[i] !== "/") i++;
      attrs[name] = s.slice(valueStart, i);
    }
  }

  return attrs;
}

function isNameStartChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isNameContinueChar(ch: string): boolean {
  return isNameStartChar(ch) || (ch >= "0" && ch <= "9") || ch === "-";
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
