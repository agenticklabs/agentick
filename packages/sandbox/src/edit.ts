/**
 * Surgical code editing — the crown-jewel edit transform (ADR 59).
 *
 * Ported faithfully from v1 `@agentick/sandbox/edit.ts`. LLM-driven
 * editing with layered matching that recovers from trailing whitespace,
 * indentation mismatch, and CRLF/LF differences. Supports replace,
 * delete, insert (before/after/start/end), and range modes.
 *
 * This module ships the PURE transform only (`applyEdits`) — no I/O,
 * OS-free. It lives in the BASE package `@agentick/sandbox`
 * (re-exported from the index) so BOTH the harness and every provider
 * (`sandbox-local-next`, `sandbox-docker-next`) — which dep the base —
 * share one implementation, mirroring `model-openai-next → model-next`
 * (ADR 59).
 *
 * The `editFile` file-wrapper (read → transform → atomic temp+rename)
 * deliberately lives in the PROVIDER, not here: temp+rename is a
 * filesystem concern owned by the provider layer. This module is the
 * pure text transform, nothing more.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 * @verifiedBy packages/sandbox-next/src/__tests__/edit.spec.ts
 */

import type { SandboxEdit, SandboxEditChange, SandboxEditResult } from "@agentick/spec";

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown by {@link applyEdits} on match failure, validation error, or
 * overlapping edits. Carries `editIndex` + rich diagnostics so the model
 * can self-correct (closest partial match, line, context snippet).
 */
export class EditError extends Error {
  constructor(
    message: string,
    public readonly editIndex: number,
    public readonly detail?: { closest?: string; line?: number; context?: string[] },
  ) {
    super(message);
    this.name = "EditError";
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

interface Replacement {
  start: number;
  end: number;
  content: string;
  editIndex: number;
}

interface AnchorMatch {
  start: number;
  end: number;
  matchedText: string;
}

/** Precompute byte offset of each line start. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number at byte offset. */
function lineAtOffset(starts: number[], offset: number): number {
  let lo = 0,
    hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** Byte range covering lines [startLine, endLine] (0-indexed, inclusive). */
function lineRange(
  source: string,
  starts: number[],
  sourceLines: string[],
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  const start = starts[startLine];
  // End = start of endLine + its length (excludes trailing \n)
  const end = starts[endLine] + sourceLines[endLine].length;
  return { start, end };
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") n++;
  }
  return n;
}

/** Minimum leading whitespace of non-empty lines. */
function minIndent(lines: string[]): number {
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  return min === Infinity ? 0 : min;
}

/** Find all non-overlapping occurrences. */
function findAll(source: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const positions: number[] = [];
  let pos = 0;
  while ((pos = source.indexOf(needle, pos)) !== -1) {
    positions.push(pos);
    pos += needle.length;
  }
  return positions;
}

/** Slide `needle` lines over `haystack` lines, comparing with `cmp`. */
function slideMatch(
  haystackLines: string[],
  needleLines: string[],
  cmp: (a: string, b: string) => boolean,
  startFrom: number = 0,
): number | null {
  const windowSize = needleLines.length;
  for (let i = startFrom; i <= haystackLines.length - windowSize; i++) {
    let match = true;
    for (let j = 0; j < windowSize; j++) {
      if (!cmp(haystackLines[i + j], needleLines[j])) {
        match = false;
        break;
      }
    }
    if (match) return i; // 0-indexed line
  }
  return null;
}

/**
 * Adjust `replacement` indentation to match the delta between
 * the `old` string and the actual matched source block.
 */
function adjustIndent(oldStr: string, matchedStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const matchedLines = matchedStr.split("\n");
  const delta = minIndent(matchedLines) - minIndent(oldLines);

  if (delta === 0) return newStr;

  const pad = " ".repeat(Math.abs(delta));
  return newStr
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      if (delta > 0) return pad + line;
      return line.startsWith(pad) ? line.slice(pad.length) : line.trimStart();
    })
    .join("\n");
}

