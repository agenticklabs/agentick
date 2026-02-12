/**
 * MessageList — displays completed conversation messages.
 *
 * Uses Ink's <Static> for messages that won't re-render (performance critical).
 * Listens for execution_end events. Uses newTimelineEntries (delta) when available,
 * falls back to output.timeline (full replace) for backwards compatibility.
 */

import { useState, useEffect, useCallback } from "react";
import { Static, Box, Text } from "ink";
import { useEvents } from "@agentick/react";
import type { StreamEvent, Message, ContentBlock } from "@agentick/shared";

interface CompletedMessage {
  id: string;
  role: string;
  text: string;
}

function renderContent(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool: ${block.name}]`;
      if (block.type === "tool_result") {
        const resultContent = Array.isArray(block.content)
          ? block.content
              .map((c: ContentBlock) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("")
          : String(block.content ?? "");
        return `[result: ${resultContent.slice(0, 100)}${resultContent.length > 100 ? "…" : ""}]`;
      }
      return `[${block.type}]`;
    })
    .join("");
}

function roleColor(role: string): string {
  switch (role) {
    case "user":
      return "blue";
    case "assistant":
      return "magenta";
    case "system":
      return "gray";
    case "tool_result":
      return "yellow";
    default:
      return "white";
  }
}

type TimelineEntry = { kind?: string; message?: Message };

function timelineToMessages(entries: TimelineEntry[]): CompletedMessage[] {
  return entries
    .filter((entry) => entry.kind === "message" && entry.message)
    .map((entry, i) => {
      const msg = entry.message!;
      return {
        id: msg.id ?? `msg-${i}-${Date.now()}`,
        role: msg.role,
        text: renderContent(msg.content),
      };
    });
}

interface MessageListProps {
  sessionId?: string;
}

export function MessageList({ sessionId }: MessageListProps) {
  const [messages, setMessages] = useState<CompletedMessage[]>([]);
  const { event } = useEvents({
    sessionId,
    filter: ["execution_end"],
  });

  useEffect(() => {
    if (!event || event.type !== "execution_end") return;

    const execEnd = event as StreamEvent & {
      newTimelineEntries?: TimelineEntry[];
      output?: { timeline?: TimelineEntry[] };
    };

    // Prefer delta (append) over full timeline (replace)
    if (execEnd.newTimelineEntries && execEnd.newTimelineEntries.length > 0) {
      const newMessages = timelineToMessages(execEnd.newTimelineEntries);
      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages]);
      }
      return;
    }

    // Fallback: full timeline replace
    const timeline = execEnd.output?.timeline;
    if (Array.isArray(timeline)) {
      setMessages(timelineToMessages(timeline));
    }
  }, [event]);

  const renderMessage = useCallback((msg: CompletedMessage) => {
    // Skip tool_result entries in the message list for cleaner output
    if (msg.role === "tool_result") return null;

    return (
      <Box key={msg.id} flexDirection="column" marginBottom={1}>
        <Text color={roleColor(msg.role)} bold>
          {msg.role}:
        </Text>
        <Box marginLeft={2}>
          <Text wrap="wrap">{msg.text}</Text>
        </Box>
      </Box>
    );
  }, []);

  if (messages.length === 0) return null;

  return <Static items={messages}>{renderMessage}</Static>;
}
