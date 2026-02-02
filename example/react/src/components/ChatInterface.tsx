/**
 * Chat Interface Component
 *
 * Architecture:
 * - Timeline channel is the source of truth for messages
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

  // Load initial history from server
  useEffect(() => {
    let isMounted = true;

    const loadHistory = async () => {
      try {
        // Ensure session exists
        await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: SESSION_ID }),
        });

        // Load timeline
        const response = await fetch(`/api/sessions/${SESSION_ID}`);
        if (!response.ok) return;

        const data = (await response.json()) as { timeline?: unknown[] };
        const timeline = Array.isArray(data.timeline) ? data.timeline : [];

        const messages = timeline
          .map((entry) => (entry as { message?: Message }).message)
          .filter((msg): msg is Message => !!msg);

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

  // Subscribe to timeline channel for deltas
  // Server sends only NEW messages since last publish - we append them
  useEffect(() => {
    if (!accessor) return;

    const channel = accessor.channel("timeline");
    const unsubscribe = channel.subscribe((payload: unknown, event: { type: string }) => {
      if (event.type === "timeline_delta" && payload && typeof payload === "object") {
        const data = payload as { messages?: Message[]; totalCount?: number };
        if (data.messages && data.messages.length > 0) {
          setServerMessages((prev) => {
            const updated = [...prev, ...data.messages!];
            // Verify sync - if counts don't match, we may need to refetch
            if (data.totalCount !== undefined && updated.length !== data.totalCount) {
              console.warn(
                `Timeline sync mismatch: local=${updated.length}, server=${data.totalCount}`,
              );
            }
            return updated;
          });
          // Clear pending message since server has confirmed it
          setPendingMessage(null);
        }
      }
    });

    return unsubscribe;
  }, [accessor]);

  // Note: We intentionally do NOT subscribe to the "messages" channel for message_queued events.
  // The timeline_delta channel is our single source of truth. Using both would cause duplicates.
  // The pendingMessage state provides optimistic UX for the current user's messages.

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