/**
 * Smart line deletion: when deleting text that occupies complete lines
 * (starts at beginning of a line), also consume the line separator to
 * avoid leaving blank lines behind.
 *
 * Only applies when the match starts at position 0 or right after a `\n`.
 * Partial-line deletions (match starts mid-line) are not affected.
 */
function smartLineDeletion(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } {
  // Skip if the matched text already includes its own line boundary
  if (end > start && source[end - 1] === "\n") return { start, end };

  const startsAtLineBegin = start === 0 || source[start - 1] === "\n";
  if (!startsAtLineBegin) return { start, end };

  // Prefer consuming trailing newline
  if (end < source.length && source[end] === "\n") {
    return { start, end: end + 1 };
  }
  // At end of file: consume preceding newline instead
  if (start > 0 && source[start - 1] === "\n") {
    return { start: start - 1, end };
  }
  return { start, end };
}

/**
 * Build context snippet around a source line for error diagnostics.
 * Shows 2 lines before and after, with `>` marker on the target line.
 */
function buildContextSnippet(sourceLines: string[], targetLine0: number): string[] {
  const contextLines: string[] = [];
  const start = Math.max(0, targetLine0 - 2);
  const end = Math.min(sourceLines.length - 1, targetLine0 + 2);

  for (let i = start; i <= end; i++) {
    const lineNum = (i + 1).toString().padStart(4);
    const marker = i === targetLine0 ? " > " : "   ";
    contextLines.push(`${marker}${lineNum} | ${sourceLines[i]}`);
  }
  return contextLines;
}

/**
 * Find anchor text using 3-strategy matching (exact -> line-normalized -> indent-adjusted).
 * Returns array of matches. Callers validate uniqueness / all-mode.
 */
function findAnchor(
  source: string,
  sourceLines: string[],
  starts: number[],
  needle: string,
  editIndex: number,
  options?: { all?: boolean; searchFrom?: number },
): AnchorMatch[] {
  const searchFrom = options?.searchFrom ?? 0;
  const useAll = options?.all ?? false;

  // ── Strategy 1: Exact match ──
  const positions = findAll(source, needle);
  const filteredPositions = positions.filter((p) => p >= searchFrom);

  if (filteredPositions.length > 0) {
    if (useAll) {
      return filteredPositions.map((pos) => ({
        start: pos,
        end: pos + needle.length,
        matchedText: source.slice(pos, pos + needle.length),
      }));
    }
    if (filteredPositions.length === 1) {
      return [
        {
          start: filteredPositions[0],
          end: filteredPositions[0] + needle.length,
          matchedText: source.slice(filteredPositions[0], filteredPositions[0] + needle.length),
        },
      ];
    }
    // Multiple matches, not all mode — error
    const lines = filteredPositions.map((p) => lineAtOffset(starts, p));
    throw new EditError(
      `Edit ${editIndex}: ${filteredPositions.length} matches found (lines ${lines.join(", ")}). ` +
        `Include more surrounding context to disambiguate, or use all: true.`,
      editIndex,
    );
  }

  // all: true edits only use exact match — skip fallbacks
  if (useAll) {
    return [];
  }

  const needleLines = needle.split("\n");
  const startLineIdx = searchFrom === 0 ? 0 : Math.max(0, lineAtOffset(starts, searchFrom) - 1); // 0-indexed

  // ── Strategy 2: Line-normalized (strip trailing WS) ──
  const normSourceLines = sourceLines.map((l) => l.trimEnd());
  const normNeedleLines = needleLines.map((l) => l.trimEnd());

  const normHit = slideMatch(normSourceLines, normNeedleLines, (a, b) => a === b, startLineIdx);
  if (normHit !== null) {
    const { start, end } = lineRange(
      source,
      starts,
      sourceLines,
      normHit,
      normHit + needleLines.length - 1,
    );
    return [{ start, end, matchedText: source.slice(start, end) }];
  }

  // ── Strategy 3: Indent-adjusted (strip indent baseline, compare shapes) ──
  const baseIndent = minIndent(needleLines);
  const strippedNeedle = needleLines.map((l) => (l.trim() === "" ? "" : l.slice(baseIndent)));

  for (let si = startLineIdx; si <= sourceLines.length - needleLines.length; si++) {
    const window = sourceLines.slice(si, si + needleLines.length);
    const windowIndent = minIndent(window);
    const strippedWindow = window.map((l) => (l.trim() === "" ? "" : l.slice(windowIndent)));

    if (strippedNeedle.every((line, j) => line === strippedWindow[j])) {
      const { start, end } = lineRange(
        source,
        starts,
        sourceLines,
        si,
        si + needleLines.length - 1,
      );
      return [{ start, end, matchedText: source.slice(start, end) }];
    }
  }

  return [];
}

