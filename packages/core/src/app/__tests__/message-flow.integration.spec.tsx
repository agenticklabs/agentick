/**
 * Message Flow Integration Tests
 *
 * These tests verify that user messages flow correctly through the entire
 * session lifecycle: from queueing through compilation to model input.
 *
 * Key flows tested:
 * 1. session.send() queues messages correctly
 * 2. Queued messages transfer to COM before compilation
 * 3. useConversationHistory() sees queued messages during render
 * 4. formatInput() includes user messages in model input
 * 5. fromEngineState() extracts messages for the model adapter
 */

import { describe, it, expect, vi } from "vitest";
import { createApp, Model, System, Timeline, Message } from "../../index";
import { useConversationHistory, useQueuedMessages, useTickState } from "../../state/hooks";
import type { COMTimelineEntry } from "../../com/types";

// Helper to create a mock model that captures input
function createMockModel() {
  const capturedInputs: any[] = [];

  return {
    model: {
      metadata: { id: "test-model", provider: "test", model: "test" },
      generate: vi.fn().mockResolvedValue({
        message: { role: "assistant", content: [{ type: "text", text: "Response" }] },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "stop",
      }),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "content_delta", delta: "Response", role: "assistant" };
        yield {
          type: "result",
          message: { role: "assistant", content: [{ type: "text", text: "Response" }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "stop",
        };
      }),
      fromEngineState: vi.fn().mockImplementation(async (input) => {
        capturedInputs.push(input);
        return {
          messages: input.timeline
            .filter((e: any) => e.kind === "message")
            .map((e: any) => e.message),
          tools: input.tools || [],
        };
      }),
      toEngineState: vi.fn().mockImplementation(async (output) => ({
        message: output.message,
        toolCalls: [],
        stopReason: { reason: "stop", description: "Completed", recoverable: false },
        usage: output.usage,
      })),
    },
    getCapturedInputs: () => capturedInputs,
    clearCapturedInputs: () => {
      capturedInputs.length = 0;
    },
  };
}

