/**
 * Tests for the testing utilities themselves
 */

import { EventEmitter } from "events";
import {
  // Fixtures
  testId,
  resetTestIds,
  createTextBlock,
  createImageBlock,
  createToolUseBlock,
  createToolResultBlock,
  createUserMessage,
  createAssistantMessage,
  createConversation,
  createToolDefinition,
  // StreamEvent fixtures
  createEventBase,
  createContentStartEvent,
  createContentDeltaEvent,
  createContentEndEvent,
  createContentEvent,
  createMessageStartEvent,
  createMessageEndEvent,
  createMessageCompleteEvent,
  createToolCallStartEvent,
  createToolCallCompleteEvent,
  createExecutionStartEvent,
  createExecutionEndEvent,
  createTickStartEvent,
  createTickEndEvent,
  createToolResultEvent,
  createResultStreamEvent,
  createForkStartEvent,
  createForkEndEvent,
  createSpawnStartEvent,
  createSpawnEndEvent,
  createTextStreamEventSequence,
  createToolCallEventSequence,
  createForkEventSequence,
  createSpawnEventSequence,
  createUsageStats,
  // Helpers
  waitForEvent,
  waitForEvents,
  waitFor,
  sleep,
  createDeferred,
  captureAsyncGenerator,
  arrayToAsyncGenerator,
  createControllableGenerator,
  parseSSEEvent,
  parseSSEBuffer,
  formatSSEEvent,
  createSpy,
  createMockSequence,
} from "../testing/index.js";
import {
  StopReason,
  isModelStreamEvent,
  isOrchestrationStreamEvent,
  isFinalEvent,
  isForkEvent,
  isSpawnEvent,
} from "../streaming.js";
import { BlockType } from "../block-types.js";

