/**
 * Tests for input normalization utilities
 */

import {
  isContentBlock,
  isMessage,
  normalizeContentInput,
  normalizeContentArray,
  normalizeMessageInput,
} from "../input";
import type { ContentBlock, TextBlock, ImageBlock } from "../blocks";
import type { Message } from "../messages";

describe("isContentBlock", () => {
  it("should return true for text block", () => {
    const block: TextBlock = { type: "text", text: "Hello" };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return true for image block", () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return true for tool_use block", () => {
    const block = {
      type: "tool_use",
      toolUseId: "123",
      name: "test",
      input: {},
    };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return true for tool_result block", () => {
    const block = {
      type: "tool_result",
      toolUseId: "123",
      name: "test",
      content: [],
    };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return true for reasoning block", () => {
    const block = { type: "reasoning", text: "thinking..." };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return true for code block", () => {
    const block = {
      type: "code",
      text: "const x = 1;",
      language: "typescript",
    };
    expect(isContentBlock(block)).toBe(true);
  });

  it("should return false for plain objects without valid type", () => {
    expect(isContentBlock({ type: "invalid_type" })).toBe(false);
    expect(isContentBlock({ foo: "bar" })).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isContentBlock("string")).toBe(false);
    expect(isContentBlock(123)).toBe(false);
    expect(isContentBlock(true)).toBe(false);
    expect(isContentBlock(null)).toBe(false);
    expect(isContentBlock(undefined)).toBe(false);
  });

  it("should return false for arrays", () => {
    expect(isContentBlock([])).toBe(false);
    expect(isContentBlock([{ type: "text", text: "hi" }])).toBe(false);
  });
});

describe("isMessage", () => {
  it("should return true for user message", () => {
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    expect(isMessage(message)).toBe(true);
  });

  it("should return true for assistant message", () => {
    const message: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
    };
    expect(isMessage(message)).toBe(true);
  });

  it("should return true for system message", () => {
    const message: Message = {
      role: "system",
      content: [{ type: "text", text: "You are helpful" }],
    };
    expect(isMessage(message)).toBe(true);
  });

  it("should return true for tool message", () => {
    const message: Message = {
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "123", name: "test", content: [] }],
    };
    expect(isMessage(message)).toBe(true);
  });

  it("should return false for content blocks", () => {
    expect(isMessage({ type: "text", text: "Hello" })).toBe(false);
  });

  it("should return false for objects without role", () => {
    expect(isMessage({ content: [] })).toBe(false);
  });

  it("should return false for objects without content", () => {
    expect(isMessage({ role: "user" })).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isMessage("string")).toBe(false);
    expect(isMessage(null)).toBe(false);
  });
});

describe("normalizeContentInput", () => {
  it("should convert string to TextBlock", () => {
    const result = normalizeContentInput("Hello world");

    expect(result).toEqual({ type: "text", text: "Hello world" });
  });

  it("should return ContentBlock unchanged", () => {
    const block: TextBlock = { type: "text", text: "Already a block" };
    const result = normalizeContentInput(block);

    expect(result).toBe(block);
  });

  it("should handle image blocks", () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    };
    const result = normalizeContentInput(block);

    expect(result).toBe(block);
  });
});

describe("normalizeContentArray", () => {
  it("should convert single string to array with TextBlock", () => {
    const result = normalizeContentArray("Hello");

    expect(result).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("should convert single ContentBlock to array", () => {
    const block: TextBlock = { type: "text", text: "Hello" };
    const result = normalizeContentArray(block);

    expect(result).toEqual([block]);
  });

  it("should convert array of strings to TextBlocks", () => {
    const result = normalizeContentArray(["Hello", "World"]);

    expect(result).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
  });

  it("should handle mixed array of strings and ContentBlocks", () => {
    const imageBlock: ImageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    };
    const result = normalizeContentArray(["Hello", imageBlock, "World"]);

    expect(result).toEqual([
      { type: "text", text: "Hello" },
      imageBlock,
      { type: "text", text: "World" },
    ]);
  });

  it("should return array of ContentBlocks unchanged", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    const result = normalizeContentArray(blocks);

    expect(result).toEqual(blocks);
  });
});

describe("normalizeMessageInput", () => {
  it("should convert string to user message", () => {
    const result = normalizeMessageInput("Hello");

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("should convert string to specified role", () => {
    const result = normalizeMessageInput("Hello", "assistant");

    expect(result[0].role).toBe("assistant");
  });

  it("should convert ContentBlock to user message", () => {
    const block: TextBlock = { type: "text", text: "Hello" };
    const result = normalizeMessageInput(block);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([block]);
  });

  it("should convert array of ContentBlocks to single message", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    const result = normalizeMessageInput(blocks);

    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual(blocks);
  });

  it("should return Message unchanged (wrapped in array)", () => {
    const message: Message = {
      id: "msg-1",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    const result = normalizeMessageInput(message);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(message);
  });

  it("should return array of Messages unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];
    const result = normalizeMessageInput(messages);

    expect(result).toBe(messages);
  });

  it("should convert array of strings to single message with multiple blocks", () => {
    const result = normalizeMessageInput(["Hello", "World"]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
  });
});
