import { describe, it, expect } from "vitest";
import type { ContentBlock } from "@agentick/shared";
import { formatDuration } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { renderContentBlock, renderToolCall } from "./content-block.js";
import { renderMessage } from "./message.js";

// Strip ANSI escape codes for content assertions
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ============================================================================
// formatDuration
// ============================================================================

describe("formatDuration", () => {
  it("formats milliseconds under 1s", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });
});

// ============================================================================
// renderMarkdown
// ============================================================================

describe("renderMarkdown", () => {
  it("renders plain text", () => {
    const result = renderMarkdown("Hello world");
    expect(stripAnsi(result)).toContain("Hello world");
  });

  it("strips trailing newline", () => {
    const result = renderMarkdown("test");
    expect(result.endsWith("\n")).toBe(false);
  });

  it("renders code spans", () => {
    const result = renderMarkdown("Use `foo()` here");
    expect(stripAnsi(result)).toContain("foo()");
  });

  it("renders code blocks", () => {
    const result = renderMarkdown("```js\nconst x = 1;\n```");
    expect(stripAnsi(result)).toContain("const x = 1;");
  });
});

// ============================================================================
// renderContentBlock
// ============================================================================

describe("renderContentBlock", () => {
  it("renders text blocks as markdown", () => {
    const block = { type: "text", text: "Hello **world**" } as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("Hello");
    expect(stripAnsi(result)).toContain("world");
  });

  it("returns null for tool_use blocks (rendered separately)", () => {
    const block = { type: "tool_use", id: "tc-1", name: "search", input: {} } as ContentBlock;
    expect(renderContentBlock(block)).toBeNull();
  });

  it("renders reasoning blocks in italic gray", () => {
    const block = { type: "reasoning", text: "Let me think..." } as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("Let me think...");
  });

  it("returns null for redacted reasoning blocks", () => {
    const block = { type: "reasoning", text: "secret", isRedacted: true } as ContentBlock;
    expect(renderContentBlock(block)).toBeNull();
  });

  it("renders code blocks with language", () => {
    const block = { type: "code", text: "const x = 1;", language: "typescript" } as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("const x = 1;");
  });

  it("renders tool_result with inner content", () => {
    const block = {
      type: "tool_result",
      toolUseId: "tc-1",
      name: "search",
      content: [{ type: "text", text: "found 3 results" }],
      isError: false,
    } as unknown as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("found 3 results");
  });

  it("renders tool_result errors with error styling", () => {
    const block = {
      type: "tool_result",
      toolUseId: "tc-1",
      name: "search",
      content: [{ type: "text", text: "file not found" }],
      isError: true,
    } as unknown as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("error");
    expect(stripAnsi(result)).toContain("file not found");
  });

  it("returns null for empty tool_result", () => {
    const block = {
      type: "tool_result",
      toolUseId: "tc-1",
      name: "search",
      content: [],
      isError: false,
    } as unknown as ContentBlock;
    expect(renderContentBlock(block)).toBeNull();
  });

  it("renders image blocks as placeholders", () => {
    const block = { type: "image", altText: "screenshot" } as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("[image: screenshot]");
  });

  it("renders document blocks as placeholders", () => {
    const block = { type: "document", title: "README.md" } as ContentBlock;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("[document: README.md]");
  });

  it("renders unknown block types with type name", () => {
    const block = { type: "unknown_future_type" } as any;
    const result = renderContentBlock(block)!;
    expect(stripAnsi(result)).toContain("[unknown_future_type]");
  });
});

// ============================================================================
// renderToolCall
// ============================================================================

describe("renderToolCall", () => {
  it("renders tool name with + prefix", () => {
    const result = renderToolCall("glob");
    expect(stripAnsi(result)).toContain("+ glob");
  });

  it("includes formatted duration when provided", () => {
    const result = renderToolCall("search", 1500);
    expect(stripAnsi(result)).toContain("+ search");
    expect(stripAnsi(result)).toContain("(1.5s)");
  });

  it("omits duration when not provided", () => {
    const result = renderToolCall("read_file");
    expect(stripAnsi(result)).not.toContain("(");
  });
});

// ============================================================================
// renderMessage
// ============================================================================

describe("renderMessage", () => {
  it("renders user messages with borders", () => {
    const result = renderMessage({ role: "user", content: "What is this?" });
    const plain = stripAnsi(result);
    expect(plain).toContain("What is this?");
    expect(plain).toContain("─"); // border character
  });

  it("renders user messages from string content", () => {
    const result = renderMessage({ role: "user", content: "Hello" });
    expect(stripAnsi(result)).toContain("Hello");
  });

  it("renders user messages from ContentBlock[] content", () => {
    const blocks = [{ type: "text", text: "Hello from blocks" } as ContentBlock];
    const result = renderMessage({ role: "user", content: blocks });
    expect(stripAnsi(result)).toContain("Hello from blocks");
  });

  it("renders assistant messages without borders", () => {
    const blocks = [{ type: "text", text: "I can help with that." } as ContentBlock];
    const result = renderMessage({ role: "assistant", content: blocks });
    const plain = stripAnsi(result);
    expect(plain).toContain("I can help with that.");
    // No border characters for assistant
    expect(plain.split("\n")[0]).not.toMatch(/^─+$/);
  });

  it("renders assistant tool calls", () => {
    const blocks = [
      { type: "text", text: "Searching..." } as ContentBlock,
      { type: "tool_use", id: "tc-1", name: "grep", input: {} } as ContentBlock,
    ];
    const result = renderMessage({
      role: "assistant",
      content: blocks,
      toolCalls: [{ id: "tc-1", name: "grep", duration: 250 }],
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("Searching...");
    expect(plain).toContain("+ grep");
    expect(plain).toContain("(250ms)");
  });

  it("extracts tool calls from blocks when toolCalls not provided", () => {
    const blocks = [
      { type: "text", text: "Working..." } as ContentBlock,
      { type: "tool_use", id: "tc-1", name: "read_file", input: {} } as ContentBlock,
    ];
    const result = renderMessage({ role: "assistant", content: blocks });
    expect(stripAnsi(result)).toContain("+ read_file");
  });

  it("does not show role labels", () => {
    const userResult = renderMessage({ role: "user", content: "test" });
    const assistantResult = renderMessage({
      role: "assistant",
      content: [{ type: "text", text: "test" } as ContentBlock],
    });
    expect(stripAnsi(userResult)).not.toContain("user");
    expect(stripAnsi(assistantResult)).not.toContain("assistant");
  });

  it("returns empty string for user message with no text content", () => {
    const result = renderMessage({
      role: "user",
      content: [{ type: "image", altText: "pic" } as ContentBlock],
    });
    expect(result).toBe("");
  });
});
