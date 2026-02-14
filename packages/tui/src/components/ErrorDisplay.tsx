/**
 * ErrorDisplay — visual-only error display for the TUI.
 *
 * Red bordered box with error message. No internal useInput —
 * the parent orchestrator handles dismissal keystrokes.
 */

import { Box, Text } from "ink";

export interface ErrorDisplayProps {
  error: Error | string | null;
  showDismissHint?: boolean;
}

export function ErrorDisplay({ error, showDismissHint = false }: ErrorDisplayProps) {
  if (!error) return null;

  const message = error instanceof Error ? error.message : error;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
      <Text color="red" bold>
        Error
      </Text>
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      {showDismissHint && (
        <Box marginTop={1}>
          <Text color="gray">Press any key to dismiss</Text>
        </Box>
      )}
    </Box>
  );
}
