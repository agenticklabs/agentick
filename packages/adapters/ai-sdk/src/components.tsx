/**
 * AI SDK-specific JSX components
 *
 * These wrap core Tentickle components with ai-sdk-native interfaces.
 * Users can use the same mental model as ai-sdk's message format.
 */

import { createElement, type JSX } from "@tentickle/core/jsx-runtime";
import {
  Message as CoreMessage,
  Timeline as CoreTimeline,
  System as CoreSystem,
  type MessageProps as CoreMessageProps,
} from "@tentickle/core/jsx";
import type { ContentBlock, Message as MessageType } from "@tentickle/shared";

// ============================================================================
// Types - AI SDK Message Format
// ============================================================================

/**
 * AI SDK compatible message content.
 * Supports string (simple text) or content parts array.
 */
export type AiSdkContent = string | AiSdkContentPart[];

/**
 * AI SDK content part types we support.
 */
export type AiSdkContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | Uint8Array; mimeType?: string }
  | { type: "file"; data: string | Uint8Array; mimeType: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    };

/**
 * Props for ai-sdk-style Message component.
 * Uses ai-sdk's role and content format.
 */
export interface MessageProps extends CoreMessageProps {
  /** Message role - matches ai-sdk roles */
  role: "system" | "user" | "assistant" | "tool";

  /** Message content - string or content parts */
  content: AiSdkContent;

  /** Children (alternative to content prop) */
  children?: JSX.Element | JSX.Element[];
}

/**
 * Props for ai-sdk-style ToolResult component.
 */
export interface ToolResultProps {
  /** Tool call ID this result corresponds to */
  toolCallId: string;

  /** Tool name */
  toolName: string;

  /** Result content */
  result: unknown;

  /** Whether this is an error result */
  isError?: boolean;
}

// ============================================================================
// Content Conversion
// ============================================================================

/**
 * Convert ai-sdk content to tentickle ContentBlock[].
 */
function toContentBlocks(content: AiSdkContent): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text } as ContentBlock;

      case "image":
        if (typeof part.image === "string") {
          // URL or base64 string
          if (part.image.startsWith("http")) {
            return {
              type: "image",
              source: { type: "url", url: part.image },
              mimeType: part.mimeType,
            } as ContentBlock;
          } else {
            return {
              type: "image",
              source: { type: "base64", data: part.image },
              mimeType: part.mimeType,
            } as ContentBlock;
          }
        } else {
          // Uint8Array
          const base64 = Buffer.from(part.image).toString("base64");
          return {
            type: "image",
            source: { type: "base64", data: base64 },
            mimeType: part.mimeType,
          } as ContentBlock;
        }

      case "file":
        if (typeof part.data === "string") {
          return {
            type: "document",
            source: { type: "base64", data: part.data },
            mimeType: part.mimeType,
          } as ContentBlock;
        } else {
          const base64 = Buffer.from(part.data).toString("base64");
          return {
            type: "document",
            source: { type: "base64", data: base64 },
            mimeType: part.mimeType,
          } as ContentBlock;
        }

      case "tool-call":
        return {
          type: "tool_use",
          toolUseId: part.toolCallId,
          name: part.toolName,
          input: part.args,
        } as ContentBlock;

      case "tool-result":
        return {
          type: "tool_result",
          toolUseId: part.toolCallId,
          name: part.toolName,
          content:
            typeof part.result === "string"
              ? [{ type: "text", text: part.result }]
              : [{ type: "json", text: JSON.stringify(part.result), data: part.result }],
          isError: part.isError,
        } as ContentBlock;

      default:
        // Unknown type - convert to text
        return { type: "text", text: JSON.stringify(part) } as ContentBlock;
    }
  });
}

/**
 * Map ai-sdk role to tentickle role.
 */
function toAidkRole(role: MessageProps["role"]): MessageType["role"] {
  switch (role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return "user";
  }
}

// ============================================================================
// Components
// ============================================================================

/**
 * AI SDK-style Message component.
 *
 * Provides a familiar interface for ai-sdk users while mapping
 * to tentickle's internal timeline entry format.
 *
 * @example Simple text message
 * ```tsx
 * <Message role="user" content="Hello, world!" />
 * ```
 *
 * @example Multi-part content
 * ```tsx
 * <Message
 *   role="user"
 *   content={[
 *     { type: 'text', text: 'What is in this image?' },
 *     { type: 'image', image: 'https://example.com/image.png' },
 *   ]}
 * />
 * ```
 *
 * @example Tool result
 * ```tsx
 * <Message
 *   role="tool"
 *   content={[
 *     { type: 'tool-result', toolCallId: 'call_123', toolName: 'get_weather', result: { temp: 72 } }
 *   ]}
 * />
 * ```
 */
export function Message(props: MessageProps): JSX.Element {
  const { role, content, children } = props;

  // Map to core Message props
  const coreProps: CoreMessageProps = {
    ...props,
    role: toAidkRole(role),
    content: toContentBlocks(content),
    children,
  };

  return createElement(CoreMessage, coreProps);
}

/**
 * AI SDK-style System message component.
 *
 * Convenience wrapper for system messages.
 *
 * @example
 * ```tsx
 * <System>You are a helpful assistant.</System>
 * ```
 *
 * @example With content prop
 * ```tsx
 * <System content="You are a helpful assistant." />
 * ```
 */
export function System(props: { content?: string; children?: JSX.Element | string }): JSX.Element {
  const { content, children } = props;

  // Use content prop or extract text from children
  if (content) {
    return createElement(CoreSystem, { content });
  }

  return createElement(CoreSystem, {}, children);
}

/**
 * AI SDK-style User message component.
 *
 * Convenience wrapper for user messages.
 *
 * @example
 * ```tsx
 * <User>What is the weather?</User>
 * ```
 */
export function User(props: {
  content?: AiSdkContent;
  children?: JSX.Element | string;
}): JSX.Element {
  return createElement(Message, {
    role: "user",
    content: props.content || (typeof props.children === "string" ? props.children : ""),
    children: typeof props.children === "string" ? undefined : props.children,
  });
}

/**
 * AI SDK-style Assistant message component.
 *
 * Convenience wrapper for assistant messages.
 *
 * @example
 * ```tsx
 * <Assistant>The weather is sunny and 72°F.</Assistant>
 * ```
 */
export function Assistant(props: {
  content?: AiSdkContent;
  children?: JSX.Element | string;
}): JSX.Element {
  return createElement(Message, {
    role: "assistant",
    content: props.content || (typeof props.children === "string" ? props.children : ""),
    children: typeof props.children === "string" ? undefined : props.children,
  });
}

/**
 * AI SDK-style ToolResult component.
 *
 * Creates a tool result message.
 *
 * @example
 * ```tsx
 * <ToolResult
 *   toolCallId="call_123"
 *   toolName="get_weather"
 *   result={{ temperature: 72, conditions: 'sunny' }}
 * />
 * ```
 */
export function ToolResult(props: ToolResultProps): JSX.Element {
  const content: AiSdkContentPart[] = [
    {
      type: "tool-result",
      toolCallId: props.toolCallId,
      toolName: props.toolName,
      result: props.result,
      isError: props.isError,
    },
  ];

  return createElement(Message, { role: "tool", content });
}

/**
 * Re-export Timeline from core (no transformation needed).
 */
export { CoreTimeline as Timeline };
