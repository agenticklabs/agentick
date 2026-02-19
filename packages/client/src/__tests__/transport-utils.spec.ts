/**
 * unwrapEventMessage Tests
 *
 * Validates the EventMessage → flat format normalization used by all
 * client-side transports. Tests both the new EventMessage format and
 * passthrough of legacy/non-EventMessage data.
 */

import { describe, it, expect } from "vitest";
import { unwrapEventMessage } from "../transport-utils.js";

describe("unwrapEventMessage", () => {
  // ══════════════════════════════════════════════════════════════════════════
  // EventMessage unwrapping
  // ══════════════════════════════════════════════════════════════════════════

  it("unwraps EventMessage to flat format", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "main",
      data: { text: "hello", index: 0 },
    });

    expect(result).toEqual({
      type: "content_delta",
      sessionId: "main",
      text: "hello",
      index: 0,
    });
  });

  it("unwraps execution_end with empty data", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "execution_end",
      sessionId: "main",
      data: {},
    });

    expect(result).toEqual({
      type: "execution_end",
      sessionId: "main",
    });
  });

  it("unwraps error events", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "error",
      sessionId: "main",
      data: { error: "something failed" },
    });

    expect(result).toEqual({
      type: "error",
      sessionId: "main",
      error: "something failed",
    });
  });

  it("unwraps channel events", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "channel",
      sessionId: "main",
      data: {
        channel: "updates",
        event: { type: "message", payload: { text: "hi" } },
      },
    });

    expect(result).toEqual({
      type: "channel",
      sessionId: "main",
      channel: "updates",
      event: { type: "message", payload: { text: "hi" } },
    });
  });

  it("unwraps method:chunk events", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "method:chunk",
      sessionId: "main",
      data: { method: "tasks:list", chunk: { id: 1, title: "todo" } },
    });

    expect(result).toEqual({
      type: "method:chunk",
      sessionId: "main",
      method: "tasks:list",
      chunk: { id: 1, title: "todo" },
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ══════════════════════════════════════════════════════════════════════════

  it("handles missing data field", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "execution_end",
      sessionId: "main",
    });

    expect(result).toEqual({
      type: "execution_end",
      sessionId: "main",
    });
  });

  it("handles missing sessionId", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      data: { text: "hello" },
    });

    expect(result).toEqual({
      type: "content_delta",
      text: "hello",
    });
    expect(result).not.toHaveProperty("sessionId");
  });

  it("handles null data field", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "tick_start",
      sessionId: "main",
      data: null,
    });

    expect(result).toEqual({
      type: "tick_start",
      sessionId: "main",
    });
  });

  it("handles non-object data field (string)", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "main",
      data: "not an object",
    });

    expect(result).toEqual({
      type: "content_delta",
      sessionId: "main",
    });
  });

  it("preserves sessionId with value 0", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: 0,
      data: { text: "hello" },
    });

    expect(result).toEqual({
      type: "content_delta",
      sessionId: 0,
      text: "hello",
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Passthrough (non-EventMessage)
  // ══════════════════════════════════════════════════════════════════════════

  it("passes through connection events unchanged", () => {
    const input = {
      type: "connection",
      connectionId: "client-abc",
      subscriptions: [],
    };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input); // Same reference — no copy
  });

  it("passes through flat events (old format)", () => {
    const input = {
      type: "content_delta",
      sessionId: "main",
      text: "hello",
      index: 0,
    };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input);
  });

  it("passes through pong events", () => {
    const input = { type: "pong", timestamp: 1234 };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input);
  });

  it("passes through error messages (non-EventMessage)", () => {
    const input = { type: "error", code: "AUTH", message: "Unauthorized" };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input);
  });

  it("does NOT unwrap if event field is not a string", () => {
    const input = { type: "event", event: 42, sessionId: "main", data: {} };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input);
  });

  it("does NOT unwrap if event field is missing", () => {
    const input = { type: "event", sessionId: "main", data: {} };
    const result = unwrapEventMessage(input);
    expect(result).toBe(input);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Collision / adversarial
  // ══════════════════════════════════════════════════════════════════════════

  it("envelope fields survive collision with data properties", () => {
    // If data contains { type: "evil", sessionId: "hacked" }, the unwrap
    // must still use the outer event/sessionId — envelope wins over data.
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "main",
      data: { type: "evil", sessionId: "hacked", text: "hello" },
    });

    expect(result.type).toBe("content_delta"); // envelope event wins
    expect(result.sessionId).toBe("main"); // envelope sessionId wins
    expect(result.text).toBe("hello"); // data property preserved
  });

  it("handles deeply nested data objects", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "tool_result",
      sessionId: "main",
      data: {
        callId: "call-1",
        name: "search",
        result: { items: [{ id: 1 }, { id: 2 }] },
        nested: { a: { b: { c: true } } },
      },
    });

    expect(result.type).toBe("tool_result");
    expect(result.callId).toBe("call-1");
    expect(result.nested).toEqual({ a: { b: { c: true } } });
  });
});
