/**
 * StreamingMessage — shows the live model response while streaming.
 *
 * Uses useStreamingText() from @agentick/react.
 */

import { Box, Text } from "ink";
import { useStreamingText } from "@agentick/react";

export function StreamingMessage() {
  const { text, isStreaming } = useStreamingText();

  if (!isStreaming && !text) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta" bold>
        assistant:
      </Text>
      <Box marginLeft={2}>
        <Text>
          {text}
          {isStreaming ? <Text color="cyan">▊</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
