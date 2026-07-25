/**
 * Unit tests for the thin confirmation pure functions. The elicitation
 * routing itself is covered end-to-end in connector.spec.tsx.
 */

import { describe, expect, it } from "vitest";

import { formatConfirmationMessage, parseTextConfirmation } from "../confirmations.js";

describe("parseTextConfirmation", () => {
  it("approves common affirmatives", () => {
    for (const yes of ["yes", "y", "OK", "go ahead", "yes but skip tests"]) {
      expect(parseTextConfirmation(yes).approved).toBe(true);
    }
  });
  it("denies everything else and keeps the raw text as reason", () => {
    const d = parseTextConfirmation("no way");
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("no way");
  });
});

describe("formatConfirmationMessage", () => {
  it("appends an argument summary and a url when present", () => {
    const out = formatConfirmationMessage({
      message: "Run?",
      arguments: { command: "ls" },
      url: "https://x/y",
    });
    expect(out).toContain("Run?");
    expect(out).toContain("command: ls");
    expect(out).toContain("https://x/y");
  });
});
