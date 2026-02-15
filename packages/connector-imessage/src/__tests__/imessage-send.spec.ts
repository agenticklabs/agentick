import { describe, it, expect } from "vitest";
import { buildAppleScript } from "../imessage-send.js";

describe("buildAppleScript", () => {
  it("generates valid AppleScript", () => {
    const script = buildAppleScript("+15551234567", "Hello!");
    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('buddy "+15551234567"');
    expect(script).toContain('send "Hello!"');
    expect(script).toContain("end tell");
  });

  it("escapes double quotes in message", () => {
    const script = buildAppleScript("+15551234567", 'He said "hello"');
    expect(script).toContain('send "He said \\"hello\\""');
  });

  it("escapes backslashes in message", () => {
    const script = buildAppleScript("+15551234567", "path\\to\\file");
    expect(script).toContain('send "path\\\\to\\\\file"');
  });

  it("escapes special characters in handle", () => {
    const script = buildAppleScript('user"@example.com', "test");
    expect(script).toContain('buddy "user\\"@example.com"');
  });

  it("handles email handles", () => {
    const script = buildAppleScript("user@example.com", "test");
    expect(script).toContain('buddy "user@example.com"');
  });
});
