/**
 * ToolConfirmationPrompt — visual-only confirmation UI for tools that require approval.
 *
 * Shows tool name, arguments, and Y/N/A key hints.
 * No internal useInput — the parent orchestrator handles keystrokes
 * and calls respond() directly.
 *
 * When metadata with type "diff" is present, renders a colored diff view
 * instead of raw JSON arguments.
 */

import { Box, Text } from "ink";
import type { ToolConfirmationRequest } from "@agentick/client";
import type { DiffPreviewMetadata } from "@agentick/shared";
import { DiffView } from "./DiffView.js";

interface ToolConfirmationPromptProps {
  request: ToolConfirmationRequest;
}

function isDiffPreview(meta: unknown): meta is DiffPreviewMetadata {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  return m.type === "diff" && typeof m.filePath === "string" && typeof m.patch === "string";
}

function formatArguments(args: Record<string, unknown>): string {
  const json = JSON.stringify(args, null, 2);
  const lines = json.split("\n");
  if (lines.length > 10) {
    return lines.slice(0, 10).join("\n") + "\n  ...";
  }
  return json;
}

export function ToolConfirmationPrompt({ request }: ToolConfirmationPromptProps) {
  const diffMeta = isDiffPreview(request.metadata) ? request.metadata : null;

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
        {diffMeta ? (
          <DiffView patch={diffMeta.patch} filePath={diffMeta.filePath} />
        ) : (
          <Text color="gray">{formatArguments(request.arguments)}</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="row" gap={2}>
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
