/**
 * ToolConfirmationPrompt — inline confirmation UI for tools that require approval.
 *
 * Shows tool name, arguments, and Y/N/A key bindings.
 * Renders as a bordered box inline in the terminal (no overlays).
 */

import { Box, Text, useInput } from "ink";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/client";

interface ToolConfirmationPromptProps {
  request: ToolConfirmationRequest;
  onRespond: (response: ToolConfirmationResponse) => void;
}

function formatArguments(args: Record<string, unknown>): string {
  const json = JSON.stringify(args, null, 2);
  const lines = json.split("\n");
  if (lines.length > 10) {
    return lines.slice(0, 10).join("\n") + "\n  ...";
  }
  return json;
}

export function ToolConfirmationPrompt({ request, onRespond }: ToolConfirmationPromptProps) {
  useInput((input) => {
    const key = input.toLowerCase();
    if (key === "y") {
      onRespond({ approved: true });
    } else if (key === "n") {
      onRespond({ approved: false, reason: "rejected by user" });
    } else if (key === "a") {
      // "Always allow" — for now just approves (no persistence, YAGNI)
      onRespond({ approved: true });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        Tool Confirmation
      </Text>

      <Box marginTop={1}>
        <Text>
          <Text bold>{request.name}</Text> wants to run:
        </Text>
      </Box>

      {request.message && (
        <Box marginTop={1}>
          <Text color="gray">{request.message}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">{formatArguments(request.arguments)}</Text>
      </Box>

      <Box marginTop={1} gap={2}>
        <Text color="green" bold>
          [Y] Approve
        </Text>
        <Text color="red" bold>
          [N] Reject
        </Text>
        <Text color="cyan" bold>
          [A] Always Allow
        </Text>
      </Box>
    </Box>
  );
}
