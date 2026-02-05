/**
 * Model Input Flow Tests
 *
 * These tests verify that messages flow correctly from the COM
 * through formatInput and fromEngineState to the model adapter.
 */

import { describe, it, expect } from "vitest";
import { fromEngineState, toEngineState } from "../utils/language-model";
import type { COMInput, COMTimelineEntry } from "../../com/types";
import type { Message, TextBlock, ToolResultBlock, ToolUseBlock } from "@tentickle/shared";
import type { ModelOutput } from "../model";

// Helper to create a COMTimelineEntry
function createTimelineEntry(message: Message, kind: string = "message"): COMTimelineEntry {
  return {
    kind: kind as any,
    message,
    tags: [],
  };
}

// Helper to create a basic COMInput
function createCOMInput(
  timelineEntries: COMTimelineEntry[],
  systemEntries: COMTimelineEntry[] = [],
): COMInput {
  return {
    timeline: timelineEntries,
    sections: {},
    ephemeral: [],
    system: systemEntries,
    tools: [],
    metadata: {},
  };
}

describe("fromEngineState", () => {
  describe("timeline message extraction", () => {
    it("should extract user messages from timeline", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        }),
      ]);

      const modelInput = await fromEngineState(input);

      expect(modelInput.messages).toBeDefined();
      expect(modelInput.messages.length).toBeGreaterThanOrEqual(1);

      const userMessage = (modelInput.messages as Message[]).find((m: any) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect((userMessage!.content[0] as TextBlock).text).toBe("Hello");
    });

    it("should extract assistant messages from timeline", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
        }),
      ]);

      const modelInput = await fromEngineState(input);

      const assistantMessage = (modelInput.messages as Message[]).find(
        (m: any) => m.role === "assistant",
      );
      expect(assistantMessage).toBeDefined();
      expect((assistantMessage!.content[0] as TextBlock).text).toBe("Response");
    });

    it("should preserve message order", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [{ type: "text", text: "First" }],
        }),
        createTimelineEntry({
          role: "assistant",
          content: [{ type: "text", text: "Second" }],
        }),
        createTimelineEntry({
          role: "user",
          content: [{ type: "text", text: "Third" }],
        }),
      ]);

      const modelInput = await fromEngineState(input);

      // Messages should be in order (system first, then timeline)
      const conversationMessages = (modelInput.messages as Message[]).filter(
        (m: any) => m.role !== "system",
      );

      expect(conversationMessages.length).toBe(3);
      expect((conversationMessages[0]!.content[0] as TextBlock).text).toBe("First");
      expect((conversationMessages[1]!.content[0] as TextBlock).text).toBe("Second");
      expect((conversationMessages[2]!.content[0] as TextBlock).text).toBe("Third");
    });

    it("should filter out non-message entries", async () => {
      const input = createCOMInput([
        createTimelineEntry(
          { role: "user", content: [{ type: "text", text: "Keep this" }] },
          "message",
        ),
        // Entry with different kind should be filtered
        {
          kind: "other" as any,
          message: { role: "user", content: [{ type: "text", text: "Filter this" }] },
          tags: [],
        },
      ]);

      const modelInput = await fromEngineState(input);

      const messages = (modelInput.messages as Message[]).filter((m: any) => m.role === "user");
      expect(messages.length).toBe(1);
      expect((messages[0]!.content[0] as TextBlock).text).toBe("Keep this");
    });
  });

  describe("system message handling", () => {
    it("should include system messages from input.system", async () => {
      const input = createCOMInput(
        [],
        [
          createTimelineEntry({
            role: "system",
            content: [{ type: "text", text: "System prompt" }],
          }),
        ],
      );

      const modelInput = await fromEngineState(input);

      const systemMessage = (modelInput.messages as Message[]).find(
        (m: any) => m.role === "system",
      );
      expect(systemMessage).toBeDefined();
      expect((systemMessage!.content[0] as TextBlock).text).toBe("System prompt");
    });

    it("should place system messages before conversation messages", async () => {
      const input = createCOMInput(
        [
          createTimelineEntry({
            role: "user",
            content: [{ type: "text", text: "User message" }],
          }),
        ],
        [
          createTimelineEntry({
            role: "system",
            content: [{ type: "text", text: "System prompt" }],
          }),
        ],
      );

      const modelInput = await fromEngineState(input);

      // System should come first
      expect((modelInput.messages[0] as Message).role).toBe("system");
      expect((modelInput.messages[1] as Message).role).toBe("user");
    });
  });

  describe("content block handling", () => {
    it("should handle text blocks", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [
            { type: "text", text: "Line 1" },
            { type: "text", text: "Line 2" },
          ],
        }),
      ]);

      const modelInput = await fromEngineState(input);
      const userMessage = (modelInput.messages as Message[]).find((m: any) => m.role === "user");

      expect(userMessage!.content.length).toBe(2);
    });

    it("should handle image blocks", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [
            { type: "text", text: "Look at this:" },
            {
              type: "image",
              source: {
                type: "base64",
                mimeType: "image/png",
                data: "base64data",
              },
            },
          ],
        }),
      ]);

      const modelInput = await fromEngineState(input);
      const userMessage = (modelInput.messages as Message[]).find((m: any) => m.role === "user");

      expect(userMessage!.content.some((c: any) => c.type === "image")).toBe(true);
    });

    it("should handle tool_use blocks", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              toolUseId: "tool-1",
              name: "calculator",
              input: { expression: "2+2" },
            },
          ],
        }),
      ]);

      const modelInput = await fromEngineState(input);
      const assistantMessage = (modelInput.messages as Message[]).find(
        (m: any) => m.role === "assistant",
      );

      expect((assistantMessage!.content[0] as ToolUseBlock).type).toBe("tool_use");
    });

    it("should handle tool_result blocks", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tool-1",
              name: "calculator",
              content: [{ type: "text", text: "4" }],
            },
          ],
        }),
      ]);

      const modelInput = await fromEngineState(input);
      const userMessage = (modelInput.messages as Message[]).find((m: any) => m.role === "user");

      expect((userMessage!.content[0] as ToolResultBlock).type).toBe("tool_result");
    });
  });

  describe("empty input handling", () => {
    it("should handle empty timeline", async () => {
      const input = createCOMInput([]);

      const modelInput = await fromEngineState(input);

      expect(modelInput.messages).toBeDefined();
      expect(Array.isArray(modelInput.messages)).toBe(true);
    });

    it("should handle no system messages", async () => {
      const input = createCOMInput([
        createTimelineEntry({
          role: "user",
          content: [{ type: "text", text: "No system" }],
        }),
      ]);

      const modelInput = await fromEngineState(input);

      const systemMessages = (modelInput.messages as Message[]).filter(
        (m: any) => m.role === "system",
      );
      expect(systemMessages.length).toBe(0);
    });
  });
});

