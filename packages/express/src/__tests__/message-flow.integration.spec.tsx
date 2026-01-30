/**
 * Express Handler Integration Tests
 *
 * These tests verify the handler creates sessions correctly
 * and routes requests to the appropriate endpoints.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import { createTentickleHandler } from "../router";
import { createApp, Model, System, Timeline } from "@tentickle/core";
import type { App } from "@tentickle/core";

// Helper to create a mock model
function createMockModel() {
  return {
    metadata: {
      id: "test-model",
      provider: "test",
      model: "test",
      capabilities: ["streaming", "tools"] as const,
    },
    generate: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: [{ type: "text", text: "Test response" }] },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "stop",
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield { type: "content_delta", delta: "Test ", role: "assistant" };
      yield { type: "content_delta", delta: "response", role: "assistant" };
      yield {
        type: "result",
        message: { role: "assistant", content: [{ type: "text", text: "Test response" }] },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "stop",
      };
    }),
    fromEngineState: vi.fn().mockImplementation(async (input: any) => {
      return {
        messages: [
          ...(input.system || []).map((e: any) => e.message),
          ...input.timeline.filter((e: any) => e.kind === "message").map((e: any) => e.message),
        ],
        tools: input.tools || [],
      };
    }),
    toEngineState: vi.fn().mockImplementation(async (output: any) => ({
      message: output.message,
      toolCalls: [],
      stopReason: { reason: "stop", description: "Completed", recoverable: false },
      usage: output.usage,
    })),
  };
}

describe("Express Handler Setup", () => {
  let expressApp: Express;
  let tentickleApp: App;
  let mockModel: ReturnType<typeof createMockModel>;

  beforeEach(() => {
    mockModel = createMockModel();

    const Agent = () => {
      return (
        <>
          <Model model={mockModel as any} />
          <System>You are a test assistant</System>
          <Timeline />
        </>
      );
    };

    tentickleApp = createApp(Agent, { maxTicks: 1 });
    expressApp = express();
    expressApp.use(express.json());
  });

  describe("createTentickleHandler", () => {
    it("should create a valid express router", () => {
      const handler = createTentickleHandler(tentickleApp);

      expect(handler).toBeDefined();
      expect(typeof handler).toBe("function");
    });

    it("should accept custom options", () => {
      const handler = createTentickleHandler(tentickleApp, {
        authenticate: (req) => ({ userId: req.headers["x-user-id"] as string }),
      });

      expect(handler).toBeDefined();
    });
  });

  describe("Session management", () => {
    it("should create session on demand", () => {
      // App should be able to create sessions
      const session = tentickleApp.session("test-session");

      expect(session).toBeDefined();
      expect(session.id).toBe("test-session");
    });

    it("should reuse existing session with same ID", () => {
      const session1 = tentickleApp.session("reuse-session");
      const session2 = tentickleApp.session("reuse-session");

      // Should be the same session instance
      expect(session1).toBe(session2);
    });

    it("should create different sessions for different IDs", () => {
      const session1 = tentickleApp.session("session-a");
      const session2 = tentickleApp.session("session-b");

      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe("Message handling via session", () => {
    it("should handle send with message", async () => {
      const session = tentickleApp.session("send-test");

      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      });

      // Collect events to verify execution happened
      const events: any[] = [];
      for await (const event of handle) {
        events.push(event);
      }

      // Should have received events
      expect(events.length).toBeGreaterThan(0);

      // Should have execution_start
      const hasExecutionStart = events.some((e) => e.type === "execution_start");
      expect(hasExecutionStart).toBe(true);
    });

    it("should pass user message to model", async () => {
      const session = tentickleApp.session("model-test");

      await session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Test message" }],
        },
      }).result;

      // Model's fromEngineState should have been called
      expect(mockModel.fromEngineState).toHaveBeenCalled();

      // Check that user message was in the input
      const calls = mockModel.fromEngineState.mock.calls;
      const lastCall = calls[calls.length - 1];
      const input = lastCall[0];

      const userEntries = input.timeline.filter((e: any) => e.message?.role === "user");
      expect(userEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("should stream events from execution", async () => {
      const session = tentickleApp.session("stream-test");

      const handle = session.send({
        message: {
          role: "user",
          content: [{ type: "text", text: "Stream test" }],
        },
      });

      const events: any[] = [];
      for await (const event of handle) {
        events.push(event);
      }

      // Should have received events
      expect(events.length).toBeGreaterThan(0);

      // Should have common event types
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("execution_start");
    });
  });
});

describe("Handler with Custom Options", () => {
  it("should accept authentication handler", async () => {
    const mockModel = createMockModel();

    const Agent = () => (
      <>
        <Model model={mockModel as any} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });

    const authHandler = vi.fn().mockReturnValue({ userId: "user-123" });

    const handler = createTentickleHandler(app, {
      authenticate: authHandler,
    });

    // The handler should be created successfully
    expect(handler).toBeDefined();
  });
});
