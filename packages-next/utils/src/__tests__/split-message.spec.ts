import { describe, expect, it } from "vitest";

import { splitMessage } from "../split-message.js";

describe("splitMessage", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(splitMessage("short", { maxLength: 100 })).toEqual(["short"]);
  });

  it("never emits a chunk longer than maxLength", () => {
    const text = "word ".repeat(500); // 2500 chars
    const chunks = splitMessage(text, { maxLength: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    // Reassembled (whitespace-normalized) content is preserved.
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("prefers the highest-priority boundary (paragraph over word)", () => {
    const para = "a".repeat(60);
    const chunks = splitMessage(`${para}\n\n${para}`, { maxLength: 70 });
    // Splits on the blank line, not mid-run.
    expect(chunks).toEqual([para, para]);
  });

  it("hard-breaks when no boundary exists before the cap", () => {
    const solid = "x".repeat(250);
    const chunks = splitMessage(solid, { maxLength: 100 });
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(solid);
  });

  it("reserves room for the continuation suffix on non-final chunks", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const chunks = splitMessage(text, { maxLength: 15, continuation: " …" });
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.endsWith(" …")).toBe(true);
      expect(chunks[i]!.length).toBeLessThanOrEqual(15);
    }
    expect(chunks.at(-1)!.endsWith(" …")).toBe(false);
  });

  it("respects the Telegram 4096 cap on a large payload", () => {
    const text = "sentence. ".repeat(1000); // 10_000 chars
    const chunks = splitMessage(text, { maxLength: 4096 });
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });

  it("throws when the continuation is at least as long as the limit", () => {
    expect(() => splitMessage("x".repeat(50), { maxLength: 2, continuation: "..." })).toThrow(
      /continuation/,
    );
  });
});
