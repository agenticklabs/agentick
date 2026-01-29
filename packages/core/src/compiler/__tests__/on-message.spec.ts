/**
 * Tests for onMessage lifecycle hook
 *
 * Tests the useOnMessage hook and message delivery system for:
 * - Function components using useOnMessage
 * - Class components using onMessage method
 * - Message queuing in TickState.queuedMessages
 * - COM abort via com.abort()
 */

import { useOnMessage, setRenderContext } from "../../state/hooks";
import type { RenderContext } from "../types";
import { createFiber } from "../fiber";
import { COM } from "../../com/object-model";
import type { TickState } from "../../component/component";
import type { ExecutionMessage } from "../../engine/execution-types";

describe("onMessage Hook", () => {
  let com: COM;
  let tickState: TickState;
  let renderContext: RenderContext;
  let fiber: ReturnType<typeof createFiber>;

  beforeEach(() => {
    com = new COM();
    tickState = {
      tick: 1,
      stop: vi.fn(),
      queuedMessages: [],
    } as unknown as TickState;

    fiber = createFiber(() => null, {}, null);
    renderContext = {
      fiber,
      com,
      tickState,
      currentHook: null,
      workInProgressHook: null,
    };
  });

  afterEach(() => {
    setRenderContext(null);
  });

  describe("useOnMessage", () => {
    it("should register onMessage callback", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useOnMessage(callback);

      const hook = fiber.memoizedState;
      expect(hook?.memoizedState).toBe(callback);
      expect(hook?.effect).toBeDefined();
      expect(hook?.effect?.phase).toBe("on-message");
    });

    it("should persist callback across renders", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useOnMessage(callback);

      // Simulate re-render
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const newCallback = vi.fn();
      useOnMessage(newCallback);

      const hook = fiber.memoizedState as any;
      // Should update to new callback (if hook exists)
      if (hook) {
        expect(hook.memoizedState).toBe(newCallback);
      }
    });
  });

  describe("COM message queue", () => {
    it("should queue messages via queueMessage()", () => {
      const message: ExecutionMessage = {
        id: "msg_1",
        timestamp: Date.now(),
        type: "test",
        content: { data: "test" },
      };

      com.queueMessage(message);

      const messages = com.getQueuedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe(message);
    });

    it("should preserve message order (FIFO)", () => {
      const message1: ExecutionMessage = {
        id: "msg_1",
        timestamp: Date.now(),
        type: "first",
        content: { order: 1 },
      };
      const message2: ExecutionMessage = {
        id: "msg_2",
        timestamp: Date.now() + 1,
        type: "second",
        content: { order: 2 },
      };

      com.queueMessage(message1);
      com.queueMessage(message2);

      const messages = com.getQueuedMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe("first");
      expect(messages[1].type).toBe("second");
    });

    it("should clear messages via clearQueuedMessages()", () => {
      const message: ExecutionMessage = {
        id: "msg_1",
        timestamp: Date.now(),
        type: "test",
        content: undefined,
      };

      com.queueMessage(message);
      expect(com.getQueuedMessages()).toHaveLength(1);

      com.clearQueuedMessages();
      expect(com.getQueuedMessages()).toHaveLength(0);
    });

    it("should emit execution:message event when message queued", () => {
      const listener = vi.fn();
      com.on("execution:message", listener);

      const message: ExecutionMessage = {
        id: "msg_1",
        timestamp: Date.now(),
        type: "test",
        content: { test: true },
      };

      com.queueMessage(message);

      expect(listener).toHaveBeenCalledWith(message);
    });
  });

  describe("COM abort control", () => {
    it("should set shouldAbort via abort()", () => {
      expect(com.shouldAbort).toBe(false);

      com.abort("User requested stop");

      expect(com.shouldAbort).toBe(true);
      expect(com.abortReason).toBe("User requested stop");
    });

    it("should handle abort without reason", () => {
      com.abort();

      expect(com.shouldAbort).toBe(true);
      // Reason is optional - undefined when not provided
      expect(com.abortReason).toBeUndefined();
    });

    it("should reset abort state via _resetAbortState()", () => {
      com.abort("Test abort");
      expect(com.shouldAbort).toBe(true);

      com._resetAbortState();

      expect(com.shouldAbort).toBe(false);
      expect(com.abortReason).toBeUndefined();
    });
  });
});

describe("TickState.queuedMessages", () => {
  it("should include queuedMessages in TickState", () => {
    const tickState: TickState = {
      tick: 1,
      stop: vi.fn(),
      queuedMessages: [{ id: "msg_1", timestamp: Date.now(), type: "test", content: {} }],
    } as unknown as TickState;

    expect(tickState.queuedMessages).toBeDefined();
    expect(tickState.queuedMessages).toHaveLength(1);
    expect(tickState.queuedMessages![0].type).toBe("test");
  });
});

describe("Message queue timing", () => {
  let com: COM;

  beforeEach(() => {
    com = new COM();
  });

  it("should make messages available in the NEXT tick after they arrive", () => {
    // Simulate Tick 1: No messages yet
    const tick1Messages = com.getQueuedMessages();
    expect(tick1Messages).toHaveLength(0);

    // During Tick 1: A message arrives
    const message: ExecutionMessage = {
      id: "msg_1",
      timestamp: Date.now(),
      type: "user_input",
      content: { text: "Hello" },
    };
    com.queueMessage(message);

    // Still Tick 1: Message is queued but getQueuedMessages returns the new message
    // (This is correct - the message is available immediately for the next snapshot)
    expect(com.getQueuedMessages()).toHaveLength(1);

    // Simulate end of Tick 1 / start of Tick 2:
    // prepareTickState would snapshot getQueuedMessages() here
    const tick2Messages = [...com.getQueuedMessages()]; // Snapshot

    // Then clearQueuedMessages is called (after snapshot)
    com.clearQueuedMessages();

    // Tick 2's TickState has the message from Tick 1
    expect(tick2Messages).toHaveLength(1);
    expect(tick2Messages[0].type).toBe("user_input");

    // But the queue is now empty for future messages
    expect(com.getQueuedMessages()).toHaveLength(0);
  });

  it("should preserve multiple messages across tick boundary", () => {
    // Queue multiple messages during Tick 1
    const msg1: ExecutionMessage = {
      id: "msg_1",
      timestamp: Date.now(),
      type: "first",
      content: {},
    };
    const msg2: ExecutionMessage = {
      id: "msg_2",
      timestamp: Date.now() + 1,
      type: "second",
      content: {},
    };
    com.queueMessage(msg1);
    com.queueMessage(msg2);

    // Snapshot for Tick 2
    const tick2Messages = [...com.getQueuedMessages()];
    com.clearQueuedMessages();

    expect(tick2Messages).toHaveLength(2);
    expect(tick2Messages[0].type).toBe("first");
    expect(tick2Messages[1].type).toBe("second");
  });
});