describe("model options merging", () => {
  it("should merge modelOptions into ModelInput", async () => {
    const input = createCOMInput([
      createTimelineEntry({
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      }),
    ]);

    // Add modelOptions to the input
    input.modelOptions = {
      temperature: 0.9,
      maxTokens: 2000,
      topP: 0.95,
    };

    const modelInput = await fromEngineState(input);

    expect(modelInput.temperature).toBe(0.9);
    expect(modelInput.maxTokens).toBe(2000);
    expect(modelInput.topP).toBe(0.95);
  });

  it("should merge all supported generation parameters", async () => {
    const input = createCOMInput([]);
    input.modelOptions = {
      model: "gpt-4",
      temperature: 0.5,
      maxTokens: 1000,
      topP: 0.8,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      stop: ["END"],
    };

    const modelInput = await fromEngineState(input);

    expect(modelInput.model).toBe("gpt-4");
    expect(modelInput.temperature).toBe(0.5);
    expect(modelInput.maxTokens).toBe(1000);
    expect(modelInput.topP).toBe(0.8);
    expect(modelInput.frequencyPenalty).toBe(0.2);
    expect(modelInput.presencePenalty).toBe(0.1);
    expect(modelInput.stop).toEqual(["END"]);
  });

  it("should merge providerOptions", async () => {
    const input = createCOMInput([]);
    input.modelOptions = {
      providerOptions: {
        openai: { logprobs: true },
      },
    };

    const modelInput = await fromEngineState(input);

    expect(modelInput.providerOptions).toEqual({
      openai: { logprobs: true },
    });
  });

  it("should not set undefined options", async () => {
    const input = createCOMInput([]);
    // Empty modelOptions
    input.modelOptions = {};

    const modelInput = await fromEngineState(input);

    // These should remain undefined, not be set to undefined
    expect("temperature" in modelInput && modelInput.temperature !== undefined).toBe(false);
    expect("maxTokens" in modelInput && modelInput.maxTokens !== undefined).toBe(false);
  });
});

describe("toEngineState", () => {
  it("should convert model output to engine response", async () => {
    const modelOutput = {
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Response" }],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "stop",
    };

    const engineResponse = await toEngineState(modelOutput as unknown as ModelOutput);

    // toEngineState returns newTimelineEntries, not message directly
    expect(engineResponse.newTimelineEntries).toBeDefined();
    expect(engineResponse.newTimelineEntries?.length).toBeGreaterThanOrEqual(1);
    expect(engineResponse.newTimelineEntries?.[0].message?.role).toBe("assistant");
    expect(engineResponse.stopReason).toBeDefined();
  });

  it("should extract tool calls from message", async () => {
    const modelOutput = {
      message: {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "tool-1",
            name: "calculator",
            input: { expression: "2+2" },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "tool_use",
    };

    const engineResponse = await toEngineState(modelOutput as unknown as ModelOutput);

    expect(engineResponse.toolCalls).toBeDefined();
    expect(engineResponse.toolCalls?.length).toBe(1);
    expect(engineResponse.toolCalls?.[0].name).toBe("calculator");
  });
});
