/**
 * DiffView — colored diff rendering with line numbers and gutter markers.
 *
 * Parses unified diff output (from jsdiff's createTwoFilesPatch) and renders:
 * - Summary header with add/remove counts
 * - Line numbers in a left gutter
 * - Colored text (green additions, red removals, dim context)
 * - Hunk headers in cyan
 *
 * Uses chalk for ANSI coloring without background colors — background colors
 * create visible gaps between lines in most terminals due to inter-line
 * pixel spacing from the font engine.
 */

import chalk from "chalk";
import { Box, Text } from "ink";

interface DiffViewProps {
  patch: string;
  filePath?: string;
  maxLines?: number;
}

// ────────────────────────────────────────────────────────────────────────────

interface ParsedLine {
  type: "add" | "remove" | "context" | "hunk";
  content: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parsePatch(patch: string): ParsedLine[] {
  const lines = patch.split("\n");
  const result: ParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Skip headers and diff metadata
    if (
      line.startsWith("Index:") ||
      line.startsWith("diff ") ||
      line.startsWith("===") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10);
      newLine = parseInt(hunkMatch[2]!, 10);
      result.push({ type: "hunk", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLine });
      oldLine++;
    } else if (line.length > 0 || (oldLine > 0 && newLine > 0)) {
      result.push({ type: "context", content: line.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

function countChanges(lines: ParsedLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    if (line.type === "remove") removed++;
  }
  return { added, removed };
}

// ────────────────────────────────────────────────────────────────────────────

function renderLine(line: ParsedLine, gutterWidth: number): string {
  if (line.type === "hunk") {
    return chalk.cyan.dim(line.content);
  }

  const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  const lineNum = line.type === "remove" ? String(line.oldLine ?? "") : String(line.newLine ?? "");

  const gutter = `${lineNum.padStart(gutterWidth)} ${marker} `;

  if (line.type === "add") {
    return chalk.green.dim(gutter) + chalk.green(line.content);
  }

  if (line.type === "remove") {
    return chalk.red.dim(gutter) + chalk.red(line.content);
  }

  return chalk.dim(gutter + line.content);
}

// ────────────────────────────────────────────────────────────────────────────

export function DiffView({ patch, filePath, maxLines = 80 }: DiffViewProps) {
  const parsed = parsePatch(patch);
  const { added, removed } = countChanges(parsed);

  const displayLines = parsed.slice(0, maxLines);
  const remaining = parsed.length - maxLines;

  const maxLineNum = Math.max(...parsed.map((l) => l.oldLine ?? l.newLine ?? 0), 1);
  const gutterWidth = String(maxLineNum).length;

  const body = displayLines.map((line) => renderLine(line, gutterWidth)).join("\n");

  return (
    <Box flexDirection="column">
      {filePath && (
        <Box gap={2} flexDirection="row">
          <Text bold>{filePath}</Text>
          <Text dimColor>
            {added > 0 && <Text color="green">+{added}</Text>}
            {added > 0 && removed > 0 && <Text> </Text>}
            {removed > 0 && <Text color="red">-{removed}</Text>}
          </Text>
        </Box>
      )}
      {!filePath && (added > 0 || removed > 0) && (
        <Text dimColor>
          {added > 0 ? `${added} added` : ""}
          {added > 0 && removed > 0 ? ", " : ""}
          {removed > 0 ? `${removed} removed` : ""}
        </Text>
      )}
      <Text>{body}</Text>
      {remaining > 0 && <Text dimColor>... {remaining} more line(s)</Text>}
    </Box>
  );
}