/**
 * Throw a diagnostic error when anchor text cannot be found.
 */
function throwNoMatch(
  needle: string,
  editIndex: number,
  sourceLines: string[],
  label: string = "old",
): never {
  const needleLines = needle.split("\n");
  const firstLine = needleLines[0].trim();
  let closestLine0 = -1;

  for (let j = 0; j < sourceLines.length; j++) {
    if (sourceLines[j].includes(firstLine)) {
      closestLine0 = j;
      break;
    }
  }

  const context = closestLine0 >= 0 ? buildContextSnippet(sourceLines, closestLine0) : undefined;

  const contextDisplay = context ? "\n  Closest partial match:\n" + context.join("\n") : "";
  const hint = "\n  Hint: re-read the file to get current content.";

  throw new EditError(
    `Edit ${editIndex}: no match found for ${label}.` +
      (closestLine0 >= 0 ? ` First line appears near line ${closestLine0 + 1}.` : "") +
      `\n  Looking for: "${firstLine.slice(0, 80)}"` +
      contextDisplay +
      hint,
    editIndex,
    closestLine0 >= 0
      ? { closest: sourceLines[closestLine0], line: closestLine0 + 1, context }
      : undefined,
  );
}

// ── Mode Validation ─────────────────────────────────────────────────────────

function validateReplace(edit: SandboxEdit, i: number): void {
  if (edit.old === undefined || edit.old.length === 0) {
    throw new EditError(
      `Edit ${i}: old string is required for replace mode and cannot be empty.`,
      i,
    );
  }
  if (edit.new === undefined) {
    throw new EditError(`Edit ${i}: new string is required for replace mode.`, i);
  }
}

function validateDelete(edit: SandboxEdit, i: number): void {
  if (edit.old === undefined || edit.old.length === 0) {
    throw new EditError(
      `Edit ${i}: old string is required for delete mode and cannot be empty.`,
      i,
    );
  }
}

function validateInsertAnchor(edit: SandboxEdit, i: number): void {
  if (edit.old === undefined || edit.old.length === 0) {
    throw new EditError(
      `Edit ${i}: old string is required as anchor for insert ${edit.insert} mode.`,
      i,
    );
  }
  if (edit.content === undefined) {
    throw new EditError(`Edit ${i}: content is required for insert mode.`, i);
  }
}

function validateInsertBoundary(edit: SandboxEdit, i: number): void {
  if (edit.content === undefined) {
    throw new EditError(`Edit ${i}: content is required for insert ${edit.insert} mode.`, i);
  }
}

function validateRange(edit: SandboxEdit, i: number): void {
  if (edit.from === undefined) {
    throw new EditError(`Edit ${i}: from is required for range mode.`, i);
  }
  if (edit.to === undefined) {
    throw new EditError(`Edit ${i}: to is required for range mode.`, i);
  }
  if (edit.content === undefined) {
    throw new EditError(`Edit ${i}: content is required for range mode.`, i);
  }
}

// ── Mode Handlers ───────────────────────────────────────────────────────────

