/**
 * RichTextInput — renders line editor state with a visible cursor.
 *
 * Pure rendering component. All editing logic lives in useLineEditor.
 */

import { Text } from "ink";

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
