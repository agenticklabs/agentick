/**
 * InputBar — visual-only user text input for the TUI.
 *
 * Renders value/cursor state passed from the parent. No internal useInput
 * or useLineEditor — the parent orchestrator owns all input routing.
 *
 * Supports multi-line values: grows vertically, windows around the cursor
 * line when content exceeds `maxLines`. The "› " prefix only appears on
 * the first visible line; subsequent lines are padded to align.
 */

import { Box, Text } from "ink";
import { RichTextInput } from "./RichTextInput.js";

export interface InputBarProps {
  value: string;
  cursor: number;
  isActive?: boolean;
  placeholder?: string;
  /** Maximum visible lines before windowing (default: 10) */
  maxLines?: number;
}

export function InputBar({
  value,
  cursor,
  isActive = true,
  placeholder,
  maxLines = 10,
}: InputBarProps) {
  const resolvedPlaceholder =
    placeholder ?? (isActive ? "Type a message..." : "Waiting for response...");

  const lines = value.split("\n");
  const isMultiLine = lines.length > 1;

  // Compute windowed value/cursor when exceeding maxLines
  let displayValue = value;
  let displayCursor = cursor;

  if (isMultiLine && lines.length > maxLines) {
    // Find which line the cursor is on
    let remaining = cursor;
    let cursorLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i]!.length) {
        cursorLine = i;
        break;
      }
      remaining -= lines[i]!.length + 1;
      if (i === lines.length - 1) {
        cursorLine = i;
      }
    }

    // Window around cursor line
    const half = Math.floor(maxLines / 2);
    let start = Math.max(0, cursorLine - half);
    let end = start + maxLines;
    if (end > lines.length) {
      end = lines.length;
      start = Math.max(0, end - maxLines);
    }

    const windowedLines = lines.slice(start, end);
    displayValue = windowedLines.join("\n");

    // Adjust cursor offset for skipped lines
    let skippedChars = 0;
    for (let i = 0; i < start; i++) {
      skippedChars += lines[i]!.length + 1;
    }
    displayCursor = cursor - skippedChars;
  }

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={isActive ? "#34d399" : "gray"}
      paddingLeft={1}
    >
      {isMultiLine ? (
        <Box flexDirection="column">
          <Text color={isActive ? "#34d399" : "gray"} bold>
            {"› "}
          </Text>
          {/* Padding lines for alignment */}
          {displayValue
            .split("\n")
            .slice(1)
            .map((_, i) => (
              <Text key={i}>{"  "}</Text>
            ))}
        </Box>
      ) : (
        <Text color={isActive ? "#34d399" : "gray"} bold>
          {"› "}
        </Text>
      )}
      <RichTextInput
        value={displayValue}
        cursor={displayCursor}
        placeholder={resolvedPlaceholder}
        isActive={isActive}
      />
    </Box>
  );
}