function handleReplace(
  edit: SandboxEdit & { old: string; new: string },
  i: number,
  source: string,
  sourceLines: string[],
  starts: number[],
  replacements: Replacement[],
): void {
  const old = edit.old.replace(/\r\n/g, "\n");
  const neu = edit.new.replace(/\r\n/g, "\n");

  const matches = findAnchor(source, sourceLines, starts, old, i, { all: edit.all });

  if (matches.length === 0) {
    if (edit.all) return; // no-op for all: true
    throwNoMatch(old, i, sourceLines);
  }

  for (const match of matches) {
    // For indent-adjusted matches, adjust the replacement indentation
    const adjusted = match.matchedText !== old ? adjustIndent(old, match.matchedText, neu) : neu;

    let { start, end } = { start: match.start, end: match.end };
    // Smart line deletion when replacement is empty (delete via replace mode)
    if (adjusted === "") {
      ({ start, end } = smartLineDeletion(source, start, end));
    }
    replacements.push({ start, end, content: adjusted, editIndex: i });
  }
}

function handleDelete(
  edit: SandboxEdit & { old: string },
  i: number,
  source: string,
  sourceLines: string[],
  starts: number[],
  replacements: Replacement[],
): void {
  const old = edit.old.replace(/\r\n/g, "\n");
  const matches = findAnchor(source, sourceLines, starts, old, i, { all: edit.all });

  if (matches.length === 0) {
    if (edit.all) return;
    throwNoMatch(old, i, sourceLines);
  }

  for (const match of matches) {
    const { start, end } = smartLineDeletion(source, match.start, match.end);
    replacements.push({ start, end, content: "", editIndex: i });
  }
}

function handleInsertAnchor(
  edit: SandboxEdit & { old: string; insert: "before" | "after"; content: string },
  i: number,
  source: string,
  sourceLines: string[],
  starts: number[],
  replacements: Replacement[],
): void {
  const old = edit.old.replace(/\r\n/g, "\n");
  const content = edit.content.replace(/\r\n/g, "\n");
  const matches = findAnchor(source, sourceLines, starts, old, i, { all: edit.all });

  if (matches.length === 0) {
    if (edit.all) return;
    throwNoMatch(old, i, sourceLines);
  }

  for (const match of matches) {
    // Adjust content indentation to match anchor
    const adjusted =
      match.matchedText !== old ? adjustIndent(old, match.matchedText, content) : content;

    if (edit.insert === "before") {
      replacements.push({
        start: match.start,
        end: match.end,
        content: adjusted + "\n" + match.matchedText,
        editIndex: i,
      });
    } else {
      replacements.push({
        start: match.start,
        end: match.end,
        content: match.matchedText + "\n" + adjusted,
        editIndex: i,
      });
    }
  }
}

function handleInsertBoundary(
  edit: SandboxEdit & { insert: "start" | "end"; content: string },
  i: number,
  source: string,
  replacements: Replacement[],
): void {
  const content = edit.content.replace(/\r\n/g, "\n");

  if (edit.insert === "start") {
    if (source.length === 0) {
      replacements.push({ start: 0, end: 0, content, editIndex: i });
    } else {
      // Avoid double-newline: if content already ends with \n, don't add separator
      const sep = content.endsWith("\n") ? "" : "\n";
      replacements.push({ start: 0, end: 0, content: content + sep, editIndex: i });
    }
  } else {
    if (source.length === 0) {
      replacements.push({ start: source.length, end: source.length, content, editIndex: i });
    } else {
      // Avoid double-newline: if source already ends with \n, don't add separator
      const sep = source.endsWith("\n") ? "" : "\n";
      replacements.push({
        start: source.length,
        end: source.length,
        content: sep + content,
        editIndex: i,
      });
    }
  }
}

function handleRange(
  edit: SandboxEdit & { from: string; to: string; content: string },
  i: number,
  source: string,
  sourceLines: string[],
  starts: number[],
  replacements: Replacement[],
): void {
  const from = edit.from.replace(/\r\n/g, "\n");
  const to = edit.to.replace(/\r\n/g, "\n");
  const content = edit.content.replace(/\r\n/g, "\n");

  const fromMatches = findAnchor(source, sourceLines, starts, from, i);
  if (fromMatches.length === 0) {
    throwNoMatch(from, i, sourceLines, "from");
  }
  const fromMatch = fromMatches[0];

  const toMatches = findAnchor(source, sourceLines, starts, to, i, {
    searchFrom: fromMatch.end,
  });
  if (toMatches.length === 0) {
    const fromLine = lineAtOffset(starts, fromMatch.start);
    throw new EditError(
      `Edit ${i}: 'to' marker not found after 'from' (matched at line ${fromLine}).` +
        `\n  Looking for: "${to.split("\n")[0].trim().slice(0, 80)}"` +
        "\n  Hint: re-read the file to get current content.",
      i,
    );
  }
  const toMatch = toMatches[0];

  replacements.push({
    start: fromMatch.start,
    end: toMatch.end,
    content,
    editIndex: i,
  });
}

