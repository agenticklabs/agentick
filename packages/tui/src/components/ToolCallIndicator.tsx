/**
 * ToolCallIndicator — shows tool execution feedback.
 *
 * Four states per tool:
 * - queued: model requested this tool (spinner, yellow)
 * - executing: tool handler has started (spinner, cyan)
 * - done: result received (checkmark, green)
 * - error: tool failed or execution crashed (✗, red)
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
  ExecutionEndEvent,
} from "@agentick/shared";

type ToolStatus = "queued" | "executing" | "done" | "error";

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
  const { events } = useEvents({
    sessionId,
    filter: ["tool_call_start", "tool_call", "tool_result_start", "tool_result", "execution_end"],
  });

  useEffect(() => {
    for (const event of events) {
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
        const status = e.isError ? "error" : "done";
        setTools((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
      }

      if (event.type === "execution_end") {
        const e = event as ExecutionEndEvent;
        if (e.error || e.aborted) {
          setTools((prev) =>
            prev.map((t) =>
              t.status === "queued" || t.status === "executing" ? { ...t, status: "error" } : t,
            ),
          );
        }
      }
    }
  }, [events]);

  // Clean up completed tools after a short delay
  useEffect(() => {
    const allTerminal =
      tools.length > 0 && tools.every((t) => t.status === "done" || t.status === "error");
    if (allTerminal) {
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
          ) : tool.status === "error" ? (
            <Text color="red">✗</Text>
          ) : (
            <Text color={tool.status === "executing" ? "cyan" : "yellow"}>
              <Spinner type="dots" />
            </Text>
          )}
          <Text
            color={
              tool.status === "done"
                ? "gray"
                : tool.status === "error"
                  ? "red"
                  : tool.status === "executing"
                    ? "cyan"
                    : "yellow"
            }
            dimColor={tool.status === "done" || tool.status === "error"}
          >
            {tool.name}
          </Text>
          {tool.summary && <Text dimColor>{tool.summary}</Text>}
        </Box>
      ))}
    </Box>
  );
}
