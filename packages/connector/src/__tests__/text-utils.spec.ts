import { describe, it, expect } from "vitest";
import { parseTextConfirmation, formatConfirmationMessage } from "../text-utils.js";

describe("parseTextConfirmation", () => {
  it("approves on 'yes'", () => {
    expect(parseTextConfirmation("yes")).toEqual({ approved: true, reason: "yes" });
  });

  it("approves on 'y'", () => {
    expect(parseTextConfirmation("y")).toEqual({ approved: true, reason: "y" });
  });

  it("approves on 'ok'", () => {
    expect(parseTextConfirmation("ok")).toEqual({ approved: true, reason: "ok" });
  });

  it("approves on 'go ahead'", () => {
    expect(parseTextConfirmation("go ahead")).toEqual({ approved: true, reason: "go ahead" });
  });

  it("approves on 'do it'", () => {
    expect(parseTextConfirmation("do it")).toEqual({ approved: true, reason: "do it" });
  });

  it("approves with reason when text starts with 'yes'", () => {
    const result = parseTextConfirmation("yes but skip tests");
    expect(result.approved).toBe(true);
    expect(result.reason).toBe("yes but skip tests");
  });

  it("denies on 'no'", () => {
    expect(parseTextConfirmation("no")).toEqual({ approved: false, reason: "no" });
  });

  it("denies on unrecognized text", () => {
    const result = parseTextConfirmation("actually, change the approach");
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("actually, change the approach");
  });

  it("trims whitespace", () => {
    expect(parseTextConfirmation("  yes  ")).toEqual({ approved: true, reason: "yes" });
  });

  it("is case insensitive", () => {
    expect(parseTextConfirmation("YES")).toEqual({ approved: true, reason: "YES" });
    expect(parseTextConfirmation("Go Ahead")).toEqual({ approved: true, reason: "Go Ahead" });
  });
});

describe("formatConfirmationMessage", () => {
  it("uses message if provided", () => {
    const result = formatConfirmationMessage({
      name: "shell",
      arguments: {},
      message: "Run this command?",
    });
    expect(result).toBe("Run this command?");
  });

  it("generates default message from tool name", () => {
    const result = formatConfirmationMessage({
      name: "shell",
      arguments: {},
    });
    expect(result).toBe("Allow shell to execute?");
  });

  it("includes argument summary", () => {
    const result = formatConfirmationMessage({
      name: "shell",
      arguments: { command: "rm -rf /tmp/test" },
    });
    expect(result).toContain("command: rm -rf /tmp/test");
  });

  it("truncates long argument values", () => {
    const longValue = "a".repeat(100);
    const result = formatConfirmationMessage({
      name: "shell",
      arguments: { command: longValue },
    });
    expect(result).toContain("...");
  });

  it("stringifies non-string arguments", () => {
    const result = formatConfirmationMessage({
      name: "write_file",
      arguments: { path: "/tmp/test.txt", overwrite: true },
    });
    expect(result).toContain("path: /tmp/test.txt");
    expect(result).toContain("overwrite: true");
  });
});
