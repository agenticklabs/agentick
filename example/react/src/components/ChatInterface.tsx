/**
 * Chat Interface Component
 *
 * Uses useChat for message lifecycle (accumulation, dedup, tool durations),
 * useStreamingText for real-time model output, and useConnection/useContextInfo
 * for status display.
 *
 * History is loaded from the server before mounting the chat to seed
 * initialMessages — useChat handles everything after that.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import {
  useChat,
  useConnection,
  useStreamingText,
  useContextInfo,
  type ChatMessage,
} from "@agentick/react";
import type { ContentBlock, MediaSource, ToolResultBlock } from "@agentick/shared";

const SESSION_ID = "default";

async function invoke(method: string, params: Record<string, unknown>) {
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  return res.json();
}

/**
 * Loads session history, then mounts the chat UI.
 * useChat captures initialMessages at mount time, so history must be
 * available before ChatInner renders.
 */
export function ChatInterface() {
  const [initialMessages, setInitialMessages] = useState<ChatMessage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await invoke("sessions:create", { sessionId: SESSION_ID });
        const data = (await invoke("sessions:get", { sessionId: SESSION_ID })) as {
          timeline?: Array<{
            kind?: string;
            message?: { id?: string; role: string; content: unknown };
          }>;
        };
        const timeline = Array.isArray(data.timeline) ? data.timeline : [];
        const messages: ChatMessage[] = timeline
          .filter((e) => e.kind === "message" && e.message)
          .filter((e) => e.message!.role === "user" || e.message!.role === "assistant")
          .map((e, i) => ({
            id: e.message!.id ?? `msg-${i}`,
            role: e.message!.role as "user" | "assistant",
            content: e.message!.content as string | ContentBlock[],
          }));
        if (!cancelled) setInitialMessages(messages);
      } catch {
        if (!cancelled) setInitialMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!initialMessages) {
    return (
      <div className="chat-messages">
        <p style={{ textAlign: "center", opacity: 0.5, marginTop: "2rem" }}>Loading session...</p>
      </div>
    );
  }

  return <ChatInner initialMessages={initialMessages} />;
}

function ChatInner({ initialMessages }: { initialMessages: ChatMessage[] }) {
  const {
    messages,
    chatMode,
    isExecuting,
    lastSubmitted,
    toolConfirmation,
    submit,
    respondToConfirmation,
  } = useChat({ sessionId: SESSION_ID, initialMessages });

  const { isConnected, isConnecting } = useConnection();
  const { text: streamingText, isStreaming, clear: clearStreamingText } = useStreamingText();
  const { contextInfo } = useContextInfo({ sessionId: SESSION_ID });

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, isStreaming, lastSubmitted, toolConfirmation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    clearStreamingText();
    submit(trimmed);
  };

  const renderContent = useCallback((content: ContentBlock, index: number) => {
    switch (content.type) {
      case "text":
        return (
          <span key={index} className="text-content">
            {content.text}
          </span>
        );

      case "image": {
        const imageContent = content as { source?: MediaSource };
        const source = imageContent.source;
        if (!source) return null;

        let src: string;
        if (source.type === "url") {
          src = source.url;
        } else if (source.type === "base64") {
          const base64Source = source as { mediaType?: string; data: string };
          src = `data:${base64Source.mediaType ?? "image/png"};base64,${base64Source.data}`;
        } else {
          return null;
        }

        return (
          <img
            key={index}
            src={src}
            alt=""
            className="image-content"
            style={{ maxWidth: "100%", borderRadius: "8px", marginTop: "8px" }}
          />
        );
      }

      case "tool_use":
        return (
          <div key={index} className="tool-call">
            <strong>{content.name}</strong>
            <pre>{JSON.stringify(content.input, null, 2)}</pre>
          </div>
        );

      case "tool_result": {
        const resultContent = content as ToolResultBlock;
        const resultText = Array.isArray(resultContent.content)
          ? resultContent.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : String(resultContent.content ?? "");

        return (
          <div key={index} className={`tool-result ${resultContent.isError ? "error" : ""}`}>
            <strong>{resultContent.name}</strong>
            <pre>{resultText}</pre>
          </div>
        );
      }

      default:
        return (
          <pre key={index} className="unknown-content">
            {JSON.stringify(content, null, 2)}
          </pre>
        );
    }
  }, []);

  const renderMessageContent = (msg: ChatMessage) => {
    if (Array.isArray(msg.content)) {
      return msg.content.map((block, idx) => renderContent(block as ContentBlock, idx));
    }
    return <span className="text-content">{msg.content}</span>;
  };

  return (
    <>
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={msg.id || `msg-${i}`} className={`chat-message ${msg.role}`}>
            <div className="message-role">{msg.role}</div>
            <div className="message-content">{renderMessageContent(msg)}</div>
          </div>
        ))}

        {/* Optimistic user message — shown until execution_end confirms it */}
        {lastSubmitted && (
          <div className="chat-message user pending">
            <div className="message-role">user</div>
            <div className="message-content">
              <span className="text-content">{lastSubmitted}</span>
            </div>
          </div>
        )}

        {/* Tool confirmation prompt */}
        {toolConfirmation && (
          <div className="chat-message tool-confirmation">
            <div className="message-role">tool confirmation</div>
            <div className="message-content">
              <div className="confirmation-body">
                <strong>{toolConfirmation.request.name}</strong> wants to run:
                <pre>{JSON.stringify(toolConfirmation.request.arguments, null, 2)}</pre>
                <div className="confirmation-actions">
                  <button
                    className="confirm-approve"
                    onClick={() => respondToConfirmation({ approved: true })}
                  >
                    Approve
                  </button>
                  <button
                    className="confirm-deny"
                    onClick={() =>
                      respondToConfirmation({ approved: false, reason: "User denied" })
                    }
                  >
                    Deny
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Streaming assistant response */}
        {isStreaming && streamingText && (
          <div className="chat-message assistant streaming">
            <div className="message-role">assistant</div>
            <div className="message-content">
              <span className="text-content">{streamingText}</span>
              <span className="streaming-cursor">|</span>
            </div>
          </div>
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
              isConnected ? "Type a message..." : isConnecting ? "Connecting..." : "Disconnected"
            }
            disabled={chatMode === "confirming_tool"}
          />
          <button type="submit" className="chat-send-btn" disabled={isExecuting || !input.trim()}>
            {chatMode === "streaming" ? "..." : "Send"}
          </button>
        </form>

        <div className="chat-status">
          <span className={`connection-status ${isConnected ? "connected" : ""}`}>
            <span className={`status-dot ${isConnected ? "connected" : ""}`} />{" "}
            {isConnected ? "Connected" : isConnecting ? "Connecting..." : "Disconnected"}
          </span>

          {chatMode === "streaming" && <span>Streaming...</span>}
          {chatMode === "confirming_tool" && (
            <span className="confirming">Awaiting confirmation...</span>
          )}

          {contextInfo && (
            <span className="context-info">
              <span className="context-model">{contextInfo.modelName || contextInfo.modelId}</span>
              {contextInfo.utilization !== undefined && (
                <>
                  <span className="context-utilization">
                    {contextInfo.utilization.toFixed(1)}% context
                  </span>
                  <progress
                    className={`context-progress ${
                      contextInfo.utilization >= 80
                        ? "high"
                        : contextInfo.utilization >= 50
                          ? "medium"
                          : "low"
                    }`}
                    value={contextInfo.utilization}
                    max={100}
                    title={`${contextInfo.inputTokens.toLocaleString()} / ${contextInfo.contextWindow?.toLocaleString() ?? "?"} tokens`}
                  />
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