describe("Message Flow Integration", () => {
  describe("session.send() message queuing", () => {
    it("should queue user message via send()", async () => {
      const mockModel = createMockModel();
      let _capturedHistory: COMTimelineEntry[] = [];
      let _capturedPending: any[] = [];

      const Agent = () => {
        _capturedHistory = useConversationHistory();
        _capturedPending = useQueuedMessages();
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test system</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello world" }],
        },
      });

      await handle.result;

      // Pending messages should have included the user message during render
      expect(_capturedPending.length).toBeGreaterThanOrEqual(1);
      const userPending = _capturedPending.find((m) => m.type === "user");
      expect(userPending).toBeDefined();

      session.close();
    });

    it("should include user message in conversation history during first tick", async () => {
      const mockModel = createMockModel();
      let historyDuringRender: COMTimelineEntry[] = [];

      const Agent = () => {
        historyDuringRender = useConversationHistory();
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline>
              {(history) => (
                <>
                  {history.map((entry, i) =>
                    entry.message ? <Message key={i} {...entry.message} /> : null,
                  )}
                </>
              )}
            </Timeline>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Test message" }],
        },
      });

      await handle.result;

      // History should include the user message
      const userEntry = historyDuringRender.find((e) => e.message?.role === "user");
      expect(userEntry).toBeDefined();
      expect(userEntry?.message?.content).toEqual([{ type: "text", text: "Test message" }]);

      session.close();
    });

    it("should pass user message to model via fromEngineState", async () => {
      const mockModel = createMockModel();

      const Agent = () => {
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Model should see this" }],
        },
      });

      await handle.result;

      // Check that fromEngineState was called with the user message
      const capturedInputs = mockModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(1);

      const lastInput = capturedInputs[capturedInputs.length - 1];
      const userEntries = lastInput.timeline.filter((e: any) => e.message?.role === "user");
      expect(userEntries.length).toBeGreaterThanOrEqual(1);

      const userMessage = userEntries[0].message;
      expect(userMessage.content).toEqual([{ type: "text", text: "Model should see this" }]);

      session.close();
    });
  });

  describe("multiple messages in conversation", () => {
    it("should accumulate messages across ticks", async () => {
      const mockModel = createMockModel();
      const allHistoryCaptures: COMTimelineEntry[][] = [];

      const Agent = () => {
        const history = useConversationHistory();
        // Capture history at each render
        allHistoryCaptures.push([...history]);
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      // First message
      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "First message" }],
        },
      }).result;

      // Second message - should see history from first tick
      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Second message" }],
        },
      }).result;

      // The last capture should have accumulated history
      const lastHistory = allHistoryCaptures[allHistoryCaptures.length - 1];

      // Should have user messages
      const userMessages = lastHistory.filter((e) => e.message?.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      // Check that we captured history multiple times (multiple renders)
      expect(allHistoryCaptures.length).toBeGreaterThan(1);

      session.close();
    });
  });

  describe("message deduplication", () => {
    it("should not duplicate messages in useConversationHistory", async () => {
      const mockModel = createMockModel();
      let historyDuringRender: COMTimelineEntry[] = [];

      const Agent = () => {
        historyDuringRender = useConversationHistory();
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline>
              {(history) => (
                <>
                  {history.map((entry, i) =>
                    entry.message ? <Message key={i} {...entry.message} /> : null,
                  )}
                </>
              )}
            </Timeline>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Unique message" }],
        },
      }).result;

      // Count how many times the exact message appears
      const uniqueMessageCount = historyDuringRender.filter(
        (e) =>
          e.message?.role === "user" &&
          Array.isArray(e.message?.content) &&
          e.message?.content[0]?.type === "text" &&
          (e.message?.content[0] as any)?.text === "Unique message",
      ).length;

      // Should only appear once, not duplicated
      expect(uniqueMessageCount).toBe(1);

      session.close();
    });
  });

  describe("timeline entry structure", () => {
    it("should have correct kind and message structure", async () => {
      const mockModel = createMockModel();
      let capturedInput: any = null;

      mockModel.model.fromEngineState = vi.fn().mockImplementation(async (input) => {
        capturedInput = input;
        return {
          messages: input.timeline
            .filter((e: any) => e.kind === "message")
            .map((e: any) => e.message),
          tools: [],
        };
      });

      const Agent = () => {
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Test" }],
        },
      }).result;

      expect(capturedInput).not.toBeNull();

      const userEntry = capturedInput.timeline.find((e: any) => e.message?.role === "user");

      expect(userEntry).toBeDefined();
      expect(userEntry.kind).toBe("message");
      expect(userEntry.message).toBeDefined();
      expect(userEntry.message.role).toBe("user");
      expect(userEntry.message.content).toEqual([{ type: "text", text: "Test" }]);

      session.close();
    });
  });

  describe("system messages separation", () => {
    it("should keep system messages separate from timeline", async () => {
      const mockModel = createMockModel();
      let capturedInput: any = null;

      mockModel.model.fromEngineState = vi.fn().mockImplementation(async (input) => {
        capturedInput = input;
        return {
          messages: [
            ...(input.system || []).map((e: any) => e.message),
            ...input.timeline.filter((e: any) => e.kind === "message").map((e: any) => e.message),
          ],
          tools: [],
        };
      });

      const Agent = () => {
        return (
          <>
            <Model model={mockModel.model} />
            <System>You are a helpful assistant</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      }).result;

      expect(capturedInput).not.toBeNull();

      // System messages should be in input.system
      expect(capturedInput.system).toBeDefined();
      expect(capturedInput.system.length).toBeGreaterThanOrEqual(1);

      // Timeline should not contain system messages
      const systemInTimeline = capturedInput.timeline.filter(
        (e: any) => e.message?.role === "system",
      );
      expect(systemInTimeline.length).toBe(0);

      session.close();
    });
  });
});

describe("Session Lifecycle", () => {
  describe("fresh session behavior", () => {
    it("should execute tick on fresh session with send()", async () => {
      const mockModel = createMockModel();
      let tickCount = 0;

      const Agent = () => {
        const state = useTickState();
        tickCount = state.tick;
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      // No props have been set yet
      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "First message ever" }],
        },
      });

      await handle.result;

      expect(tickCount).toBeGreaterThanOrEqual(1);
      expect(mockModel.model.stream).toHaveBeenCalled();

      session.close();
    });
  });

  describe("session state persistence", () => {
    it("should persist hook state across ticks", async () => {
      const mockModel = createMockModel();
      let renderCount = 0;

      const Agent = () => {
        renderCount++;
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = app.session();

      await session.send({
        message: { role: "user", content: [{ type: "text", text: "One" }] },
      }).result;

      const firstRenderCount = renderCount;

      await session.send({
        message: { role: "user", content: [{ type: "text", text: "Two" }] },
      }).result;

      // Should have rendered more times for the second tick
      expect(renderCount).toBeGreaterThan(firstRenderCount);

      session.close();
    });
  });
});
