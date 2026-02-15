import { describe, it, expect } from "vitest";
import { splitMessage } from "../message-splitter.js";

describe("splitMessage", () => {
  it("returns text as-is when under the limit", () => {
    expect(splitMessage("Hello", { maxLength: 100 })).toEqual(["Hello"]);
  });

  it("returns text as-is when exactly at the limit", () => {
    const text = "a".repeat(50);
    expect(splitMessage(text, { maxLength: 50 })).toEqual([text]);
  });

  it("splits on paragraph breaks", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const chunks = splitMessage(text, { maxLength: 20 });
    expect(chunks).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("splits on newlines when no paragraph break fits", () => {
    const text = "Line one\nLine two\nLine three";
    const chunks = splitMessage(text, { maxLength: 15 });
    expect(chunks[0]).toBe("Line one");
    expect(chunks[1]).toBe("Line two");
    expect(chunks[2]).toBe("Line three");
  });

  it("splits on sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = splitMessage(text, { maxLength: 35 });
    expect(chunks).toEqual(["First sentence. Second sentence.", "Third sentence."]);
  });

  it("splits on spaces as last resort", () => {
    const text = "word1 word2 word3 word4";
    const chunks = splitMessage(text, { maxLength: 12 });
    expect(chunks[0]).toBe("word1 word2");
    expect(chunks[1]).toBe("word3 word4");
  });

  it("hard-breaks when no split point exists", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = splitMessage(text, { maxLength: 10 });
    expect(chunks[0]).toBe("abcdefghij");
    expect(chunks[1]).toBe("klmnopqrst");
    expect(chunks[2]).toBe("uvwxyz");
  });

  it("appends continuation to all chunks except the last", () => {
    const text = "First part.\n\nSecond part.\n\nThird part.";
    const chunks = splitMessage(text, {
      maxLength: 20,
      continuation: "...",
    });
    expect(chunks[0].endsWith("...")).toBe(true);
    expect(chunks[chunks.length - 1].endsWith("...")).toBe(false);
  });

  it("respects continuation length in effective max", () => {
    // 10 chars max, 3 for "...", so effective max is 7
    const text = "aaaa bbbb cccc";
    const chunks = splitMessage(text, {
      maxLength: 10,
      continuation: "...",
    });
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });

  it("uses custom split points", () => {
    const text = "part1|part2|part3";
    const chunks = splitMessage(text, {
      maxLength: 10,
      splitOn: ["|"],
    });
    expect(chunks).toEqual(["part1|", "part2|", "part3"]);
  });

  it("handles empty text", () => {
    expect(splitMessage("", { maxLength: 100 })).toEqual([""]);
  });

  it("throws when maxLength is less than continuation length", () => {
    expect(() => splitMessage("test", { maxLength: 2, continuation: "..." })).toThrow(
      "maxLength must be greater than continuation length",
    );
  });

  it("handles Telegram's 4096 limit with realistic content", () => {
    const paragraph = "This is a paragraph of text. ".repeat(20); // ~580 chars
    const text = Array(10).fill(paragraph).join("\n\n"); // ~6000 chars
    const chunks = splitMessage(text, { maxLength: 4096 });
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // Reconstructed content should preserve all text
    expect(chunks.join("\n\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });
});
