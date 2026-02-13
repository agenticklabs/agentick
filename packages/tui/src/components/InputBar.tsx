/**
 * InputBar — user text input for the TUI.
 *
 * Uses useLineEditor for readline-quality editing. Enter submits, disabled
 * while streaming. Supports controlled mode (value + onChange) or uncontrolled.
 */

import { useCallback } from "react";
import { Box, Text } from "ink";
import { useLineEditor } from "../hooks/use-line-editor.js";
import { RichTextInput } from "./RichTextInput.js";

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
  // The hook handles clearing on submit (both controlled via onChange("") and
  // uncontrolled via internal setState). We just forward to the parent.
  const handleSubmit = useCallback(
    (text: string) => {
      if (isDisabled) return;
      onSubmit(text);
    },
    [onSubmit, isDisabled],
  );

  const isControlled = value !== undefined && onChange !== undefined;
  const editorOptions = isControlled
    ? { value, onChange, onSubmit: handleSubmit, isActive: !isDisabled }
    : { onSubmit: handleSubmit, isActive: !isDisabled };

  const editor = useLineEditor(editorOptions);

  const resolvedPlaceholder =
    placeholder ?? (isDisabled ? "Waiting for response..." : "Type a message...");

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={isDisabled ? "gray" : "#34d399"}
      paddingLeft={1}
    >
      <Text color={isDisabled ? "gray" : "#34d399"} bold>
        {"› "}
      </Text>
      <RichTextInput
        value={editor.value}
        cursor={editor.cursor}
        placeholder={resolvedPlaceholder}
        isActive={!isDisabled}
      />
    </Box>
  );
}
