/**
 * Tests for the respondWith API on test models.
 */

import { describe, it, expect } from "vitest";
import { createTestModel } from "../test-model";
import { toEngineState } from "../../model/utils/language-model";

describe("respondWith", () => {
  describe("content detection", () => {
    it("should handle simple text string", async () => {
      const model = createTestModel();
      model.respondWith(["Hello world"]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(1);
      expect(output.message.content[0]).toEqual({ type: "text", text: "Hello world" });
      expect(output.stopReason).toBe("stop");
    });

    it("should handle explicit text object", async () => {
      const model = createTestModel();
      model.respondWith([{ text: "Explicit text" }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content[0]).toEqual({ type: "text", text: "Explicit text" });
    });

    it("should handle single tool call", async () => {
      const model = createTestModel();
      model.respondWith([{ tool: { name: "search", input: { query: "test" } } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(1);
      expect(output.message.content[0].type).toBe("tool_use");
      expect(output.message.content[0].name).toBe("search");
      expect(output.message.content[0].input).toEqual({ query: "test" });
      expect(output.toolCalls).toHaveLength(1);
      expect(output.stopReason).toBe("tool_use");
    });

    it("should handle parallel tool calls", async () => {
      const model = createTestModel();
      model.respondWith([
        {
          tool: [
            { name: "search", input: { query: "a" } },
            { name: "search", input: { query: "b" } },
          ],
        },
      ]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(2);
      expect(output.toolCalls).toHaveLength(2);
      expect(output.toolCalls![0].name).toBe("search");
      expect(output.toolCalls![1].name).toBe("search");
    });

    it("should handle text + tool call", async () => {
      const model = createTestModel();
      model.respondWith([
        "Let me search for that",
        { tool: { name: "search", input: { query: "test" } } },
      ]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(2);
      expect(output.message.content[0]).toEqual({ type: "text", text: "Let me search for that" });
      expect(output.message.content[1].type).toBe("tool_use");
      expect(output.stopReason).toBe("tool_use");
    });

    it("should handle image with URL", async () => {
      const model = createTestModel();
      model.respondWith(["Here's an image:", { image: { url: "https://example.com/image.png" } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(2);
      expect(output.message.content[1].type).toBe("image");
      expect(output.message.content[1].source).toEqual({
        type: "url",
        url: "https://example.com/image.png",
      });
    });

    it("should handle image with base64 data", async () => {
      const model = createTestModel();
      model.respondWith([{ image: { data: "base64data", mediaType: "image/jpeg" } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content[0].type).toBe("image");
      expect(output.message.content[0].source).toEqual({
        type: "base64",
        data: "base64data",
        mediaType: "image/jpeg",
      });
    });

    it("should handle reasoning content", async () => {
      const model = createTestModel();
      model.respondWith([{ reasoning: "Let me think about this..." }, "The answer is 42"]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.message.content).toHaveLength(2);
      expect(output.message.content[0]).toEqual({
        type: "reasoning",
        text: "Let me think about this...",
      });
      expect(output.message.content[1]).toEqual({ type: "text", text: "The answer is 42" });
    });
  });

  describe("ID generation", () => {
    it("should auto-generate tool call IDs", async () => {
      const model = createTestModel();
      model.respondWith([{ tool: { name: "test", input: {} } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.toolCalls![0].id).toMatch(/^toolu_test_/);
    });

    it("should preserve provided tool call IDs", async () => {
      const model = createTestModel();
      model.respondWith([{ tool: { id: "custom-id", name: "test", input: {} } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;

      expect(output.toolCalls![0].id).toBe("custom-id");
    });
  });

  describe("consumption behavior", () => {
    it("should consume respondWith on next call", async () => {
      const model = createTestModel({ defaultResponse: "Default" });
      model.respondWith(["Override"]);

      // First call uses respondWith
      const result1 = model.generate({ messages: [], tools: [] });
      const output1 = "result" in result1 ? await result1.result : await result1;
      expect(output1.message.content[0]).toEqual({ type: "text", text: "Override" });

      // Second call falls back to default
      const result2 = model.generate({ messages: [], tools: [] });
      const output2 = "result" in result2 ? await result2.result : await result2;
      expect(output2.message.content[0]).toEqual({ type: "text", text: "Default" });
    });
  });

  describe("streaming support", () => {
    it("should stream respondWith content correctly", async () => {
      const model = createTestModel();
      model.respondWith(["Hello", { tool: { name: "greet", input: { name: "World" } } }]);

      // Collect stream events
      const events: any[] = [];
      const streamResult = await model.stream!({ messages: [], tools: [] });
      for await (const event of streamResult) {
        events.push(event);
      }

      // Should have message_start, content events, tool events, message_end
      expect(events.some((e) => e.type === "message_start")).toBe(true);
      expect(events.some((e) => e.type === "content_delta" && e.delta === "Hello")).toBe(true);
      expect(events.some((e) => e.type === "tool_call_start" && e.name === "greet")).toBe(true);
      expect(events.some((e) => e.type === "message_end" && e.stopReason === "tool_use")).toBe(
        true,
      );
    });
  });

  describe("integration with toEngineState", () => {
    it("should produce valid EngineResponse with tool calls", async () => {
      const model = createTestModel();
      model.respondWith(["Using tool", { tool: { name: "search", input: { q: "test" } } }]);

      const result = model.generate({ messages: [], tools: [] });
      const output = "result" in result ? await result.result : await result;
      const engineResponse = await toEngineState(output);

      expect(engineResponse.toolCalls).toHaveLength(1);
      expect(engineResponse.toolCalls![0].name).toBe("search");
      expect(engineResponse.shouldStop).toBe(false); // Has tool calls
    });
  });
});
