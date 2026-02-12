/**
 * InputBar — user text input for the TUI.
 *
 * Uses ink-text-input. Enter submits, disabled while streaming.
 * Supports controlled mode (value + onChange) or uncontrolled (internal state).
 */

import { useState, useCallback } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarPropsBase {
  onSubmit: (text: string) => void;
  isDisabled?: boolean;
  placeholder?: string;
}

interface ControlledInputBarProps extends InputBarPropsBase {
  value: string;
  onChange: (value: string) => void;
}

interface UncontrolledInputBarProps extends InputBarPropsBase {
  value?: undefined;
  onChange?: undefined;
}

type InputBarProps = ControlledInputBarProps | UncontrolledInputBarProps;

export function InputBar({
  onSubmit,
  isDisabled = false,
  placeholder,
  value,
  onChange,
}: InputBarProps) {
  const isControlled = value !== undefined && onChange !== undefined;
  const [internalValue, setInternalValue] = useState("");

  const currentValue = isControlled ? value : internalValue;
  const handleChange = isControlled ? onChange : setInternalValue;

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim() || isDisabled) return;
      onSubmit(text.trim());
      if (isControlled) {
        onChange("");
      } else {
        setInternalValue("");
      }
    },
    [onSubmit, isDisabled, isControlled, onChange],
  );

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={isDisabled ? "gray" : "cyan"}
      paddingLeft={1}
    >
      <Text color={isDisabled ? "gray" : "green"} bold>
        {"› "}
      </Text>
      <TextInput
        value={currentValue}
        onChange={handleChange}
        onSubmit={handleSubmit}
        focus={!isDisabled}
        placeholder={placeholder ?? (isDisabled ? "Waiting for response..." : "Type a message...")}
      />
    </Box>
  );
}
