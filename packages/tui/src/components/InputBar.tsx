/**
 * InputBar — visual-only user text input for the TUI.
 *
 * Renders value/cursor state passed from the parent. No internal useInput
 * or useLineEditor — the parent orchestrator owns all input routing.
 */

import { Box, Text } from "ink";
import { RichTextInput } from "./RichTextInput.js";

export interface InputBarProps {
  value: string;
  cursor: number;
  isActive?: boolean;
  placeholder?: string;
}

export function InputBar({ value, cursor, isActive = true, placeholder }: InputBarProps) {
  const resolvedPlaceholder =
    placeholder ?? (isActive ? "Type a message..." : "Waiting for response...");

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={isActive ? "#34d399" : "gray"}
      paddingLeft={1}
    >
      <Text color={isActive ? "#34d399" : "gray"} bold>
        {"› "}
      </Text>
      <RichTextInput
        value={value}
        cursor={cursor}
        placeholder={resolvedPlaceholder}
        isActive={isActive}
      />
    </Box>
  );
}
