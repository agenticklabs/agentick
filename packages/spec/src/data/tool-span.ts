/**
 * A tool call OPENS a span and its result CLOSES it. Between the two the
 * conversation is mid-flight — the model has asked and not yet heard back — and
 * one rule falls out of that:
 *
 *   **A conversation may be divided only where no span is open.**
 *
 * That sentence generates every use. The fold picks such a position; token-budget
 * eviction must not leave a span half-open; the wire refuses a half-open span,
 * because Anthropic, Google and OpenAI all reject one. Structural span-closure is
 * also what a turn boundary IS underneath the semantic signal of "a human spoke".
 *
 * This module decides nothing. It reports where spans open and close, and which
 * ones are missing an end; what to do about it belongs to the site that knows
 * what it can still afford to lose.
 *
 * Deliberately structural rather than typed against `ContentBlock` or
 * `LanguageModelMessagePart`: those sit in different layers of spec and importing
 * one from the other would cycle. The id field also genuinely differs —
 * `ToolUseBlock.toolUseId` against the wire part's `id` — and absorbing that in
 * one function is most of the point.
 */

/** A block or wire part, read only for the ends of a span. */
export interface ToolSpanBlock {
  readonly type: string;
  readonly id?: unknown;
  readonly toolUseId?: unknown;
}

/** Which end of a span a block is: `open` is a `tool_use`, `close` a `tool_result`. */
export interface ToolSpanEnd {
  readonly end: "open" | "close";
  readonly toolUseId: string;
}

const asId = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The end of a span this block is, or `undefined` for everything else. */
export function toolSpanEnd(block: ToolSpanBlock): ToolSpanEnd | undefined {
  if (block.type === "tool_use") {
    const toolUseId = asId(block.toolUseId) ?? asId(block.id);
    return toolUseId === undefined ? undefined : { end: "open", toolUseId };
  }
  if (block.type === "tool_result") {
    const toolUseId = asId(block.toolUseId);
    return toolUseId === undefined ? undefined : { end: "close", toolUseId };
  }
  return undefined;
}

/** Spans missing an end — a dangling reference in either direction. */
export interface DanglingToolIds {
  /** Opened, never closed: a call with no result. */
  readonly unclosed: ReadonlySet<string>;
  /** Closed, never opened: a result with no call. */
  readonly unopened: ReadonlySet<string>;
}

const NONE: DanglingToolIds = { unclosed: new Set(), unopened: new Set() };

/**
 * Find spans missing an end.
 *
 * Matching is by id across the whole sequence, never by adjacency: parallel tool
 * calls interleave their results, and a window rule would call a legal
 * conversation illegal.
 *
 * Takes content arrays rather than a flat block stream. Grouping is irrelevant
 * to the answer, so a flat `Iterable` reads more truthful — but it forces every
 * caller through a generator, and that measured 2.5x slower than mapping to the
 * arrays the callers already hold. This runs on every request.
 */
export function danglingToolIds(contents: Iterable<readonly ToolSpanBlock[]>): DanglingToolIds {
  const opened = new Set<string>();
  const closed = new Set<string>();
  for (const content of contents) {
    for (const block of content) {
      const span = toolSpanEnd(block);
      if (span === undefined) continue;
      (span.end === "open" ? opened : closed).add(span.toolUseId);
    }
  }
  if (opened.size === 0 && closed.size === 0) return NONE;

  const unclosed = new Set<string>();
  for (const id of opened) if (!closed.has(id)) unclosed.add(id);
  const unopened = new Set<string>();
  for (const id of closed) if (!opened.has(id)) unopened.add(id);
  return { unclosed, unopened };
}

/** True when nothing dangles — the cheap check every well-formed sequence takes. */
export function isIntact(dangling: DanglingToolIds): boolean {
  return dangling.unclosed.size === 0 && dangling.unopened.size === 0;
}

/** True when this end is the surviving half of a broken span. */
export function isDangling(end: ToolSpanEnd, dangling: DanglingToolIds): boolean {
  const missing = end.end === "open" ? dangling.unclosed : dangling.unopened;
  return missing.has(end.toolUseId);
}
