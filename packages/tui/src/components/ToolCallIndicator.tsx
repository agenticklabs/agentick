/**
 * ToolCallIndicator — shows tool execution feedback.
 *
 * Shows a spinner + tool name during execution,
 * completed indicator when done.
 */

import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEvents } from "@agentick/react";
import type { StreamEvent } from "@agentick/shared";

interface ActiveTool {
  id: string;
  name: string;
  status: "running" | "done";
}

interface ToolCallIndicatorProps {
  sessionId?: string;
}

export function ToolCallIndicator({ sessionId }: ToolCallIndicatorProps) {
  const [tools, setTools] = useState<ActiveTool[]>([]);
  const { event } = useEvents({
    sessionId,
    filter: ["tool_call_start", "tool_call", "tool_result"],
  });

  useEffect(() => {
    if (!event) return;

    if (event.type === "tool_call_start" || event.type === "tool_call") {
      const e = event as StreamEvent & { toolUseId?: string; name?: string; id?: string };
      const id = e.toolUseId ?? e.id ?? "unknown";
      const name = e.name ?? "tool";
      setTools((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [...prev, { id, name, status: "running" }];
      });
    }

    if (event.type === "tool_result") {
      const e = event as StreamEvent & { toolUseId?: string };
      const id = e.toolUseId ?? "unknown";
      setTools((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done" } : t)));
    }
  }, [event]);

  // Clean up completed tools after a short delay
  useEffect(() => {
    const allDone = tools.length > 0 && tools.every((t) => t.status === "done");
    if (allDone) {
      const timer = setTimeout(() => setTools([]), 1500);
      return () => clearTimeout(timer);
    }
  }, [tools]);

  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {tools.map((tool) => (
        <Box key={tool.id} gap={1}>
          {tool.status === "running" ? (
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color="green">✓</Text>
          )}
          <Text
            color={tool.status === "running" ? "yellow" : "gray"}
            dimColor={tool.status === "done"}
          >
            {tool.name}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
