/**
 * Surgical Code Editing
 *
 * LLM-driven code editing with layered matching that recovers from
 * trailing whitespace, indentation mismatch, and CRLF/LF differences.
 *
 * Pure transform (`applyEdits`) + file wrapper (`editFile`) with atomic writes.
 */

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Edit {
  /** Exact string to find in the source. */
  old: string;
  /** Replacement string. Empty string deletes the match. */
  new: string;
  /** Replace ALL occurrences. Default false — requires unique match. */
  all?: boolean;
}

export interface EditChange {
  /** 1-based line where the change starts. */
  line: number;
  /** Lines removed. */
  removed: number;
  /** Lines added. */
  added: number;
}

export interface EditResult {
  /** Resulting content after edits. */
  content: string;
  /** Total number of replacements applied. */
  applied: number;
  /** Per-replacement details in document order. */
  changes: EditChange[];
}

export class EditError extends Error {
  constructor(
    message: string,
    public readonly editIndex: number,
    public readonly detail?: { closest?: string; line?: number },
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
): number | null {
  const windowSize = needleLines.length;
  for (let i = 0; i <= haystackLines.length - windowSize; i++) {
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

// ── Core: Pure Transform ─────────────────────────────────────────────────────

/**
 * Apply edits to a source string. Pure function, no I/O.
 *
 * Matching strategy per edit (in order):
 * 1. Exact byte match
 * 2. Line-normalized (trailing whitespace stripped)
 * 3. Indent-adjusted (leading whitespace baseline stripped, new indentation adjusted)
 *
 * Multi-edit: all matches resolved against original source,
 * validated for overlap, applied bottom-to-top.
 *
 * @throws EditError on match failure or overlapping edits
 */
export function applyEdits(source: string, edits: Edit[]): EditResult {
  if (edits.length === 0) return { content: source, applied: 0, changes: [] };

  // Normalize CRLF once. Code files should use LF.
  source = source.replace(/\r\n/g, "\n");

  const starts = lineStarts(source);
  const sourceLines = source.split("\n");
  const replacements: Replacement[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.old.length === 0) {
      throw new EditError(`Edit ${i}: old string cannot be empty.`, i);
    }

    const old = edit.old.replace(/\r\n/g, "\n");
    const neu = edit.new.replace(/\r\n/g, "\n");

    // ── Strategy 1: Exact match ──────────────────────────────────────────
    const positions = findAll(source, old);

    if (positions.length > 0) {
      if (edit.all) {
        for (const pos of positions) {
          replacements.push({ start: pos, end: pos + old.length, content: neu, editIndex: i });
        }
      } else if (positions.length === 1) {
        replacements.push({
          start: positions[0],
          end: positions[0] + old.length,
          content: neu,
          editIndex: i,
        });
      } else {
        const lines = positions.map((p) => lineAtOffset(starts, p));
        throw new EditError(
          `Edit ${i}: ${positions.length} matches found (lines ${lines.join(", ")}). ` +
            `Include more surrounding context to disambiguate, or use all: true.`,
          i,
        );
      }
      continue;
    }

    // all: true edits only use exact match — skip fallbacks
    if (edit.all) {
      // Zero matches with all: true is a no-op, not an error
      continue;
    }

    const oldLines = old.split("\n");

    // ── Strategy 2: Line-normalized (strip trailing WS) ──────────────────
    const normSourceLines = sourceLines.map((l) => l.trimEnd());
    const normOldLines = oldLines.map((l) => l.trimEnd());

    const normHit = slideMatch(normSourceLines, normOldLines, (a, b) => a === b);
    if (normHit !== null) {
      const { start, end } = lineRange(
        source,
        starts,
        sourceLines,
        normHit,
        normHit + oldLines.length - 1,
      );
      replacements.push({ start, end, content: neu, editIndex: i });
      continue;
    }

    // ── Strategy 3: Indent-adjusted (strip indent baseline, compare shapes)
    const indentHit = (() => {
      const baseIndent = minIndent(oldLines);
      const strippedNeedle = oldLines.map((l) => (l.trim() === "" ? "" : l.slice(baseIndent)));

      for (let si = 0; si <= sourceLines.length - oldLines.length; si++) {
        const window = sourceLines.slice(si, si + oldLines.length);
        const windowIndent = minIndent(window);
        const strippedWindow = window.map((l) => (l.trim() === "" ? "" : l.slice(windowIndent)));

        if (strippedNeedle.every((line, j) => line === strippedWindow[j])) {
          return si;
        }
      }
      return null;
    })();

    if (indentHit !== null) {
      const { start, end } = lineRange(
        source,
        starts,
        sourceLines,
        indentHit,
        indentHit + oldLines.length - 1,
      );
      const matched = source.slice(start, end);
      const adjusted = adjustIndent(old, matched, neu);
      replacements.push({ start, end, content: adjusted, editIndex: i });
      continue;
    }

    // ── No match — diagnostic error ──────────────────────────────────────
    const firstLine = oldLines[0].trim();
    let closestLine = -1;
    for (let j = 0; j < sourceLines.length; j++) {
      if (sourceLines[j].includes(firstLine)) {
        closestLine = j + 1;
        break;
      }
    }

    throw new EditError(
      `Edit ${i}: no match found` +
        (closestLine > 0 ? ` (first line appears near line ${closestLine})` : "") +
        `. First line: "${firstLine.slice(0, 80)}"`,
      i,
      closestLine > 0 ? { closest: sourceLines[closestLine - 1], line: closestLine } : undefined,
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
  const changes: EditChange[] = [];

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

// ── File Wrapper ─────────────────────────────────────────────────────────────

/**
 * Edit a file on disk. Reads, applies edits, writes atomically (temp + rename).
 */
export async function editFile(path: string, edits: Edit[]): Promise<EditResult> {
  const source = await readFile(path, "utf-8");
  const result = applyEdits(source, edits);
  if (result.applied === 0) return result;

  // Atomic write: temp in same dir (same filesystem), then rename
  const tmp = join(dirname(path), `.edit-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, result.content, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
  return result;
}
