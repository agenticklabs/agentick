/**
 * OpenAI Message Transform
 *
 * Pure functions for converting between OpenAI chat completion messages
 * and agentick's Message/ContentBlock types.
 */

import type { Message, ContentBlock } from "@agentick/shared";

// ============================================================================
// OpenAI Types (just what we need — no dependency on openai package)
// ============================================================================

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

// ============================================================================
// OpenAI → Agentick
// ============================================================================

export function fromOpenAIMessages(messages: OpenAIMessage[]): Message[] {
  return messages.map(fromOpenAIMessage);
}

function fromOpenAIMessage(msg: OpenAIMessage): Message {
  switch (msg.role) {
    case "system":
      return {
        role: "system",
        content: [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }],
      };

    case "user":
      return {
        role: "user",
        content: fromOpenAIUserContent(msg.content),
      };

    case "assistant":
      return {
        role: "assistant",
        content: fromOpenAIAssistantContent(msg),
      };

    case "tool":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: msg.tool_call_id ?? "",
            name: msg.name ?? "",
            content: [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }],
          } satisfies ContentBlock as ContentBlock,
        ],
      };
  }
}

function fromOpenAIUserContent(
  content: string | OpenAIContentPart[] | null | undefined,
): ContentBlock[] {
  if (!content) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];

  return content.map((part): ContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text ?? "" };
    if (part.type === "image_url" && part.image_url) {
      return {
        type: "image",
        source: { type: "url", url: part.image_url.url },
      } as ContentBlock;
    }
    return { type: "text", text: "" };
  });
}

function fromOpenAIAssistantContent(msg: OpenAIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (msg.content) {
    const text = typeof msg.content === "string" ? msg.content : "";
    if (text) blocks.push({ type: "text", text });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      } as ContentBlock);
    }
  }

  return blocks;
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ============================================================================
// Agentick → OpenAI
// ============================================================================

export function toOpenAITools(tools: OpenAIToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input,
    },
  }));
}
