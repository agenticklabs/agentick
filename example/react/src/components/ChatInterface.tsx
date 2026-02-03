/**
 * Chat Interface Component
 *
 * Architecture:
 * - execution_end events are the source of truth for messages (contains full timeline)
 * - No local message state - we render what the server sends
 * - Streaming text shows real-time model output
 * - Pending message shows optimistic user input until confirmed
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSession, useConnection, useStreamingText } from "@tentickle/react";
import type { ContentBlock, MediaSource, Message, ToolResultBlock } from "@tentickle/shared";

interface ChatMessage {
  id: string;
  role: Message["role"];
  content: ContentBlock[];
}

export function ChatInterface() {
  const SESSION_ID = "default";
  const { send, accessor } = useSession({ sessionId: SESSION_ID, autoSubscribe: true });
  const { isConnected, isConnecting } = useConnection();
  const { text: streamingText, isStreaming, clear: clearStreamingText } = useStreamingText();

  // Input state
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  // Messages from server (source of truth)
  const [serverMessages, setServerMessages] = useState<Message[]>([]);

  // Pending user message (optimistic, shown until server confirms)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when content changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [serverMessages, streamingText, isStreaming, pendingMessage]);

  // Helper to invoke gateway methods
  const invoke = async (method: string, params: Record<string, unknown>) => {
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
  };

  // Load initial history from server
  useEffect(() => {
    let isMounted = true;

    const loadHistory = async () => {
      try {
        // Ensure session exists
        await invoke("sessions:create", { sessionId: SESSION_ID });

        // Load timeline
        const data = (await invoke("sessions:get", { sessionId: SESSION_ID })) as {
          timeline?: unknown[];
        };
        const timeline = Array.isArray(data.timeline) ? data.timeline : [];

        const messages = timeline
          .map((entry: unknown) => (entry as { message?: Message }).message)
          .filter((msg: Message | undefined): msg is Message => !!msg);

        if (isMounted) {
          setServerMessages(messages);
        }
      } catch (error) {
        console.warn("Failed to load session history:", error);
      }
    };

    loadHistory();
    return () => {
      isMounted = false;
    };
  }, []);

  // Subscribe to execution_end events to get timeline updates
  // execution_end contains output.timeline with all messages
  useEffect(() => {
    if (!accessor) return;

    const unsubscribe = accessor.onEvent((event) => {
      if (event.type === "execution_end") {
        const execEnd = event as {
          type: "execution_end";
          output?: { timeline?: Array<{ kind: string; message?: Message }> };
        };
        if (execEnd.output?.timeline) {
          const messages = execEnd.output.timeline
            .filter((entry) => entry.kind === "message" && entry.message)
            .map((entry) => entry.message!);
          if (messages.length > 0) {
            setServerMessages(messages);
            // Clear pending message since server has confirmed it
            setPendingMessage(null);
          }
        }
      }
    });

    return unsubscribe;
  }, [accessor]);

  // Note: The pendingMessage state provides optimistic UX for the current user's messages
  // while waiting for the server to confirm via execution_end event.

  // Convert server messages to display format
  const displayMessages = useMemo((): ChatMessage[] => {
    return serverMessages.map((msg, idx) => ({
      id: msg.id ?? `msg-${idx}`,
      role: msg.role,
      content: msg.content as ContentBlock[],
    }));
  }, [serverMessages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = input.trim();
    if (!trimmed && (!isSending || !isConnected)) return;

    setIsSending(true);
    setInput("");
    clearStreamingText();

    // Show pending message immediately (optimistic)
    setPendingMessage(trimmed);

    try {
      await send(trimmed);
    } catch (err) {
      console.error("Failed to send message:", err);
      // On error, clear pending and show error
      setPendingMessage(null);
    } finally {
      setIsSending(false);
    }
  };

  // Render a content block
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
            <strong>🔧 {content.name}</strong>
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
            <strong>📋 {resultContent.name}</strong>
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

  return (
    <>
      {/* <div className="chat-header">
        <h2>Chat</h2>
        <span className={`connection-status ${isConnected ? "connected" : ""}`}>
          {isConnected ? "Connected" : isConnecting ? "Connecting..." : "Disconnected"}
        </span>
      </div> */}

      <div className="chat-messages">
        {displayMessages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <div className="message-role">{msg.role}</div>
            <div className="message-content">
              {msg.content.map((block, idx) => renderContent(block, idx))}
            </div>
          </div>
        ))}

        {/* Show pending user message (optimistic) */}
        {pendingMessage && (
          <div className="chat-message user pending">
            <div className="message-role">user</div>
            <div className="message-content">
              <span className="text-content">{pendingMessage}</span>
            </div>
          </div>
        )}

        {/* Show streaming assistant response */}
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
            disabled={false && (!isConnected || isSending)}
          />
          <button
            type="submit"
            className="chat-send-btn"
            disabled={false && (!isConnected || isSending || !input.trim())}
          >
            {isSending ? "..." : "Send"}
          </button>
        </form>

        <div className="chat-status">
          <span className={`connection-status ${isConnected ? "connected" : ""}`}>
            <span className={`status-dot ${isConnected ? "connected" : ""}`} />{" "}
            {isConnected ? "Connected" : isConnecting ? "Connecting..." : "Disconnected"}
          </span>

          {isSending && <span>Sending...</span>}
          {isStreaming && <span>Streaming...</span>}
        </div>
      </div>
    </>
  );
}
