import { describe, it, expect } from "vitest";
import { unwrapEventMessage } from "../transport-utils.js";

describe("unwrapEventMessage", () => {
  it("unwraps event messages", () => {
    const result = unwrapEventMessage({
      type: "event",
      event: "content_delta",
      sessionId: "s1",
      data: { text: "hello" },
    });
    expect(result).toEqual({ type: "content_delta", sessionId: "s1", text: "hello" });
  });

  it("passes through non-event messages", () => {
    const msg = { type: "pong" };
    expect(unwrapEventMessage(msg)).toBe(msg);
  });
});