describe("Fixtures", () => {
  beforeEach(() => {
    resetTestIds();
  });

  describe("testId", () => {
    it("should generate unique IDs", () => {
      const id1 = testId("test");
      const id2 = testId("test");
      const id3 = testId("other");

      expect(id1).toBe("test-1");
      expect(id2).toBe("test-2");
      expect(id3).toBe("other-3");
    });

    it("should reset counter", () => {
      testId("test");
      testId("test");
      resetTestIds();
      const id = testId("test");

      expect(id).toBe("test-1");
    });
  });

  describe("Content Block Fixtures", () => {
    it("should create text block", () => {
      const block = createTextBlock("Hello world");

      expect(block.type).toBe("text");
      expect(block.text).toBe("Hello world");
    });

    it("should create text block with overrides", () => {
      const block = createTextBlock("Hello", { id: "custom-id" });

      expect(block.id).toBe("custom-id");
    });

    it("should create image block", () => {
      const block = createImageBlock("https://example.com/img.png");

      expect(block.type).toBe("image");
      expect(block.source).toEqual({
        type: "url",
        url: "https://example.com/img.png",
      });
    });

    it("should create tool use block", () => {
      const block = createToolUseBlock("search", { query: "test" });

      expect(block.type).toBe("tool_use");
      expect(block.name).toBe("search");
      expect(block.input).toEqual({ query: "test" });
      expect(block.toolUseId).toMatch(/^tool-use-\d+$/);
    });

    it("should create tool result block", () => {
      const block = createToolResultBlock("tool-123", [createTextBlock("Result")]);

      expect(block.type).toBe("tool_result");
      expect(block.toolUseId).toBe("tool-123");
      expect(block.isError).toBe(false);
    });
  });

  describe("Message Fixtures", () => {
    it("should create user message from string", () => {
      const msg = createUserMessage("Hello");

      expect(msg.role).toBe("user");
      expect(msg.content).toEqual([{ type: "text", text: "Hello" }]);
      expect(msg.id).toMatch(/^msg-\d+$/);
    });

    it("should create assistant message", () => {
      const msg = createAssistantMessage("Hi there");

      expect(msg.role).toBe("assistant");
      expect(msg.content).toEqual([{ type: "text", text: "Hi there" }]);
    });

    it("should create conversation", () => {
      const messages = createConversation([
        { user: "Hello", assistant: "Hi!" },
        { user: "How are you?", assistant: "I am good!" },
      ]);

      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].role).toBe("user");
      expect(messages[3].role).toBe("assistant");
    });
  });

  describe("Tool Fixtures", () => {
    it("should create tool definition", () => {
      const tool = createToolDefinition("search");

      expect(tool.name).toBe("search");
      expect(tool.description).toContain("search");
      expect(tool.input).toBeDefined();
    });
  });

  describe("StreamEvent Fixtures", () => {
    describe("Event Base", () => {
      it("should create event base with defaults", () => {
        const base = createEventBase();

        expect(base.id).toMatch(/^evt-\d+$/);
        expect(base.tick).toBe(1);
        expect(base.timestamp).toBeDefined();
      });

      it("should create event base with custom tick", () => {
        const base = createEventBase(5);

        expect(base.tick).toBe(5);
      });
    });

    describe("Content Events", () => {
      it("should create content_start event", () => {
        const event = createContentStartEvent(BlockType.TEXT, 0);

        expect(event.type).toBe("content_start");
        expect(event.blockType).toBe(BlockType.TEXT);
        expect(event.blockIndex).toBe(0);
        expect(isModelStreamEvent(event)).toBe(true);
      });

      it("should create content_delta event", () => {
        const event = createContentDeltaEvent("Hello");

        expect(event.type).toBe("content_delta");
        expect(event.delta).toBe("Hello");
        expect(event.blockType).toBe(BlockType.TEXT);
      });

      it("should create content_end event", () => {
        const event = createContentEndEvent();

        expect(event.type).toBe("content_end");
      });

      it("should create content (complete) event", () => {
        const block = createTextBlock("Hello world");
        const event = createContentEvent(block, 0);

        expect(event.type).toBe("content");
        expect(event.content).toBe(block);
        expect(event.startedAt).toBeDefined();
        expect(event.completedAt).toBeDefined();
      });
    });

    describe("Message Events", () => {
      it("should create message_start event", () => {
        const event = createMessageStartEvent("gpt-4");

        expect(event.type).toBe("message_start");
        expect(event.role).toBe("assistant");
        expect(event.model).toBe("gpt-4");
      });

      it("should create message_end event", () => {
        const event = createMessageEndEvent(StopReason.STOP);

        expect(event.type).toBe("message_end");
        expect(event.stopReason).toBe(StopReason.STOP);
      });

      it("should create message (complete) event", () => {
        const message = createAssistantMessage("Hello");
        const event = createMessageCompleteEvent(message, StopReason.STOP);

        expect(event.type).toBe("message");
        expect(event.message).toBe(message);
        expect(event.stopReason).toBe(StopReason.STOP);
      });
    });

    describe("Tool Call Events", () => {
      it("should create tool_call_start event", () => {
        const event = createToolCallStartEvent("search", "call-123");

        expect(event.type).toBe("tool_call_start");
        expect(event.name).toBe("search");
        expect(event.callId).toBe("call-123");
      });

      it("should create tool_call (complete) event", () => {
        const event = createToolCallCompleteEvent("search", { query: "test" });

        expect(event.type).toBe("tool_call");
        expect(event.name).toBe("search");
        expect(event.input).toEqual({ query: "test" });
      });
    });

    describe("Token Usage", () => {
      it("should create token usage with defaults", () => {
        const usage = createUsageStats();

        expect(usage.inputTokens).toBe(10);
        expect(usage.outputTokens).toBe(20);
        expect(usage.totalTokens).toBe(30);
      });

      it("should create token usage with overrides", () => {
        const usage = createUsageStats({ inputTokens: 100, outputTokens: 200, totalTokens: 300 });

        expect(usage.inputTokens).toBe(100);
        expect(usage.outputTokens).toBe(200);
        expect(usage.totalTokens).toBe(300);
      });
    });
  });

  describe("OrchestrationStreamEvent Fixtures", () => {
    describe("Execution Events", () => {
      it("should create execution_start event", () => {
        const event = createExecutionStartEvent("exec-1", {
          metadata: { threadId: "thread-1" },
        });

        expect(event.type).toBe("execution_start");
        expect(event.executionId).toBe("exec-1");
        expect(event.metadata?.threadId).toBe("thread-1");
        expect(isOrchestrationStreamEvent(event)).toBe(true);
      });

      it("should create execution_end event", () => {
        const event = createExecutionEndEvent("exec-1", { result: "done" });

        expect(event.type).toBe("execution_end");
        expect(event.output).toEqual({ result: "done" });
      });
    });

    describe("Result Events", () => {
      it("should create result event", () => {
        const event = createResultStreamEvent();

        expect(event.type).toBe("result");
        expect(event.result.response).toBe("Test response");
        expect(isFinalEvent(event)).toBe(true);
      });
    });

    describe("Tick Events", () => {
      it("should create tick_start event", () => {
        const event = createTickStartEvent(3);

        expect(event.type).toBe("tick_start");
        expect(event.tick).toBe(3);
      });

      it("should create tick_end event", () => {
        const usage = createUsageStats();
        const event = createTickEndEvent(2, usage);

        expect(event.type).toBe("tick_end");
        expect(event.tick).toBe(2);
        expect(event.usage).toBe(usage);
      });
    });

    describe("Tool Result Events", () => {
      it("should create tool_result event", () => {
        const event = createToolResultEvent("call-1", "search", { results: [] });

        expect(event.type).toBe("tool_result");
        expect(event.callId).toBe("call-1");
        expect(event.name).toBe("search");
        expect(event.result).toEqual({ results: [] });
        expect(event.executedBy).toBe("engine");
      });
    });
  });

  describe("Fork Event Fixtures", () => {
    it("should create fork_start event", () => {
      const event = createForkStartEvent("fork-1", "exec-parent", ["a", "b", "c"], "race");

      expect(event.type).toBe("fork_start");
      expect(event.forkId).toBe("fork-1");
      expect(event.parentExecutionId).toBe("exec-parent");
      expect(event.strategy).toBe("race");
      expect(event.branches).toEqual(["a", "b", "c"]);
      expect(event.branchCount).toBe(3);
      expect(isForkEvent(event)).toBe(true);
      expect(isOrchestrationStreamEvent(event)).toBe(true);
    });

    it("should create fork_start event with input", () => {
      const event = createForkStartEvent("fork-1", "exec-parent", ["a", "b"], "vote", {
        input: { question: "What is 2+2?" },
      });

      expect(event.input).toEqual({ question: "What is 2+2?" });
    });

    it("should create fork_end event", () => {
      const results = { a: "result-a", b: "result-b" };
      const event = createForkEndEvent("fork-1", "exec-parent", results, { selectedBranch: "a" });

      expect(event.type).toBe("fork_end");
      expect(event.forkId).toBe("fork-1");
      expect(event.results).toBe(results);
      expect(event.selectedBranch).toBe("a");
      expect(isForkEvent(event)).toBe(true);
    });

    it("should create fork event sequence", () => {
      const events = createForkEventSequence(3, "vote", { query: "test" });

      expect(events).toHaveLength(2); // fork_start + fork_end
      expect(events[0].type).toBe("fork_start");
      expect(events[1].type).toBe("fork_end");

      const startEvent = events[0] as ReturnType<typeof createForkStartEvent>;
      expect(startEvent.branchCount).toBe(3);
      expect(startEvent.strategy).toBe("vote");
      expect(startEvent.input).toEqual({ query: "test" });
    });
  });

  describe("Spawn Event Fixtures", () => {
    it("should create spawn_start event", () => {
      const event = createSpawnStartEvent("spawn-1", "exec-parent", "exec-child");

      expect(event.type).toBe("spawn_start");
      expect(event.spawnId).toBe("spawn-1");
      expect(event.parentExecutionId).toBe("exec-parent");
      expect(event.childExecutionId).toBe("exec-child");
      expect(isSpawnEvent(event)).toBe(true);
      expect(isOrchestrationStreamEvent(event)).toBe(true);
    });

    it("should create spawn_start event with input and component name", () => {
      const event = createSpawnStartEvent("spawn-1", "exec-parent", "exec-child", {
        componentName: "ResearchAgent",
        input: { topic: "AI safety" },
      });

      expect(event.componentName).toBe("ResearchAgent");
      expect(event.input).toEqual({ topic: "AI safety" });
    });

    it("should create spawn_end event", () => {
      const event = createSpawnEndEvent("spawn-1", "exec-parent", "exec-child", { answer: "42" });

      expect(event.type).toBe("spawn_end");
      expect(event.spawnId).toBe("spawn-1");
      expect(event.output).toEqual({ answer: "42" });
      expect(isSpawnEvent(event)).toBe(true);
    });

    it("should create spawn event sequence", () => {
      const events = createSpawnEventSequence(
        "HelperAgent",
        { task: "research" },
        { result: "done" },
      );

      expect(events).toHaveLength(2); // spawn_start + spawn_end
      expect(events[0].type).toBe("spawn_start");
      expect(events[1].type).toBe("spawn_end");

      const startEvent = events[0] as ReturnType<typeof createSpawnStartEvent>;
      expect(startEvent.componentName).toBe("HelperAgent");
      expect(startEvent.input).toEqual({ task: "research" });

      const endEvent = events[1] as ReturnType<typeof createSpawnEndEvent>;
      expect(endEvent.output).toEqual({ result: "done" });
    });
  });

  describe("StreamEvent Sequences", () => {
    it("should create text stream event sequence with message event", () => {
      const events = createTextStreamEventSequence("Hello world", 5);

      // Should follow pattern: message_start → content_start → content_delta* → content_end → content → message_end → message
      expect(events[0].type).toBe("message_start");

      const messageEvent = events.find((e) => e.type === "message");
      expect(messageEvent).toBeDefined();
      expect(messageEvent?.type).toBe("message");

      // All events should be StreamEvents
      expect(events.every((e) => isModelStreamEvent(e))).toBe(true);
    });

    it("should create tool call event sequence with message event", () => {
      const events = createToolCallEventSequence("search", { query: "test" });

      expect(events[0].type).toBe("message_start");
      expect(events.some((e) => e.type === "tool_call")).toBe(true);

      const messageEvent = events.find((e) => e.type === "message");
      expect(messageEvent).toBeDefined();
    });
  });
});

