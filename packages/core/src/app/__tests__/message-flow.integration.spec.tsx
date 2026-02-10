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
import { useConversationHistory, useQueuedMessages, useTickState } from "../../hooks";
import type { COMTimelineEntry } from "../../com/types";
import type { MessageRoles, ModelMessage } from "@agentick/shared";
import { createTestAdapter } from "../../testing";

// Helper to create a mock model that captures input using the shared test utility
function createMockModel() {
  const model = createTestAdapter({
    defaultResponse: "Response",
  });

  return {
    model,
    getCapturedInputs: () => model.getCapturedInputs(),
    clearCapturedInputs: () => model.clearCapturedInputs(),
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
      const session = await app.session();

      const handle = await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      });

      await handle.result;

      // Pending messages should have included the user message during render
      expect(_capturedPending.length).toBeGreaterThanOrEqual(1);
      const userPending = _capturedPending.find((m) => m.type === "message");
      expect(userPending).toBeDefined();

      await session.close();
    });

    it("should have empty conversation history on first tick (user message is queued, not in history)", async () => {
      const mockModel = createMockModel();
      let historyDuringRender: COMTimelineEntry[] = [];
      let queuedDuringRender: any[] = [];

      const Agent = () => {
        historyDuringRender = useConversationHistory();
        queuedDuringRender = useQueuedMessages();
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline>
              {(history, pending = []) => (
                <>
                  {history.map((entry, i) =>
                    entry.message ? <Message key={i} {...entry.message} /> : null,
                  )}
                  {pending.map((message, i) => (
                    <Message
                      key={i}
                      role={message.type as MessageRoles}
                      {...(message.content as any[])}
                    />
                  ))}
                </>
              )}
            </Timeline>
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      const handle = await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Test message" }],
          },
        ],
      });

      await handle.result;

      // On first tick, conversation history should be empty (no previous tick)
      // The user message is in queuedMessages, not history
      expect(historyDuringRender.length).toBe(0);

      // User message should be in queued messages
      const userQueued = queuedDuringRender.find((m) => m.type === "message");
      expect(userQueued).toBeDefined();

      await session.close();
    });

    it("should include user message in conversation history on SECOND tick", async () => {
      const mockModel = createMockModel();
      let historyDuringSecondTick: COMTimelineEntry[] = [];
      let tickNumber = 0;

      const Agent = () => {
        tickNumber++;
        if (tickNumber >= 2) {
          historyDuringSecondTick = useConversationHistory();
        }
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First message" }],
          },
        ],
      }).result;

      // Second tick - should now see first message in history
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Second message" }],
          },
        ],
      }).result;

      // History during second tick should include messages from first tick
      const userEntry = historyDuringSecondTick.find((e) => e.message?.role === "user");
      expect(userEntry).toBeDefined();

      await session.close();
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
      const session = await app.session();

      const handle = await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Model should see this" }],
          },
        ],
      });

      await handle.result;

      // Check that fromEngineState was called with the user message
      // createTestAdapter captures ModelInput (after fromEngineState transforms COMInput)
      const capturedInputs = mockModel.getCapturedInputs();
      expect(capturedInputs.length).toBeGreaterThanOrEqual(1);

      const lastInput = capturedInputs[capturedInputs.length - 1];
      // ModelInput has `messages` array, not `timeline`
      const userMessages = (lastInput.messages as ModelMessage[]).filter(
        (m: any) => m.role === "user",
      );
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      const userMessage = userMessages[0];
      expect(userMessage.content).toEqual([{ type: "text", text: "Model should see this" }]);

      await session.close();
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
      const session = await app.session();

      // First message
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First message" }],
          },
        ],
      }).result;

      // Second message - should see history from first tick
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Second message" }],
          },
        ],
      }).result;

      // The last capture should have accumulated history
      const lastHistory = allHistoryCaptures[allHistoryCaptures.length - 1];

      // Should have user messages
      const userMessages = lastHistory.filter((e) => e.message?.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      // Check that we captured history multiple times (multiple renders)
      expect(allHistoryCaptures.length).toBeGreaterThan(1);

      await session.close();
    });
  });

  describe("message deduplication", () => {
    it("should not duplicate messages in useConversationHistory across ticks", async () => {
      const mockModel = createMockModel();
      let historyOnSecondTick: COMTimelineEntry[] = [];
      let tickNumber = 0;

      const Agent = () => {
        tickNumber++;
        // Capture history on second tick (first tick's message should now be in history)
        // Note: Using same pattern as the passing "should include user message" test
        if (tickNumber >= 2) {
          historyOnSecondTick = useConversationHistory();
        }
        return (
          <>
            <Model model={mockModel.model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First tick - send a message
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Unique message" }],
          },
        ],
      }).result;

      // Second tick - now the first message should be in history
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Another message" }],
          },
        ],
      }).result;

      // History on second tick should contain user messages from first tick
      // Count user messages to verify no duplication
      const userMessages = historyOnSecondTick.filter((e) => e.message?.role === "user");

      // Should have exactly 1 user message from first tick
      // (the second tick's message is queued, not in history yet)
      expect(userMessages.length).toBe(1);

      await session.close();
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
      const session = await app.session();

      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Test" }],
          },
        ],
      }).result;

      expect(capturedInput).not.toBeNull();

      const userEntry = capturedInput.timeline.find((e: any) => e.message?.role === "user");

      expect(userEntry).toBeDefined();
      expect(userEntry.kind).toBe("message");
      expect(userEntry.message).toBeDefined();
      expect(userEntry.message.role).toBe("user");
      expect(userEntry.message.content).toEqual([{ type: "text", text: "Test" }]);

      await session.close();
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
      const session = await app.session();

      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
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

      await session.close();
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
      const session = await app.session();

      // No props have been set yet
      const handle = await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First message ever" }],
          },
        ],
      });

      await handle.result;

      expect(tickCount).toBeGreaterThanOrEqual(1);
      // createTestAdapter exposes mocks via .mocks property
      expect(mockModel.model.mocks.executeStream).toHaveBeenCalled();

      await session.close();
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
      const session = await app.session();

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "One" }] }],
      }).result;

      const firstRenderCount = renderCount;

      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Two" }] }],
      }).result;

      // Should have rendered more times for the second tick
      expect(renderCount).toBeGreaterThan(firstRenderCount);

      await session.close();
    });
  });
});
