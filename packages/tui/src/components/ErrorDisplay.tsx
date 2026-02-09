/**
 * ErrorDisplay — shows errors that occur during execution.
 *
 * Red bordered box with error message. Optional dismiss handler.
 */

import { Box, Text, useInput } from "ink";

interface ErrorDisplayProps {
  error: Error | string | null;
  onDismiss?: () => void;
}

export function ErrorDisplay({ error, onDismiss }: ErrorDisplayProps) {
  useInput(
    () => {
      onDismiss?.();
    },
    { isActive: !!onDismiss && !!error },
  );

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
      {onDismiss && (
        <Box marginTop={1}>
          <Text color="gray">Press any key to dismiss</Text>
        </Box>
      )}
    </Box>
  );
}
