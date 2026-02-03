/**
 * Protocol Tests
 *
 * Tests for session key parsing and formatting.
 */

import { describe, it, expect } from "vitest";
import { parseSessionKey, formatSessionKey, type SessionKey } from "../protocol.js";

describe("parseSessionKey", () => {
  it("parses simple session name with default agent", () => {
    const result = parseSessionKey("main", "chat");
    expect(result).toEqual({ appId: "chat", sessionName: "main" });
  });

  it("parses agent-prefixed session key", () => {
    const result = parseSessionKey("research:task-123", "chat");
    expect(result).toEqual({ appId: "research", sessionName: "task-123" });
  });

  it("preserves colons in session name after first", () => {
    const result = parseSessionKey("slack:C012345:thread-xyz", "chat");
    expect(result).toEqual({ appId: "slack", sessionName: "C012345:thread-xyz" });
  });

  it("handles phone numbers in session name", () => {
    const result = parseSessionKey("whatsapp:+1234567890", "chat");
    expect(result).toEqual({ appId: "whatsapp", sessionName: "+1234567890" });
  });
});

describe("formatSessionKey", () => {
  it("formats session key with agent prefix", () => {
    const key: SessionKey = { appId: "chat", sessionName: "main" };
    expect(formatSessionKey(key)).toBe("chat:main");
  });

  it("formats session key with complex session name", () => {
    const key: SessionKey = { appId: "slack", sessionName: "C012345:thread-xyz" };
    expect(formatSessionKey(key)).toBe("slack:C012345:thread-xyz");
  });
});

describe("parseSessionKey and formatSessionKey roundtrip", () => {
  it("roundtrips simple key", () => {
    const original = "chat:main";
    const parsed = parseSessionKey(original, "default");
    const formatted = formatSessionKey(parsed);
    expect(formatted).toBe(original);
  });

  it("roundtrips complex key", () => {
    const original = "whatsapp:+1234567890";
    const parsed = parseSessionKey(original, "default");
    const formatted = formatSessionKey(parsed);
    expect(formatted).toBe(original);
  });
});
