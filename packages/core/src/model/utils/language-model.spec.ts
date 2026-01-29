import { fromEngineState, toEngineState } from "./language-model";
import type { COMInput } from "../../com/types";
import type { EventMessage, Message } from "../../content";
import { type ModelOutput } from "../model";
import { StopReason } from "@tentickle/shared";

describe("language-model transformers", () => {
  describe("fromEngineState", () => {
    describe("event role transformation", () => {
      it("should transform event role messages to user role with event prefix", async () => {
        const input: COMInput = {
          timeline: [
            {
              kind: "message",
              message: {
                role: "event",
                content: [
                  {
                    type: "user_action",
                    action: "view_invoice",
                    actor: "user",
                    details: { invoice_id: "123" },
                  },
                ],
              } as EventMessage,
            },
            {
              kind: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: "What is this invoice about?" }],
              },
            },
          ],
          sections: {},
          system: [], // System messages are separate from timeline
          tools: [],
          ephemeral: [],
          metadata: {},
        };

        const result = await fromEngineState(input);

        // Should have 2 messages
        expect(result.messages).toHaveLength(2);

        // First message should be transformed from event to user with formatted content
        const firstMsg = result.messages[0] as Message;
        expect(firstMsg.role).toBe("user");
        expect(firstMsg.content).toHaveLength(1);
        // Event block generates text from semantic fields: actor + action
        expect(firstMsg.content[0]).toEqual({ type: "text", text: "[Event] user view_invoice" });

        // Second message should be unchanged
        const secondMsg = result.messages[1] as Message;
        expect(secondMsg.role).toBe("user");
        expect(secondMsg.content).toHaveLength(1);
      });

      it("should preserve other message roles unchanged", async () => {
        const input: COMInput = {
          timeline: [
            {
              kind: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: "Hello" }],
              },
            },
            {
              kind: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Hi there!" }],
              },
            },
          ],
          // System messages are now separate from timeline (wrapped in COMTimelineEntry)
          system: [
            {
              kind: "message",
              message: {
                role: "system",
                content: [{ type: "text", text: "You are helpful." }],
              },
            },
          ],
          sections: {},
          tools: [],
          ephemeral: [],
          metadata: {},
        };

        const result = await fromEngineState(input);

        // System should be first (from input.system), then other messages
        expect(result.messages[0]).toMatchObject({ role: "system" });
        expect(result.messages[1]).toMatchObject({ role: "user" });
        expect(result.messages[2]).toMatchObject({ role: "assistant" });
      });
    });
  });

  describe("toEngineState", () => {
    const baseOutput: ModelOutput = {
      model: "test-model",
      createdAt: new Date().toISOString(),
      stopReason: StopReason.STOP,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      raw: {},
    };

    describe("tool message handling", () => {
      it("should extract pending tool calls from messages without results", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.TOOL_USE,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  toolUseId: "tool_1",
                  name: "get_weather",
                  input: { city: "NYC" },
                } as any,
              ],
            },
          ],
        };

        const result = await toEngineState(output);

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0]).toMatchObject({
          id: "tool_1",
          name: "get_weather",
          input: { city: "NYC" },
        });
        expect(result.executedToolResults).toBeUndefined();
      });

      it("should extract executed tool results from tool role messages", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  toolUseId: "tool_1",
                  name: "get_weather",
                  input: { city: "NYC" },
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "tool_1",
                  name: "get_weather",
                  content: [{ type: "text", text: "Sunny, 72°F" }],
                  isError: false,
                } as any,
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "The weather in NYC is sunny and 72°F." }],
            },
          ],
        };

        const result = await toEngineState(output);

        // Tool call should NOT be in pending (it was executed)
        expect(result.toolCalls).toBeUndefined();

        // Should have executed tool result
        expect(result.executedToolResults).toHaveLength(1);
        expect(result.executedToolResults![0]).toMatchObject({
          toolUseId: "tool_1",
          name: "get_weather",
          content: [{ type: "text", text: "Sunny, 72°F" }],
          success: true,
          executedBy: "adapter",
        });
      });

      it("should separate pending from executed when mixed", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.TOOL_USE,
          messages: [
            {
              role: "assistant",
              content: [
                // This was executed
                {
                  type: "tool_use",
                  toolUseId: "tool_1",
                  name: "search",
                  input: { q: "test" },
                } as any,
                // This is pending
                {
                  type: "tool_use",
                  toolUseId: "tool_2",
                  name: "calculate",
                  input: { x: 5 },
                } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "tool_1",
                  name: "search",
                  content: [{ type: "text", text: "Found results" }],
                } as any,
              ],
            },
          ],
        };

        const result = await toEngineState(output);

        // Only tool_2 should be pending
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0].id).toBe("tool_2");

        // tool_1 should be in executed
        expect(result.executedToolResults).toHaveLength(1);
        expect(result.executedToolResults![0].toolUseId).toBe("tool_1");
      });

      it("should handle tool results with isError flag", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", toolUseId: "tool_1", name: "risky_op", input: {} } as any,
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "tool_1",
                  name: "risky_op",
                  content: [{ type: "text", text: "Operation failed" }],
                  isError: true,
                } as any,
              ],
            },
          ],
        };

        const result = await toEngineState(output);

        expect(result.executedToolResults).toHaveLength(1);
        expect(result.executedToolResults![0].success).toBe(false);
      });
    });

    describe("message array handling", () => {
      it("should use messages array when provided", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "First response" }] },
            { role: "assistant", content: [{ type: "text", text: "Second response" }] },
          ],
          message: { role: "assistant", content: [{ type: "text", text: "Should be ignored" }] },
        };

        const result = await toEngineState(output);

        expect(result.newTimelineEntries).toHaveLength(2);
        expect((result.newTimelineEntries![0].message as Message).content[0]).toMatchObject({
          type: "text",
          text: "First response",
        });
      });

      it("should fall back to message when messages is empty", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          messages: [],
          message: { role: "assistant", content: [{ type: "text", text: "Single message" }] },
        };

        const result = await toEngineState(output);

        expect(result.newTimelineEntries).toHaveLength(1);
        expect((result.newTimelineEntries![0].message as Message).content[0]).toMatchObject({
          type: "text",
          text: "Single message",
        });
      });

      it("should filter out tool role messages from timeline entries", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "Hello" }] },
            {
              role: "tool",
              content: [{ type: "tool_result", toolUseId: "1", name: "test", content: [] } as any],
            },
            { role: "assistant", content: [{ type: "text", text: "Goodbye" }] },
          ],
        };

        const result = await toEngineState(output);

        // Should only have 2 entries (assistant messages, not tool)
        expect(result.newTimelineEntries).toHaveLength(2);
        expect(
          result.newTimelineEntries!.every((e) => (e.message as Message).role !== "tool"),
        ).toBe(true);
      });
    });

    describe("backward compatibility", () => {
      it("should merge legacy toolCalls with extracted tool calls", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.TOOL_USE,
          message: { role: "assistant", content: [] },
          toolCalls: [{ id: "legacy_1", name: "legacy_tool", input: { x: 1 } }],
        };

        const result = await toEngineState(output);

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0]).toMatchObject({
          id: "legacy_1",
          name: "legacy_tool",
        });
      });

      it("should dedupe tool calls by id", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.TOOL_USE,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  toolUseId: "same_id",
                  name: "tool_a",
                  input: { from: "messages" },
                } as any,
              ],
            },
          ],
          toolCalls: [
            { id: "same_id", name: "tool_a", input: { from: "legacy" } },
            { id: "different_id", name: "tool_b", input: {} },
          ],
        };

        const result = await toEngineState(output);

        // Should have 2 unique tool calls
        expect(result.toolCalls).toHaveLength(2);

        // same_id should come from messages (first), not legacy
        const sameIdCall = result.toolCalls!.find((tc) => tc.id === "same_id");
        expect(sameIdCall?.input).toEqual({ from: "messages" });
      });
    });

    describe("shouldStop logic", () => {
      it("should stop when no pending tool calls and terminal stop reason", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.STOP,
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        };

        const result = await toEngineState(output);
        expect(result.shouldStop).toBe(true);
      });

      it("should not stop when there are pending tool calls", async () => {
        const output: ModelOutput = {
          ...baseOutput,
          stopReason: StopReason.TOOL_USE,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", toolUseId: "pending", name: "tool", input: {} } as any],
            },
          ],
        };

        const result = await toEngineState(output);
        expect(result.shouldStop).toBe(false);
      });
    });
  });

  describe("modelOptions merging", () => {
    it("should merge modelOptions from COMInput into ModelInput", async () => {
      const input: COMInput = {
        timeline: [
          {
            kind: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Hello" }],
            },
          },
        ],
        sections: {},
        system: [],
        tools: [],
        ephemeral: [],
        metadata: {},
        modelOptions: {
          temperature: 0.7,
          maxTokens: 100,
        },
      };

      const result = await fromEngineState(input);

      expect(result.temperature).toBe(0.7);
      expect(result.maxTokens).toBe(100);
    });

    it("should use parameter modelOptions over COMInput modelOptions", async () => {
      const input: COMInput = {
        timeline: [],
        sections: {},
        system: [],
        tools: [],
        ephemeral: [],
        metadata: {},
        modelOptions: {
          temperature: 0.5,
          maxTokens: 50,
        },
      };

      // Parameter takes precedence
      const result = await fromEngineState(input, {
        temperature: 0.9,
        maxTokens: 200,
      });

      expect(result.temperature).toBe(0.9);
      expect(result.maxTokens).toBe(200);
    });

    it("should not include undefined modelOptions fields", async () => {
      const input: COMInput = {
        timeline: [],
        sections: {},
        system: [],
        tools: [],
        ephemeral: [],
        metadata: {},
        // No modelOptions
      };

      const result = await fromEngineState(input);

      expect(result.temperature).toBeUndefined();
      expect(result.maxTokens).toBeUndefined();
    });

    it("should merge topP and other options", async () => {
      const input: COMInput = {
        timeline: [],
        sections: {},
        system: [],
        tools: [],
        ephemeral: [],
        metadata: {},
        modelOptions: {
          topP: 0.95,
          frequencyPenalty: 0.5,
          presencePenalty: 0.3,
        },
      };

      const result = await fromEngineState(input);

      expect(result.topP).toBe(0.95);
      expect(result.frequencyPenalty).toBe(0.5);
      expect(result.presencePenalty).toBe(0.3);
    });
  });
});
