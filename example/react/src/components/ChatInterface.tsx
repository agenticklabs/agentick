/**
 * Chat Interface Component
 *
 * Demonstrates:
 * - useSession for connection management
 * - useStreamingText for real-time response display
 * - send() triggers execution and streaming
 */

import { useState, useRef, useEffect } from "react";
import { useSession, useStreamingText, useEvents } from "@tentickle/react";
import type {
  ContentBlock,
  MediaSource,
  Message,
  ToolResultBlock,
} from "@tentickle/shared";

interface ChatMessage {
  id: number;
  role: Message["role"];
  content: ContentBlock[];
}

export function ChatInterface() {
  const { isConnected, isConnecting, send, error } = useSession();
  const { text, isStreaming, clear: clearStreamingText } = useStreamingText();
  const { event } = useEvents({
    filter: [
      "message",
      "content",
      "tool_call",
      "tool_result",
      "tool_confirmation_required",
      "tool_confirmation_result",
      "error",
      "engine_error",
    ],
  });
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draftBlocks, setDraftBlocks] = useState<ContentBlock[]>([]);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(1);
  const seenEventIdsRef = useRef(new Set<string>());

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, text, isStreaming, draftBlocks]);

  // Apply stream events to chat messages
  useEffect(() => {
    if (!event || seenEventIdsRef.current.has(event.id)) return;
    seenEventIdsRef.current.add(event.id);

    switch (event.type) {
      case "content": {
        // Track non-text blocks for draft rendering
        if (event.content.type !== "text") {
          setDraftBlocks((prev) => [...prev, event.content]);
        }
        break;
      }
      case "message": {
        setDraftBlocks([]);
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: event.message.role,
            content: event.message.content,
          },
        ]);
        break;
      }
      case "tool_call": {
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: "tool",
            content: [
              {
                type: "tool_use",
                toolUseId: event.callId,
                name: event.name,
                input: event.input,
              },
            ],
          },
        ]);
        break;
      }
      case "tool_result": {
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: "tool",
            content: [
              {
                type: "tool_result",
                toolUseId: event.callId,
                name: event.name,
                content: normalizeToolResult(event.result),
                isError: event.isError,
                executedBy: event.executedBy,
              } as ToolResultBlock,
            ],
          },
        ]);
        break;
      }
      case "tool_confirmation_required": {
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: "event",
            content: [
              {
                type: "system_event",
                event: "tool_confirmation_required",
                data: {
                  name: event.name,
                  callId: event.callId,
                  input: event.input,
                },
                text: event.message,
              },
            ],
          },
        ]);
        break;
      }
      case "tool_confirmation_result": {
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: "event",
            content: [
              {
                type: "system_event",
                event: "tool_confirmation_result",
                data: {
                  callId: event.callId,
                  confirmed: event.confirmed,
                  always: event.always,
                },
                text: event.confirmed
                  ? "Tool execution confirmed."
                  : "Tool execution denied.",
              },
            ],
          },
        ]);
        break;
      }
      case "error":
      case "engine_error": {
        setMessages((prev) => [
          ...prev,
          {
            id: nextIdRef.current++,
            role: "event",
            content: [
              {
                type: "system_event",
                event: event.type,
                data: event.error,
                text: event.error.message,
              },
            ],
          },
        ]);
        break;
      }
      default:
        break;
    }
  }, [event]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = input.trim();
    if (!trimmed || isSending || !isConnected) return;

    setIsSending(true);
    setInput("");
    setDraftBlocks([]);
    clearStreamingText();

    // Add user message
    const userMessage: ChatMessage = {
      id: nextIdRef.current++,
      role: "user",
      content: [{ type: "text", text: trimmed }],
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      // Send message (server triggers execution)
      await send(trimmed);
    } catch (err) {
      console.error("Failed to send message:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: nextIdRef.current++,
          role: "event",
          content: [
            {
              type: "system_event",
              event: "send_error",
              data: { message: err instanceof Error ? err.message : "Unknown error" },
              text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
            <p>Welcome! Ask me to manage your tasks or do calculations.</p>
            <p style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
              Try: "Add a task to buy groceries" or "What is 42 * 17?"
            </p>
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
        )}
        {(isSending || isStreaming) && (
          <MessageBubble
            message={{
              id: 0,
              role: "assistant",
              content: [
                ...draftBlocks,
                { type: "text" as const, text: text || "Thinking..." },
              ],
            }}
            isDraft
            isStreaming={isStreaming}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <form className="chat-input-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isConnected
                ? "Type a message..."
                : isConnecting
                  ? "Connecting..."
                  : "Disconnected"
            }
            disabled={!isConnected || isSending}
          />
          <button
            type="submit"
            className="chat-send-btn"
            disabled={!isConnected || isSending || !input.trim()}
          >
            {isSending ? "..." : "Send"}
          </button>
        </form>

        <div className="chat-status">
          <span className={`status-dot ${isConnected ? "connected" : ""}`} />
          <span>
            {isConnecting
              ? "Connecting..."
              : isConnected
                ? "Connected"
                : error
                  ? `Error: ${error.message}`
                  : "Disconnected"}
          </span>
        </div>
      </div>
    </>
  );
}

function MessageBubble({
  message,
  isDraft = false,
  isStreaming = false,
}: {
  message: ChatMessage;
  isDraft?: boolean;
  isStreaming?: boolean;
}) {
  const roleLabel =
    message.role === "user"
      ? "You"
      : message.role === "tool"
        ? "Tool"
        : message.role === "event"
          ? "Event"
          : "Assistant";
  const roleClass =
    message.role === "user"
      ? "user"
      : message.role === "tool"
        ? "tool"
        : message.role === "event"
          ? "event"
          : "assistant";

  return (
    <div className={`chat-message ${roleClass} ${isDraft ? "draft" : ""}`}>
      <div className="chat-message-role">{roleLabel}</div>
      <div className="chat-message-content">
        <ContentBlockList blocks={message.content} />
        {isStreaming && <span className="streaming-indicator" />}
      </div>
    </div>
  );
}

function ContentBlockList({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="chat-blocks">
      {blocks.map((block, index) => (
        <div key={block.id ?? `${block.type}-${index}`} className="chat-block">
          {renderBlock(block)}
        </div>
      ))}
    </div>
  );
}

function renderBlock(block: ContentBlock) {
  switch (block.type) {
    case "text":
      return <p className="block-text">{block.text}</p>;
    case "reasoning":
      return <pre className="block-reasoning">{block.text}</pre>;
    case "json":
      return <pre className="block-json">{block.text ?? formatJson(block.data)}</pre>;
    case "xml":
    case "csv":
    case "html":
      return <pre className="block-data">{block.text}</pre>;
    case "code":
      return (
        <pre className="block-code">
          <code>{block.text}</code>
        </pre>
      );
    case "image": {
      const src = getMediaSourceUrl(block.source, block.mimeType);
      if (src) {
        return (
          <figure className="block-media">
            <img src={src} alt={block.altText ?? "Image"} />
            {block.altText && <figcaption>{block.altText}</figcaption>}
          </figure>
        );
      }
      return <div className="block-fallback">Image source unavailable.</div>;
    }
    case "generated_image": {
      const src = `data:${block.mimeType};base64,${block.data}`;
      return (
        <figure className="block-media">
          <img src={src} alt={block.altText ?? "Generated image"} />
          {block.altText && <figcaption>{block.altText}</figcaption>}
        </figure>
      );
    }
    case "document": {
      const src = getMediaSourceUrl(block.source, block.mimeType);
      return src ? (
        <a className="block-link" href={src} target="_blank" rel="noreferrer">
          Open document
        </a>
      ) : (
        <div className="block-fallback">Document source unavailable.</div>
      );
    }
    case "audio": {
      const src = getMediaSourceUrl(block.source, block.mimeType);
      return src ? (
        <div className="block-media">
          <audio controls src={src} />
          {block.transcript && <div className="block-caption">{block.transcript}</div>}
        </div>
      ) : (
        <div className="block-fallback">Audio source unavailable.</div>
      );
    }
    case "video": {
      const src = getMediaSourceUrl(block.source, block.mimeType);
      return src ? (
        <div className="block-media">
          <video controls src={src} />
          {block.transcript && <div className="block-caption">{block.transcript}</div>}
        </div>
      ) : (
        <div className="block-fallback">Video source unavailable.</div>
      );
    }
    case "tool_use":
      return (
        <div className="block-tool">
          <div className="block-tool-title">Tool call: {block.name}</div>
          <pre>{formatJson(block.input)}</pre>
        </div>
      );
    case "tool_result":
      return (
        <div className={`block-tool ${block.isError ? "is-error" : ""}`}>
          <div className="block-tool-title">Tool result: {block.name}</div>
          <ContentBlockList blocks={block.content} />
        </div>
      );
    case "generated_file":
      return (
        <a className="block-link" href={block.uri} target="_blank" rel="noreferrer">
          {block.displayName ?? "Generated file"}
        </a>
      );
    case "executable_code":
      return (
        <pre className="block-code">
          <code>{block.code}</code>
        </pre>
      );
    case "code_execution_result":
      return (
        <pre className={`block-code ${block.isError ? "is-error" : ""}`}>
          <code>{block.output}</code>
        </pre>
      );
    case "user_action":
    case "system_event":
    case "state_change":
      return (
        <div className="block-event">
          {block.text ?? formatJson(block)}
        </div>
      );
    default:
      return <pre className="block-data">{formatJson(block)}</pre>;
  }
}

function getMediaSourceUrl(source: MediaSource, mimeType?: string) {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64":
      return `data:${mimeType ?? source.mimeType ?? "application/octet-stream"};base64,${source.data}`;
    default:
      return undefined;
  }
}

function normalizeToolResult(result: unknown): ContentBlock[] {
  if (Array.isArray(result) && result.every((item) => item && typeof item === "object" && "type" in item)) {
    return result as ContentBlock[];
  }
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content) && content.every((item) => item && typeof item === "object" && "type" in item)) {
      return content as ContentBlock[];
    }
  }
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  return [{ type: "json", text: formatJson(result), data: result }];
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
