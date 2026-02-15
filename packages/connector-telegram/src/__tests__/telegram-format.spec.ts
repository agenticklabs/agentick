import { describe, it, expect } from "vitest";
import { escapeMarkdownV2 } from "../telegram-format.js";

describe("escapeMarkdownV2", () => {
  it("escapes all MarkdownV2 special characters", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const result = escapeMarkdownV2(input);
    expect(result).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdownV2("Hello world")).toBe("Hello world");
  });

  it("escapes special chars within normal text", () => {
    expect(escapeMarkdownV2("Hello. How are you?")).toBe("Hello\\. How are you?");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });

  it("escapes code-like content", () => {
    expect(escapeMarkdownV2("Run `npm install`")).toBe("Run \\`npm install\\`");
  });

  it("escapes markdown links", () => {
    expect(escapeMarkdownV2("[click here](https://example.com)")).toBe(
      "\\[click here\\]\\(https://example\\.com\\)",
    );
  });
});
