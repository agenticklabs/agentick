/**
 * ToolCallIndicator — shows tool execution feedback.
 *
 * Three states per tool:
 * - queued: model requested this tool (spinner, yellow)
 * - executing: tool handler has started (spinner, cyan)
 * - done: result received (checkmark, green)
 */

import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEvents } from "@agentick/react";
import type {
  ToolCallEvent,
  ToolCallStartEvent,
  ToolResultStartEvent,
  ToolResultEvent,
} from "@agentick/shared";

type ToolStatus = "queued" | "executing" | "done";

interface ActiveTool {
  id: string;
  name: string;
  summary?: string;
  status: ToolStatus;
}

interface ToolCallIndicatorProps {
  sessionId?: string;
}

export function ToolCallIndicator({ sessionId }: ToolCallIndicatorProps) {
  const [tools, setTools] = useState<ActiveTool[]>([]);
  const { event } = useEvents({
    sessionId,
    filter: ["tool_call_start", "tool_call", "tool_result_start", "tool_result"],
  });

  useEffect(() => {
    if (!event) return;

    if (event.type === "tool_call_start" || event.type === "tool_call") {
      let e: ToolCallStartEvent | ToolCallEvent;
      if (event.type === "tool_call_start") {
        e = event as ToolCallStartEvent;
      } else {
        e = event as ToolCallEvent;
      }
      const id = e.callId ?? "unknown";
      const name = e.name ?? "tool";
      const summary = event.type === "tool_call" ? (e as ToolCallEvent).summary : undefined;
      setTools((prev) => {
        const existing = prev.find((t) => t.id === id);
        if (existing) {
          // tool_call arrives after tool_call_start with the summary — merge it
          if (summary && !existing.summary) {
            return prev.map((t) => (t.id === id ? { ...t, summary } : t));
          }
          return prev;
        }
        return [...prev, { id, name, summary, status: "queued" }];
      });
    }

    if (event.type === "tool_result_start") {
      const e = event as ToolResultStartEvent;
      const id = e.callId ?? "unknown";
      setTools((prev) => prev.map((t) => (t.id === id ? { ...t, status: "executing" } : t)));
    }

    if (event.type === "tool_result") {
      const e = event as ToolResultEvent;
      const id = e.callId ?? "unknown";
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
        <Box key={tool.id} gap={1} flexDirection="row">
          {tool.status === "done" ? (
            <Text color="green">✓</Text>
          ) : (
            <Text color={tool.status === "executing" ? "cyan" : "yellow"}>
              <Spinner type="dots" />
            </Text>
          )}
          <Text
            color={
              tool.status === "done" ? "gray" : tool.status === "executing" ? "cyan" : "yellow"
            }
            dimColor={tool.status === "done"}
          >
            {tool.name}
          </Text>
          {tool.summary && <Text dimColor>{tool.summary}</Text>}
        </Box>
      ))}
    </Box>
  );
}
