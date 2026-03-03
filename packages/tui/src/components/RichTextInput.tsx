/**
 * RichTextInput — renders line editor state with a visible cursor.
 *
 * Supports multi-line values: splits on `\n`, renders each line as a
 * separate `<Text>`, and places the inverse cursor on the correct line
 * at the correct column.
 *
 * Pure rendering component. All editing logic lives in useLineEditor.
 */

import { Box, Text } from "ink";

interface RichTextInputProps {
  value: string;
  cursor: number;
  placeholder?: string;
  isActive?: boolean;
}

export function RichTextInput({ value, cursor, placeholder, isActive = true }: RichTextInputProps) {
  if (!isActive) {
    return <Text dimColor>{placeholder ?? ""}</Text>;
  }

  if (value.length === 0) {
    if (placeholder) {
      // Show cursor on first char of placeholder, rest dimmed
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse> </Text>;
  }

  const lines = value.split("\n");

  // Single-line fast path
  if (lines.length === 1) {
    const before = value.slice(0, cursor);
    const cursorChar = cursor < value.length ? value[cursor] : " ";
    const after = cursor < value.length ? value.slice(cursor + 1) : "";

    return (
      <Text>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  }

  // Multi-line: find which line the cursor is on
  let remaining = cursor;
  let cursorLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i]!.length) {
      cursorLine = i;
      break;
    }
    remaining -= lines[i]!.length + 1; // +1 for the \n
    if (i === lines.length - 1) {
      cursorLine = i;
    }
  }
  const cursorCol = remaining;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (i !== cursorLine) {
          return <Text key={i}>{line || " "}</Text>;
        }
        const before = line.slice(0, cursorCol);
        const cursorChar = cursorCol < line.length ? line[cursorCol] : " ";
        const after = cursorCol < line.length ? line.slice(cursorCol + 1) : "";
        return (
          <Text key={i}>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
}
