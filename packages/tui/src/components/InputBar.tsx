/**
 * InputBar — user text input for the TUI.
 *
 * Uses ink-text-input. Enter submits, disabled while streaming.
 */

import { useState, useCallback } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  onSubmit: (text: string) => void;
  isDisabled?: boolean;
  placeholder?: string;
}

export function InputBar({ onSubmit, isDisabled = false, placeholder }: InputBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim() || isDisabled) return;
      onSubmit(text.trim());
      setValue("");
    },
    [onSubmit, isDisabled],
  );

  return (
    <Box borderStyle="single" borderColor={isDisabled ? "gray" : "cyan"} paddingLeft={1}>
      <Text color={isDisabled ? "gray" : "green"} bold>
        {"› "}
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        focus={!isDisabled}
        placeholder={placeholder ?? (isDisabled ? "Waiting for response..." : "Type a message...")}
      />
    </Box>
  );
}
