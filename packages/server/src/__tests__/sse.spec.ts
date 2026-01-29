/**
 * SSE Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSSEWriter, streamToSSE, setSSEHeaders } from "../sse.js";

// Mock writable stream
function createMockStream(): {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  _output: string;
} {
  let output = "";
  return {
    write: vi.fn((data: string) => {
      output += data;
    }),
    end: vi.fn(),
    get _output() {
      return output;
    },
  };
}

// Mock response with setHeader
function createMockResponse(): {
  setHeader: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
}

describe("createSSEWriter", () => {
  let stream: ReturnType<typeof createMockStream>;
  let writer: ReturnType<typeof createSSEWriter>;

  beforeEach(() => {
    vi.useFakeTimers();
    stream = createMockStream();
    writer = createSSEWriter(stream);
  });

  afterEach(() => {
    writer.close();
    vi.useRealTimers();
  });

  describe("writeEvent", () => {
    it("writes event in SSE format", () => {
      writer.writeEvent({
        channel: "session:events",
        type: "content_delta",
        payload: { delta: "Hello" },
      });

      expect(stream._output).toContain("event: message");
      expect(stream._output).toContain('data: {"channel":"session:events"');
      expect(stream._output).toContain('"type":"content_delta"');
      expect(stream._output).toContain('"delta":"Hello"');
    });

    it("includes event ID when provided", () => {
      writer.writeEvent({
        channel: "session:events",
        type: "test",
        payload: {},
        id: "event-123",
      });

      expect(stream._output).toContain('"id":"event-123"');
    });

    it("does not write after close", () => {
      writer.close();

      writer.writeEvent({
        channel: "session:events",
        type: "test",
        payload: {},
      });

      expect(stream._output).toBe("");
    });

    it("handles JSON serialization errors gracefully", () => {
      // Create an object with circular reference
      const circular: any = { channel: "test", type: "test" };
      circular.payload = { self: circular };

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      writer.writeEvent(circular);

      // Should log the error
      expect(consoleSpy).toHaveBeenCalled();

      // Should still write something (the fallback error event)
      expect(stream._output).toContain("event: message");
      expect(stream._output).toContain("SERIALIZATION_ERROR");
      expect(stream._output).toContain("Failed to serialize event");

      consoleSpy.mockRestore();
    });

    it("handles BigInt serialization errors gracefully", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      writer.writeEvent({
        channel: "test",
        type: "test",
        payload: { bigNumber: BigInt(9007199254740991) },
      });

      // Should log the error
      expect(consoleSpy).toHaveBeenCalled();

      // Should still write something (the fallback error event)
      expect(stream._output).toContain("SERIALIZATION_ERROR");

      consoleSpy.mockRestore();
    });
  });

  describe("writeComment", () => {
    it("writes SSE comment", () => {
      writer.writeComment("test comment");

      expect(stream._output).toBe(": test comment\n\n");
    });

    it("does not write after close", () => {
      writer.close();

      writer.writeComment("test");

      expect(stream._output).toBe("");
    });
  });

  describe("keepalive", () => {
    it("sends keepalive comments at interval", () => {
      // Default interval is 15000ms
      vi.advanceTimersByTime(15000);

      expect(stream._output).toContain(": keepalive");
    });

    it("uses custom interval", () => {
      const writerWithInterval = createSSEWriter(stream, { keepaliveInterval: 5000 });

      vi.advanceTimersByTime(5000);

      expect(stream._output).toContain(": keepalive");

      writerWithInterval.close();
    });

    it("stops keepalive on close", () => {
      writer.close();

      vi.advanceTimersByTime(30000);

      expect(stream._output).toBe("");
    });

    it("disables keepalive when interval is 0", () => {
      // Use a fresh stream for this test
      const freshStream = createMockStream();
      const writerNoKeepalive = createSSEWriter(freshStream, { keepaliveInterval: 0 });

      vi.advanceTimersByTime(60000);

      expect(freshStream._output).toBe("");

      writerNoKeepalive.close();
    });
  });

  describe("close", () => {
    it("calls stream.end()", () => {
      writer.close();

      expect(stream.end).toHaveBeenCalled();
    });

    it("sets closed flag", () => {
      expect(writer.closed).toBe(false);

      writer.close();

      expect(writer.closed).toBe(true);
    });

    it("is idempotent", () => {
      writer.close();
      writer.close();

      expect(stream.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("custom event name", () => {
    it("uses custom event name", () => {
      const writerCustomName = createSSEWriter(stream, { eventName: "custom" });

      writerCustomName.writeEvent({
        channel: "test",
        type: "test",
        payload: {},
      });

      expect(stream._output).toContain("event: custom");

      writerCustomName.close();
    });
  });
});

describe("streamToSSE", () => {
  let stream: ReturnType<typeof createMockStream>;

  beforeEach(() => {
    vi.useFakeTimers();
    stream = createMockStream();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams async iterable to SSE", async () => {
    const events = [
      { type: "tick_start", tick: 1 },
      { type: "content_delta", delta: "Hello" },
      { type: "tick_end", tick: 1 },
    ];

    async function* generate() {
      for (const event of events) {
        yield event;
      }
    }

    await streamToSSE(stream, generate(), "session:events");

    expect(stream._output).toContain('"type":"tick_start"');
    expect(stream._output).toContain('"type":"content_delta"');
    expect(stream._output).toContain('"type":"tick_end"');
  });

  it("closes stream when done", async () => {
    async function* generate() {
      yield { type: "test" };
    }

    await streamToSSE(stream, generate(), "session:events");

    expect(stream.end).toHaveBeenCalled();
  });

  it("closes stream on error", async () => {
    async function* generate() {
      yield { type: "test" };
      throw new Error("Stream error");
    }

    await expect(streamToSSE(stream, generate(), "session:events")).rejects.toThrow(
      "Stream error",
    );

    expect(stream.end).toHaveBeenCalled();
  });

  it("uses event type from objects", async () => {
    async function* generate() {
      yield { type: "custom_event", data: "test" };
    }

    await streamToSSE(stream, generate(), "test:channel");

    const output = stream._output;
    expect(output).toContain('"type":"custom_event"');
  });

  it("uses default type for objects without type", async () => {
    async function* generate() {
      yield { data: "test" };
    }

    await streamToSSE(stream, generate(), "test:channel");

    const output = stream._output;
    expect(output).toContain('"type":"event"');
  });
});

describe("setSSEHeaders", () => {
  it("sets required SSE headers", () => {
    const res = createMockResponse();

    setSSEHeaders(res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(res.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
  });
});
