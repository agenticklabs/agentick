/**
 * Tests for createTestAdapter
 * Verifies feature parity with createTestModel
 */

import { describe, it, expect } from "vitest";
import { createTestAdapter } from "../test-adapter";
// Note: createTestModel has been replaced by createTestAdapter
import type { ModelInput, ModelOutput } from "../../model/model";
import type { ModelMessage, TextBlock } from "@agentick/shared";

// Helper to create minimal ModelInput
const createInput = (text: string): ModelInput => ({
  model: "test",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

// Helper to get result from ExecutionHandle (or return directly if not a handle)
async function getResult(handleOrResult: any): Promise<ModelOutput> {
  if (handleOrResult && typeof handleOrResult === "object" && "result" in handleOrResult) {
    return handleOrResult.result;
  }
  return handleOrResult;
}

describe("createTestAdapter", () => {
  describe("basic functionality", () => {
    it("should create adapter with default response", async () => {
      const adapter = createTestAdapter();
      const input = createInput("Hello");
      const handle = await adapter.generate(input);
      const output = await getResult(handle);

      expect(output.message?.content).toContainEqual({ type: "text", text: "Test response" });
    });

    it("should create adapter with custom response", async () => {
      const adapter = createTestAdapter({ defaultResponse: "Custom!" });
      const input = createInput("Hello");
      const handle = await adapter.generate(input);
      const output = await getResult(handle);

      expect(output.message?.content).toContainEqual({ type: "text", text: "Custom!" });
    });

    it("should capture inputs", async () => {
      const adapter = createTestAdapter();
      const input1 = createInput("First");
      const input2 = createInput("Second");

      await adapter.generate(input1);
      await adapter.generate(input2);

      const captured = adapter.getCapturedInputs();
      expect(captured).toHaveLength(2);
      expect(captured[0]).toBe(input1);
      expect(captured[1]).toBe(input2);
    });

    it("should clear captured inputs", async () => {
      const adapter = createTestAdapter();
      await adapter.generate(createInput("Test"));

      expect(adapter.getCapturedInputs()).toHaveLength(1);
      adapter.clearCapturedInputs();
      expect(adapter.getCapturedInputs()).toHaveLength(0);
    });
  });

  describe("setResponse", () => {
    it("should change response for subsequent calls", async () => {
      const adapter = createTestAdapter({ defaultResponse: "Initial" });
      const input = createInput("Test");

      const handle1 = await adapter.generate(input);
      const output1 = await getResult(handle1);
      expect(output1.message?.content).toContainEqual({ type: "text", text: "Initial" });

      adapter.setResponse("Changed");
      const handle2 = await adapter.generate(input);
      const output2 = await getResult(handle2);
      expect(output2.message?.content).toContainEqual({ type: "text", text: "Changed" });
    });
  });

  describe("respondWith", () => {
    it("should handle simple text", async () => {
      const adapter = createTestAdapter();
      adapter.respondWith(["Hello world"]);

      const handle = await adapter.generate(createInput("Test"));
      const output = await getResult(handle);
      expect(output.message?.content).toContainEqual({ type: "text", text: "Hello world" });
    });

    it("should handle tool calls", async () => {
      const adapter = createTestAdapter();
      adapter.respondWith([
        "Let me search",
        { tool: { name: "search", input: { query: "test" } } },
      ]);

      const handle = await adapter.generate(createInput("Search for test"));
      const output = await getResult(handle);

      expect(output.message?.content).toContainEqual({ type: "text", text: "Let me search" });
      expect(output.toolCalls).toBeDefined();
      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0].name).toBe("search");
      expect(output.toolCalls![0].input).toEqual({ query: "test" });
      expect(output.stopReason).toBe("tool_use");
    });

    it("should handle parallel tool calls", async () => {
      const adapter = createTestAdapter();
      adapter.respondWith([
        {
          tool: [
            { name: "search", input: { query: "a" } },
            { name: "search", input: { query: "b" } },
          ],
        },
      ]);

      const handle = await adapter.generate(createInput("Search"));
      const output = await getResult(handle);
      expect(output.toolCalls).toHaveLength(2);
    });

    it("should be consumed after one call", async () => {
      const adapter = createTestAdapter({ defaultResponse: "Default" });
      adapter.respondWith(["One-time"]);

      const handle1 = await adapter.generate(createInput("First"));
      const output1 = await getResult(handle1);
      expect(output1.message?.content).toContainEqual({ type: "text", text: "One-time" });

      const handle2 = await adapter.generate(createInput("Second"));
      const output2 = await getResult(handle2);
      expect(output2.message?.content).toContainEqual({ type: "text", text: "Default" });
    });

    it("should handle reasoning content", async () => {
      const adapter = createTestAdapter();
      adapter.respondWith([{ reasoning: "Let me think..." }, "The answer is 42"]);

      const handle = await adapter.generate(createInput("What is the meaning?"));
      const output = await getResult(handle);

      const reasoningBlock = output.message?.content.find((b: any) => b.type === "reasoning");
      const textBlock = output.message?.content.find((b: any) => b.type === "text");

      expect(reasoningBlock).toBeDefined();
      expect((reasoningBlock as any).text).toBe("Let me think...");
      expect(textBlock).toBeDefined();
      expect((textBlock as any).text).toBe("The answer is 42");
    });
  });

  describe("setToolCalls", () => {
    it("should include tool calls in response", async () => {
      const adapter = createTestAdapter();
      adapter.setToolCalls([{ id: "tc1", name: "get_weather", input: { city: "NYC" } }]);

      const handle = await adapter.generate(createInput("Weather?"));
      const output = await getResult(handle);

      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0].name).toBe("get_weather");
      expect(output.stopReason).toBe("tool_use");
    });
  });

  describe("setError", () => {
    it("should throw error on generate", async () => {
      const adapter = createTestAdapter();
      const testError = new Error("Test error");
      adapter.setError(testError);

      const handle = await adapter.generate(createInput("Test"));
      await expect(getResult(handle)).rejects.toThrow("Test error");
    });

    it("should clear error when set to null", async () => {
      const adapter = createTestAdapter();
      adapter.setError(new Error("Error"));
      adapter.setError(null);

      const handle = await adapter.generate(createInput("Test"));
      const output = await getResult(handle);
      expect(output.message?.content).toContainEqual({ type: "text", text: "Test response" });
    });
  });

  describe("delay", () => {
    it("should delay response", async () => {
      const adapter = createTestAdapter({ delay: 50 });
      const start = Date.now();

      const handle = await adapter.generate(createInput("Test"));
      await getResult(handle);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });
  });

  describe("responseGenerator", () => {
    it("should use generator for dynamic responses", async () => {
      const adapter = createTestAdapter({
        responseGenerator: (input) => {
          const lastMsg = input.messages.at(-1);
          const text = ((lastMsg as ModelMessage)?.content[0] as TextBlock)?.text || "";
          return `Echo: ${text}`;
        },
      });

      const handle = await adapter.generate(createInput("Hello"));
      const output = await getResult(handle);
      expect(output.message?.content).toContainEqual({ type: "text", text: "Echo: Hello" });
    });
  });

  describe("mocks", () => {
    it("should track execute calls", async () => {
      const adapter = createTestAdapter();
      const input = createInput("Test");

      const handle = await adapter.generate(input);
      await getResult(handle);

      expect(adapter.mocks.execute).toHaveBeenCalledTimes(1);
      expect(adapter.mocks.execute).toHaveBeenCalledWith(input);
    });

    it("should track executeStream calls", async () => {
      const adapter = createTestAdapter();
      const input = createInput("Test");

      // stream() also returns a handle, need to iterate its events
      const handle = await adapter.stream!(input);
      const events: any[] = [];
      for await (const event of handle) {
        events.push(event);
      }

      expect(adapter.mocks.executeStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("streaming", () => {
    it("should stream response in chunks when enabled", async () => {
      const adapter = createTestAdapter({
        defaultResponse: "Hello World",
        streaming: { enabled: true, chunkSize: 5, chunkDelay: 0 },
      });

      const handle = await adapter.stream!(createInput("Test"));
      const events: any[] = [];
      for await (const event of handle) {
        events.push(event);
      }

      // Should have content_delta events
      const contentDeltas = events.filter((e) => e.type === "content_delta");
      expect(contentDeltas.length).toBeGreaterThan(1);

      // Concatenated text should match
      const fullText = contentDeltas.map((e) => e.delta).join("");
      expect(fullText).toBe("Hello World");
    });
  });

  describe("ModelClass interface", () => {
    it("should have metadata", () => {
      const adapter = createTestAdapter();
      expect(adapter.metadata).toBeDefined();
      expect(adapter.metadata.id).toBe("test-adapter");
      expect(adapter.metadata.provider).toBe("test");
    });

    it("should have generate procedure", () => {
      const adapter = createTestAdapter();
      expect(adapter.generate).toBeDefined();
      expect(typeof adapter.generate).toBe("function");
    });

    it("should have stream procedure", () => {
      const adapter = createTestAdapter();
      expect(adapter.stream).toBeDefined();
      expect(typeof adapter.stream).toBe("function");
    });
  });
});
