/**
 * unwrapEventMessage Tests
 *
 * Validates the EventMessage → TransportEventData normalization used by all
 * client-side transports. Data stays structured in the `data` field instead
 * of being spread into the top level.
 */

import { describe, it, expect } from "vitest";
import { unwrapEventMessage } from "../transport-utils.js";

describe("unwrapEventMessage", () => {
  // ══════════════════════════════════════════════════════════════════════════
  // EventMessage unwrapping
  // ══════════════════════════════════════════════════════════════════════════

  it("unwraps EventMessage to structured format", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "main",
      data: { text: "hello", index: 0 },
    });

    expect(result).toEqual({
      type: "content_delta",
      sessionId: "main",
      data: { text: "hello", index: 0 },
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
      data: {},
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
      data: { error: "something failed" },
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
      data: {
        channel: "updates",
        event: { type: "message", payload: { text: "hi" } },
      },
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
      data: { method: "tasks:list", chunk: { id: 1, title: "todo" } },
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
      data: undefined,
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
      data: { text: "hello" },
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
      data: null,
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
      data: "not an object",
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
      data: { text: "hello" },
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
  // No collision — structured data prevents namespace conflicts
  // ══════════════════════════════════════════════════════════════════════════

  it("data with conflicting type/sessionId stays isolated in data field", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "main",
      data: { type: "evil", sessionId: "hacked", text: "hello" },
    });

    // Envelope fields come from the outer message
    expect(result.type).toBe("content_delta");
    expect(result.sessionId).toBe("main");
    // Data stays structured — no collision possible
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.type).toBe("evil");
    expect(data.sessionId).toBe("hacked");
    expect(data.text).toBe("hello");
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
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.callId).toBe("call-1");
    expect(data.nested).toEqual({ a: { b: { c: true } } });
  });
});
