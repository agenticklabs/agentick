/**
 * MessageList — displays conversation messages.
 *
 * Accepts messages from useChat and splits them into:
 * - Committed messages → Ink's <Static> (rendered once, never updated)
 * - In-progress message → regular render (updates as blocks complete)
 *
 * When not executing, all messages are committed.
 * When executing, the last message may still be receiving blocks.
 */

import { useCallback, useRef } from "react";
import { Static, Box, Text } from "ink";
import type { ChatMessage } from "@agentick/client";
import type { ContentBlock } from "@agentick/shared";

function renderContent(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "reasoning")
        return `[thinking: ${block.text.slice(0, 80)}${block.text.length > 80 ? "..." : ""}]`;
      if (block.type === "tool_use") return `[tool: ${block.name}]`;
      if (block.type === "tool_result") {
        const resultContent = Array.isArray(block.content)
          ? block.content
              .map((c: ContentBlock) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("")
          : String(block.content ?? "");
        return `[result: ${resultContent.slice(0, 100)}${resultContent.length > 100 ? "..." : ""}]`;
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
    default:
      return "white";
  }
}

function MessageItem({ message }: { message: ChatMessage }) {
  const text = renderContent(message.content);
  if (!text) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={roleColor(message.role)} bold>
        {message.role}:
      </Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{text}</Text>
      </Box>
    </Box>
  );
}

interface MessageListProps {
  messages: readonly ChatMessage[];
  isExecuting: boolean;
}

export function MessageList({ messages, isExecuting }: MessageListProps) {
  // Track which message IDs have been committed to Static.
  // Once committed, a message never leaves Static.
  const committedIdsRef = useRef(new Set<string>());

  // Committed: all messages except the last one when executing
  // (the last message may still be receiving blocks)
  const splitIndex = isExecuting && messages.length > 0 ? messages.length - 1 : messages.length;

  // Mark messages as committed
  for (let i = 0; i < splitIndex; i++) {
    committedIdsRef.current.add(messages[i].id);
  }

  // Build stable committed array (only messages we've committed)
  const committed = messages.filter((m) => committedIdsRef.current.has(m.id));
  const inProgress =
    isExecuting &&
    messages.length > 0 &&
    !committedIdsRef.current.has(messages[messages.length - 1].id)
      ? messages[messages.length - 1]
      : null;

  const renderMessage = useCallback(
    (msg: ChatMessage) => <MessageItem key={msg.id} message={msg} />,
    [],
  );

  return (
    <>
      {committed.length > 0 && <Static items={committed}>{renderMessage}</Static>}
      {inProgress && <MessageItem message={inProgress} />}
    </>
  );
}
