import type { AdapterDelta } from "./stream-accumulator.js";

/**
 * Handler for a registered custom block tag.
 */
export interface StreamTagHandler {
  /** Called when the opening tag is found, before content arrives. */
  onStart?(attrs: Record<string, string>): void;
  /** Called with accumulated content when closing tag is found. */
  onContent?(content: string, attrs: Record<string, string>): void;
  /** Called for self-closing tags (e.g., `<done/>`). */
  onSelfClosing?(attrs: Record<string, string>): void;
}

export interface StreamTagParserConfig {
  /** Map of tag names to handlers. Only registered tags are intercepted. */
  tags: Record<string, StreamTagHandler>;
}

const enum State {
  /** Normal text passthrough. */
  TEXT,
  /** Saw '<', accumulating potential tag name or '/'. */
  OPEN_ANGLE,
  /** Inside tag attributes, waiting for '>' or '/>'. */
  ATTRS,
  /** Inside matched tag content. */
  CONTENT,
  /** Saw '<' inside content — could be close tag. */
  CONTENT_OPEN_ANGLE,
  /** Reading '/' after '<' inside content. */
  CONTENT_CLOSE_SLASH,
  /** Reading close tag name after '</'. */
  CLOSE_TAG_NAME,
  /** Waiting for '>' after close tag name matches. */
  CLOSE_TAG_END,
}

/**
 * Streaming parser that intercepts registered XML-like tags in text deltas,
 * strips them from the text stream, and routes their content to handlers.
 *
 * Generalizes ThinkTagParser to support multiple configurable tags with
 * attributes. Only registered tags are intercepted — unregistered markup
 * passes through as text.
 *
 * Operates on AdapterDelta streams: text deltas are parsed, all other
 * delta types pass through unchanged.
 */
export class StreamTagParser {
  private readonly tags: Map<string, StreamTagHandler>;
  private readonly tagNames: Set<string>;

  private state = State.TEXT;

  // Buffer for text being accumulated before emission
  private textBuf = "";
  // Buffer for potential tag name being read (after '<')
  private nameBuf = "";
  // Buffer for attribute text being accumulated
  private attrBuf = "";

  // Active tag state (when inside CONTENT)
  private activeTag = "";
  private activeAttrs: Record<string, string> = {};
  private contentBuf = "";

  // Close tag state
  private closeNameBuf = "";

  // Pending content delta buffer (coalesced across chars within a process() call)
  private pendingContentDelta = "";
  private pendingContentTag = "";

  // Output accumulator for current process() call
  private output: AdapterDelta[] = [];

  constructor(config: StreamTagParserConfig) {
    this.tags = new Map(Object.entries(config.tags));
    this.tagNames = new Set(this.tags.keys());
  }

  /**
   * Process an AdapterDelta. Non-text deltas pass through unchanged.
   * Text deltas are parsed for registered tags.
   */
  process(delta: AdapterDelta): AdapterDelta[] {
    if (delta.type !== "text") {
      return [delta];
    }

    this.output = [];
    for (let i = 0; i < delta.delta.length; i++) {
      this.feed(delta.delta[i]);
    }
    // Flush any pending text/content buffers into the output
    this.flushText();
    this.flushContentDelta();
    const result = this.output;
    this.output = [];
    return result;
  }

