import type { ContentBlock, TimelineEntry } from "@agentick/shared";
import type {
  ChatMessage,
  ChatMode,
  ToolCallEntry,
  MessageTransform,
  MessageTransformContext,
} from "./chat-types.js";

export function extractToolCalls(content: ContentBlock[]): ToolCallEntry[] {
  return content
    .filter(
      (b): b is ContentBlock & { type: "tool_use"; id: string; name: string } =>
        b.type === "tool_use",
    )
    .map((b) => ({
      id: b.id,
      name: b.name,
      status: "done" as const,
    }));
}

export function timelineToMessages(
  entries: TimelineEntry[],
  toolDurations: ReadonlyMap<string, number>,
): ChatMessage[] {
  return entries
    .filter(
      (entry) =>
        entry.kind === "message" &&
        entry.message &&
        (entry.message.role === "user" || entry.message.role === "assistant"),
    )
    .map((entry, i) => {
      const msg = entry.message!;
      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = msg.role === "assistant" ? extractToolCalls(contentBlocks) : undefined;

      const toolCallsWithDurations = toolCalls?.map((tc) => ({
        ...tc,
        duration: toolDurations.get(tc.id),
      }));

      return {
        id: msg.id ?? `msg-${i}`,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        toolCalls:
          toolCallsWithDurations && toolCallsWithDurations.length > 0
            ? toolCallsWithDurations
            : undefined,
      };
    });
}

/** Default MessageTransform — delegates to timelineToMessages. */
export const defaultTransform: MessageTransform = (
  entries: TimelineEntry[],
  context: MessageTransformContext,
): ChatMessage[] => {
  return timelineToMessages(entries, context.toolDurations);
};

/** Default ChatMode derivation. Exported for users who want to extend it. */
export function defaultDeriveMode(input: {
  isExecuting: boolean;
  hasPendingConfirmation: boolean;
}): ChatMode {
  if (input.hasPendingConfirmation) return "confirming_tool";
  if (input.isExecuting) return "streaming";
  return "idle";
}
