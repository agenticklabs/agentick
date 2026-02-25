import { describe, it, expect } from "vitest";
import { extractSendMessage, unwrapEventMessage } from "../transport-utils.js";

describe("extractSendMessage", () => {
  it("extracts plain string", () => {
    expect(extractSendMessage("hello")).toBe("hello");
  });

  it("returns empty for null/undefined", () => {
    expect(extractSendMessage(null)).toBe("");
    expect(extractSendMessage(undefined)).toBe("");
  });

  it("extracts from { message: string }", () => {
    expect(extractSendMessage({ message: "hello" })).toBe("hello");
  });

  it("extracts from { message: Message } with content blocks", () => {
    expect(
      extractSendMessage({
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    ).toBe("hello");
  });

  it("extracts from { messages: Message[] } — standard SendInput", () => {
    expect(
      extractSendMessage({
        messages: [{ role: "user", content: [{ type: "text", text: "hello from messages" }] }],
      }),
    ).toBe("hello from messages");
  });

  it("finds last user message when multiple messages present", () => {
    expect(
      extractSendMessage({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      }),
    ).toBe("second");
  });

  it("joins multiple text blocks in content", () => {
    expect(
      extractSendMessage({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
        ],
      }),
    ).toBe("line one\nline two");
  });

  it("handles string content in messages", () => {
    expect(
      extractSendMessage({
        messages: [{ role: "user", content: "plain string content" }],
      }),
    ).toBe("plain string content");
  });

  it("skips non-user messages", () => {
    expect(
      extractSendMessage({
        messages: [{ role: "assistant", content: [{ type: "text", text: "not this" }] }],
      }),
    ).toBe("");
  });

  it("returns empty for messages with no text blocks", () => {
    expect(
      extractSendMessage({
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      }),
    ).toBe("");
  });

  it("returns empty for empty messages array", () => {
    expect(extractSendMessage({ messages: [] })).toBe("");
  });
});

describe("unwrapEventMessage", () => {
  it("unwraps event messages", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "s1",
      data: { text: "hello" },
    });
    expect(result).toEqual({ type: "content_delta", sessionId: "s1", text: "hello" });
  });

  it("passes through non-event messages", () => {
    const msg = { type: "pong" };
    expect(unwrapEventMessage(msg)).toBe(msg);
  });
});