describe("Helpers", () => {
  describe("waitForEvent", () => {
    it("should resolve when event is emitted", async () => {
      const emitter = new EventEmitter();
      const promise = waitForEvent<string>(emitter, "test");

      emitter.emit("test", "value");

      await expect(promise).resolves.toBe("value");
    });

    it("should reject on timeout", async () => {
      const emitter = new EventEmitter();
      const promise = waitForEvent(emitter, "test", 50);

      await expect(promise).rejects.toThrow("Timeout");
    });
  });

  describe("waitForEvents", () => {
    it("should collect multiple events", async () => {
      const emitter = new EventEmitter();
      const promise = waitForEvents<number>(emitter, "data", 3);

      emitter.emit("data", 1);
      emitter.emit("data", 2);
      emitter.emit("data", 3);

      await expect(promise).resolves.toEqual([1, 2, 3]);
    });
  });

  describe("waitFor", () => {
    it("should resolve when condition becomes true", async () => {
      let ready = false;
      setTimeout(() => (ready = true), 50);

      await expect(waitFor(() => ready)).resolves.toBeUndefined();
    });

    it("should reject on timeout", async () => {
      await expect(waitFor(() => false, { timeout: 50, message: "Never ready" })).rejects.toThrow(
        "Never ready",
      );
    });
  });

  describe("sleep", () => {
    it("should delay execution", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe("createDeferred", () => {
    it("should resolve when resolve is called", async () => {
      const { promise, resolve } = createDeferred<string>();

      resolve("value");

      await expect(promise).resolves.toBe("value");
    });

    it("should reject when reject is called", async () => {
      const { promise, reject } = createDeferred<string>();

      reject(new Error("failed"));

      await expect(promise).rejects.toThrow("failed");
    });
  });

  describe("captureAsyncGenerator", () => {
    it("should capture all items", async () => {
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }

      const items = await captureAsyncGenerator(gen());

      expect(items).toEqual([1, 2, 3]);
    });

    it("should timeout on infinite generator", async () => {
      async function* infinite() {
        while (true) {
          await sleep(100);
          yield 1;
        }
      }

      await expect(captureAsyncGenerator(infinite(), { timeout: 50 })).rejects.toThrow("timeout");
    });
  });

  describe("arrayToAsyncGenerator", () => {
    it("should yield items from array", async () => {
      const items = await captureAsyncGenerator(arrayToAsyncGenerator([1, 2, 3]));

      expect(items).toEqual([1, 2, 3]);
    });

    it("should delay between items when specified", async () => {
      const start = Date.now();
      await captureAsyncGenerator(arrayToAsyncGenerator([1, 2], 50));
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe("createControllableGenerator", () => {
    it("should yield pushed values", async () => {
      const { generator, push, complete } = createControllableGenerator<number>();

      const capturePromise = captureAsyncGenerator(generator);

      push(1);
      push(2);
      push(3);
      complete();

      const items = await capturePromise;
      expect(items).toEqual([1, 2, 3]);
    });

    it("should throw on error", async () => {
      const { generator, push, error } = createControllableGenerator<number>();

      const capturePromise = captureAsyncGenerator(generator);

      push(1);
      error(new Error("failed"));

      await expect(capturePromise).rejects.toThrow("failed");
    });
  });
});

describe("SSE Utilities", () => {
  describe("parseSSEEvent", () => {
    it("should parse event with data", () => {
      const result = parseSSEEvent("data: hello world");

      expect(result).toEqual({ data: "hello world" });
    });

    it("should parse event with type and data", () => {
      const result = parseSSEEvent("event: message\ndata: hello");

      expect(result).toEqual({ event: "message", data: "hello" });
    });

    it("should parse event with id", () => {
      const result = parseSSEEvent("id: 123\ndata: hello");

      expect(result).toEqual({ id: "123", data: "hello" });
    });

    it("should return null for empty string", () => {
      expect(parseSSEEvent("")).toBeNull();
      expect(parseSSEEvent("   ")).toBeNull();
    });
  });

  describe("parseSSEBuffer", () => {
    it("should parse multiple events", () => {
      const buffer = "data: one\n\ndata: two\n\ndata: three\n\n";
      const events = parseSSEBuffer(buffer);

      expect(events).toHaveLength(3);
      expect(events[0].data).toBe("one");
      expect(events[1].data).toBe("two");
      expect(events[2].data).toBe("three");
    });
  });

  describe("formatSSEEvent", () => {
    it("should format string data", () => {
      const result = formatSSEEvent("hello");

      expect(result).toBe("data: hello\n\n");
    });

    it("should format object as JSON", () => {
      const result = formatSSEEvent({ foo: "bar" });

      expect(result).toBe('data: {"foo":"bar"}\n\n');
    });

    it("should include event type", () => {
      const result = formatSSEEvent("hello", { event: "message" });

      expect(result).toBe("event: message\ndata: hello\n\n");
    });

    it("should include id", () => {
      const result = formatSSEEvent("hello", { id: "123" });

      expect(result).toBe("id: 123\ndata: hello\n\n");
    });
  });
});

describe("Mock Utilities", () => {
  describe("createSpy", () => {
    it("should track calls", () => {
      const spy = createSpy<(a: number, b: number) => number>((a, b) => a + b);

      spy(1, 2);
      spy(3, 4);

      expect(spy.callCount).toBe(2);
      expect(spy.calls).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it("should track results", () => {
      const spy = createSpy((x: number) => x * 2);

      spy(5);
      spy(10);

      expect(spy.results).toEqual([10, 20]);
    });

    it("should reset tracking", () => {
      const spy = createSpy(() => 1);

      spy();
      spy();
      spy.reset();

      expect(spy.callCount).toBe(0);
      expect(spy.calls).toEqual([]);
    });

    it("should allow changing implementation", () => {
      const spy = createSpy(() => 1);

      expect(spy()).toBe(1);

      spy.mockImplementation(() => 2);

      expect(spy()).toBe(2);
    });
  });

  describe("createMockSequence", () => {
    it("should return values in sequence", () => {
      const mock = createMockSequence(1, 2, 3);

      expect(mock()).toBe(1);
      expect(mock()).toBe(2);
      expect(mock()).toBe(3);
    });

    it("should repeat last value when exhausted", () => {
      const mock = createMockSequence(1, 2);

      mock();
      mock();
      expect(mock()).toBe(2);
      expect(mock()).toBe(2);
    });
  });
});