// ── Core: Pure Transform ─────────────────────────────────────────────────────

/**
 * Apply edits to a source string. Pure function, no I/O.
 *
 * Mode detection (by field presence, precedence: range > insert > delete > replace):
 * - Range: `from` + `to` + `content` — replace block between markers (inclusive)
 * - Insert before/after: `old` + `insert` + `content` — insert relative to anchor
 * - Insert start/end: `insert` + `content` — prepend/append to file
 * - Delete: `old` + `delete: true` — remove matched text
 * - Replace: `old` + `new` — find and replace
 *
 * Matching strategy per anchor (in order):
 * 1. Exact byte match
 * 2. Line-normalized (trailing whitespace stripped)
 * 3. Indent-adjusted (leading whitespace baseline stripped, new indentation adjusted)
 *
 * Multi-edit: all matches resolved against original source,
 * validated for overlap, applied bottom-to-top.
 *
 * @throws EditError on match failure, validation error, or overlapping edits
 */
export function applyEdits(source: string, edits: readonly SandboxEdit[]): SandboxEditResult {
  if (edits.length === 0) return { content: source, applied: 0, changes: [] };

  // Normalize CRLF once. Code files should use LF.
  source = source.replace(/\r\n/g, "\n");

  const starts = lineStarts(source);
  const sourceLines = source.split("\n");
  const replacements: Replacement[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    // ── Mode: Range ──
    if (edit.from !== undefined || edit.to !== undefined) {
      validateRange(edit, i);
      handleRange(
        edit as SandboxEdit & { from: string; to: string; content: string },
        i,
        source,
        sourceLines,
        starts,
        replacements,
      );
      continue;
    }

    // ── Mode: Insert ──
    if (edit.insert !== undefined) {
      if (edit.insert === "start" || edit.insert === "end") {
        validateInsertBoundary(edit, i);
        handleInsertBoundary(
          edit as SandboxEdit & { insert: "start" | "end"; content: string },
          i,
          source,
          replacements,
        );
      } else {
        validateInsertAnchor(edit, i);
        handleInsertAnchor(
          edit as SandboxEdit & { old: string; insert: "before" | "after"; content: string },
          i,
          source,
          sourceLines,
          starts,
          replacements,
        );
      }
      continue;
    }

    // ── Mode: Delete ──
    if (edit.delete) {
      validateDelete(edit, i);
      handleDelete(
        edit as SandboxEdit & { old: string },
        i,
        source,
        sourceLines,
        starts,
        replacements,
      );
      continue;
    }

    // ── Mode: Replace (default) ──
    validateReplace(edit, i);
    handleReplace(
      edit as SandboxEdit & { old: string; new: string },
      i,
      source,
      sourceLines,
      starts,
      replacements,
    );
  }

  // ── Validate no overlaps ───────────────────────────────────────────────
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new EditError(
        `Edits ${sorted[i - 1].editIndex} and ${sorted[i].editIndex} overlap at offset ${sorted[i].start}.`,
        sorted[i].editIndex,
      );
    }
  }

  // ── Apply bottom-to-top ────────────────────────────────────────────────
  sorted.sort((a, b) => b.start - a.start);

  let result = source;
  const changes: SandboxEditChange[] = [];

  for (const rep of sorted) {
    const before = result.slice(rep.start, rep.end);
    result = result.slice(0, rep.start) + rep.content + result.slice(rep.end);
    changes.push({
      line: lineAtOffset(starts, rep.start),
      removed: countNewlines(before) + 1,
      added: countNewlines(rep.content) + 1,
    });
  }

  changes.reverse(); // document order

  return { content: result, applied: replacements.length, changes };
}