  /**
   * Flush any remaining buffered content at stream end.
   */
  flush(): AdapterDelta[] {
    this.output = [];

    switch (this.state) {
      case State.TEXT:
        this.flushText();
        break;

      case State.OPEN_ANGLE:
        // Incomplete '<name...' — emit as text
        this.textBuf += "<" + this.nameBuf;
        this.nameBuf = "";
        this.flushText();
        this.state = State.TEXT;
        break;

      case State.ATTRS:
        // Unclosed tag with attrs — emit as text
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
        // Unclosed block — best-effort emit
        let content = this.contentBuf;
        if (this.state === State.CONTENT_OPEN_ANGLE) content += "<";
        if (this.state === State.CONTENT_CLOSE_SLASH) content += "</";
        if (this.state === State.CLOSE_TAG_NAME) content += "</" + this.closeNameBuf;
        if (this.state === State.CLOSE_TAG_END) content += "</" + this.closeNameBuf;

        if (content || this.activeTag) {
          this.emitCustomBlock(this.activeTag, content, this.activeAttrs);
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
          // End of tag name
          if (this.tagNames.has(this.nameBuf)) {
            // Registered tag found
            this.flushText();
            this.activeTag = this.nameBuf;
            this.activeAttrs = {};
            this.nameBuf = "";

            if (ch === ">") {
              // <tagname>
              this.contentBuf = "";
              this.emitBlockStart(this.activeTag, {});
              this.tags.get(this.activeTag)?.onStart?.({});
              this.state = State.CONTENT;
            } else if (ch === "/") {
              // Could be self-closing <tagname/>
              this.attrBuf = "/"; // hold the '/'
              this.state = State.ATTRS;
            } else {
              // Whitespace — attributes follow
              this.attrBuf = "";
              this.state = State.ATTRS;
            }
          } else {
            // Not a registered tag — emit as text
            this.textBuf += "<" + this.nameBuf + ch;
            this.nameBuf = "";
            this.state = State.TEXT;
          }
        } else if (this.nameBuf.length === 0) {
          // '<' followed by non-name-start — just text
          if (ch === "/") {
            // '</' outside content — just text
            this.textBuf += "</";
          } else {
            this.textBuf += "<" + ch;
          }
          this.state = State.TEXT;
        } else {
          // nameBuf has content but ch is not valid continuation and not a terminator
          // Not a registered tag — emit as text
          this.textBuf += "<" + this.nameBuf + ch;
          this.nameBuf = "";
          this.state = State.TEXT;
        }
        break;

      case State.ATTRS: {
        this.attrBuf += ch;
        if (ch === ">") {
          // Check if previous char was '/' for self-closing
          const trimmed = this.attrBuf.trimEnd();
          if (trimmed.endsWith("/>")) {
            // Self-closing with attrs
            const attrStr = trimmed.slice(0, -2);
            const attrs = parseAttributes(attrStr);
            this.activeAttrs = attrs;
            this.emitCustomBlock(this.activeTag, "", this.activeAttrs, true);
            const handler = this.tags.get(this.activeTag);
            handler?.onSelfClosing?.(this.activeAttrs);
            this.attrBuf = "";
            this.resetActive();
            this.state = State.TEXT;
          } else {
            // Opening tag with attrs complete
            const attrStr = this.attrBuf.slice(0, -1); // Remove '>'
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
          // '<' inside content but not a close tag
          this.contentBuf += "<" + ch;
          this.emitBlockDelta(this.activeTag, "<" + ch);
          this.state = State.CONTENT;
        }
        break;

      case State.CONTENT_CLOSE_SLASH:
        // Start reading close tag name
        if (isNameStartChar(ch)) {
          this.closeNameBuf = ch;
          this.state = State.CLOSE_TAG_NAME;
        } else {
          // '</' followed by non-name — just content
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
            // Matched close tag!
            this.emitBlockEnd(this.activeTag);
            this.emitCustomBlock(this.activeTag, this.contentBuf, this.activeAttrs);
            this.callHandler(this.activeTag, this.contentBuf, this.activeAttrs);
            this.closeNameBuf = "";
            this.resetActive();
            this.state = State.TEXT;
          } else {
            // Non-matching close tag — it's content
            const text = "</" + this.closeNameBuf + ">";
            this.contentBuf += text;
            this.emitBlockDelta(this.activeTag, text);
            this.closeNameBuf = "";
            this.state = State.CONTENT;
          }
        } else {
          // Name ended by non-'>' char — not a valid close tag, content
          const text = "</" + this.closeNameBuf + ch;
          this.contentBuf += text;
          this.emitBlockDelta(this.activeTag, text);
          this.closeNameBuf = "";
          this.state = State.CONTENT;
        }
        break;

      case State.CLOSE_TAG_END:
        // Should not normally reach here, but handle gracefully
        if (ch === ">") {
          this.emitBlockEnd(this.activeTag);
          this.emitCustomBlock(this.activeTag, this.contentBuf, this.activeAttrs);
          this.callHandler(this.activeTag, this.contentBuf, this.activeAttrs);
          this.closeNameBuf = "";
          this.resetActive();
          this.state = State.TEXT;
        }
        break;
    }
  }

  // ---- Emission helpers ----

  private flushText(): void {
    if (this.textBuf) {
      this.output.push({ type: "text", delta: this.textBuf });
      this.textBuf = "";
    }
  }

  private emitBlockStart(tag: string, attrs: Record<string, string>): void {
    this.flushContentDelta();
    this.output.push({
      type: "custom_block_start",
      tag,
      attrs: { ...attrs },
    } as AdapterDelta);
  }

  private emitBlockDelta(tag: string, delta: string): void {
    // Batch content deltas within a single process() call
    if (this.pendingContentTag === tag) {
      this.pendingContentDelta += delta;
    } else {
      this.flushContentDelta();
      this.pendingContentTag = tag;
      this.pendingContentDelta = delta;
    }
  }

  private flushContentDelta(): void {
    if (this.pendingContentDelta) {
      this.output.push({
        type: "custom_block_delta",
        tag: this.pendingContentTag,
        delta: this.pendingContentDelta,
      } as AdapterDelta);
      this.pendingContentDelta = "";
      this.pendingContentTag = "";
    }
  }

  private emitBlockEnd(tag: string): void {
    this.flushContentDelta();
    this.output.push({
      type: "custom_block_end",
      tag,
    } as AdapterDelta);
  }

  private emitCustomBlock(
    tag: string,
    content: string,
    attrs: Record<string, string>,
    selfClosing?: boolean,
  ): void {
    this.output.push({
      type: "custom_block",
      tag,
      content,
      attrs: { ...attrs },
      ...(selfClosing ? { selfClosing: true } : {}),
    } as AdapterDelta);
  }

  private callHandler(tag: string, content: string, attrs: Record<string, string>): void {
    const handler = this.tags.get(tag);
    handler?.onContent?.(content, attrs);
  }

  private resetActive(): void {
    this.activeTag = "";
    this.activeAttrs = {};
    this.contentBuf = "";
  }
}

/**
 * Parse an attribute string like `for="block-123" confidence="high"`.
 */
function parseAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const s = str.trim();

  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && isWhitespace(s[i])) i++;
    if (i >= s.length) break;

    // Skip '/' (from self-closing tag remnants)
    if (s[i] === "/") {
      i++;
      continue;
    }

    // Read attribute name
    if (!isNameStartChar(s[i])) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < s.length && isNameContinueChar(s[i])) i++;
    const name = s.slice(nameStart, i);

    // Skip whitespace
    while (i < s.length && isWhitespace(s[i])) i++;

    if (i >= s.length || s[i] !== "=") {
      // Boolean attribute
      attrs[name] = "";
      continue;
    }
    i++; // skip '='

    // Skip whitespace
    while (i < s.length && isWhitespace(s[i])) i++;
    if (i >= s.length) {
      attrs[name] = "";
      break;
    }

    // Read value
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      i++; // skip opening quote
      const valueStart = i;
      while (i < s.length && s[i] !== quote) i++;
      attrs[name] = s.slice(valueStart, i);
      if (i < s.length) i++; // skip closing quote
    } else {
      // Unquoted value
      const valueStart = i;
      while (i < s.length && !isWhitespace(s[i]) && s[i] !== ">" && s[i] !== "/") i++;
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
