import { Channel, ChannelSession, ChannelEvent } from "./channel";
import { KernelContext } from "./context";

describe("Channel", () => {
  let channel: Channel;

  beforeEach(() => {
    channel = new Channel("test-channel");
  });

  afterEach(() => {
    channel.destroy();
  });

  describe("publish", () => {
    it("should publish events to subscribers", () => {
      const event: ChannelEvent = {
        type: "test",
        channel: "test-channel",
        payload: { message: "hello" },
      };

      let receivedEvent: ChannelEvent | undefined;
      channel.subscribe((e) => {
        receivedEvent = e;
      });

      channel.publish(event);

      expect(receivedEvent).toBeDefined();
      expect(receivedEvent!.channel).toBe("test-channel");
      expect(receivedEvent!.type).toBe("test");
      expect(receivedEvent!.payload).toEqual({ message: "hello" });
      expect(receivedEvent!.metadata?.timestamp).toBeDefined();
    });

    it("should normalize channel name", () => {
      const event: ChannelEvent = {
        type: "test",
        channel: "wrong-channel",
        payload: {},
      };

      channel.subscribe((receivedEvent) => {
        expect(receivedEvent.channel).toBe("test-channel");
      });

      channel.publish(event);
    });

    it("should add timestamp to metadata", () => {
      const before = Date.now();
      const event: ChannelEvent = {
        type: "test",
        channel: "test-channel",
        payload: {},
      };

      let receivedEvent: ChannelEvent | undefined;
      channel.subscribe((e) => {
        receivedEvent = e;
      });

      channel.publish(event);
      const after = Date.now();

      expect(receivedEvent).toBeDefined();
      expect(receivedEvent!.metadata?.timestamp).toBeGreaterThanOrEqual(before);
      expect(receivedEvent!.metadata?.timestamp).toBeLessThanOrEqual(after);
    });

    it("should merge existing metadata", () => {
      const event: ChannelEvent = {
        type: "test",
        channel: "test-channel",
        payload: {},
        metadata: {
          source: "test-source",
          customField: "custom-value",
        },
      };

      let receivedEvent: ChannelEvent | undefined;
      channel.subscribe((e) => {
        receivedEvent = e;
      });

      channel.publish(event);

      expect(receivedEvent).toBeDefined();
      expect(receivedEvent!.metadata?.source).toBe("test-source");
      expect(receivedEvent!.metadata?.["customField"]).toBe("custom-value");
      expect(receivedEvent!.metadata?.timestamp).toBeDefined();
    });

    it("should handle multiple concurrent publishes", () => {
      const events: ChannelEvent[] = [];
      channel.subscribe((event) => events.push(event));

      channel.publish({ type: "test1", channel: "test-channel", payload: {} });
      channel.publish({ type: "test2", channel: "test-channel", payload: {} });
      channel.publish({ type: "test3", channel: "test-channel", payload: {} });

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("test1");
      expect(events[1].type).toBe("test2");
      expect(events[2].type).toBe("test3");
    });
  });

  describe("subscribe", () => {
    it("should allow multiple subscribers", () => {
      const events: ChannelEvent[] = [];
      const unsubscribe1 = channel.subscribe((event) => events.push(event));
      const unsubscribe2 = channel.subscribe((event) => events.push(event));

      channel.publish({
        type: "test",
        channel: "test-channel",
        payload: {},
      });

      expect(events).toHaveLength(2);
      unsubscribe1();
      unsubscribe2();
    });

    it("should return unsubscribe function", () => {
      let callCount = 0;
      const unsubscribe = channel.subscribe(() => {
        callCount++;
      });

      channel.publish({
        type: "test",
        channel: "test-channel",
        payload: {},
      });

      expect(callCount).toBe(1);

      unsubscribe();

      channel.publish({
        type: "test",
        channel: "test-channel",
        payload: {},
      });

      expect(callCount).toBe(1); // Should not increment after unsubscribe
    });
  });

  describe("waitForResponse", () => {
    it("should resolve when response is received", async () => {
      const requestId = "req-123";
      const responsePromise = channel.waitForResponse(requestId, 1000);

      // Simulate response arriving
      setTimeout(() => {
        channel.publish({
          type: "response",
          id: requestId,
          channel: "test-channel",
          payload: { answer: "yes" },
        });
      }, 10);

      const response = await responsePromise;
      expect(response.type).toBe("response");
      expect(response.id).toBe(requestId);
      expect(response.payload).toEqual({ answer: "yes" });
    });

    it("should timeout if response not received", async () => {
      const requestId = "req-timeout";
      const responsePromise = channel.waitForResponse(requestId, 50);

      await expect(responsePromise).rejects.toThrow(/timed out/);
    });

    it("should handle race condition (response before wait)", async () => {
      const requestId = "req-race";

      // Publish response first
      channel.publish({
        type: "response",
        id: requestId,
        channel: "test-channel",
        payload: { answer: "early" },
      });

      // Then wait (should still receive it)
      const response = await channel.waitForResponse(requestId, 1000);
      expect(response.payload).toEqual({ answer: "early" });
    });

    it("should handle multiple concurrent waitForResponse calls", async () => {
      const requestId1 = "req-1";
      const requestId2 = "req-2";
      const requestId3 = "req-3";

      const promise1 = channel.waitForResponse(requestId1, 1000);
      const promise2 = channel.waitForResponse(requestId2, 1000);
      const promise3 = channel.waitForResponse(requestId3, 1000);

      // Publish responses in different order
      setTimeout(() => {
        channel.publish({
          type: "response",
          id: requestId2,
          channel: "test-channel",
          payload: { answer: "2" },
        });
      }, 10);
      setTimeout(() => {
        channel.publish({
          type: "response",
          id: requestId1,
          channel: "test-channel",
          payload: { answer: "1" },
        });
      }, 20);
      setTimeout(() => {
        channel.publish({
          type: "response",
          id: requestId3,
          channel: "test-channel",
          payload: { answer: "3" },
        });
      }, 30);

      const [response1, response2, response3] = await Promise.all([promise1, promise2, promise3]);
      expect(response1.payload).toEqual({ answer: "1" });
      expect(response2.payload).toEqual({ answer: "2" });
      expect(response3.payload).toEqual({ answer: "3" });
    });
  });

  describe("getSubscriberCount", () => {
    it("should return correct subscriber count", () => {
      expect(channel.getSubscriberCount()).toBe(0);

      const unsubscribe1 = channel.subscribe(() => {});
      expect(channel.getSubscriberCount()).toBe(1);

      const unsubscribe2 = channel.subscribe(() => {});
      expect(channel.getSubscriberCount()).toBe(2);

      unsubscribe1();
      expect(channel.getSubscriberCount()).toBe(1);

      unsubscribe2();
      expect(channel.getSubscriberCount()).toBe(0);
    });
  });

  describe("destroy", () => {
    it("should reject pending requests", async () => {
      const requestId = "req-destroy";
      const responsePromise = channel.waitForResponse(requestId, 1000);

      channel.destroy();

      await expect(responsePromise).rejects.toThrow(/destroyed/);
    });

    it("should remove all subscribers", () => {
      channel.subscribe(() => {});
      channel.subscribe(() => {});

      expect(channel.getSubscriberCount()).toBe(2);

      channel.destroy();

      expect(channel.getSubscriberCount()).toBe(0);
    });
  });
});

describe("ChannelSession", () => {
  let session: ChannelSession;

  beforeEach(() => {
    session = new ChannelSession("session-123");
  });

  afterEach(() => {
    session.destroy();
  });

  describe("getChannel", () => {
    it("should create channel if not exists", () => {
      const channel = session.getChannel("test-channel");
      expect(channel).toBeDefined();
      expect(channel.name).toBe("test-channel");
    });

    it("should return same channel instance", () => {
      const channel1 = session.getChannel("test-channel");
      const channel2 = session.getChannel("test-channel");
      expect(channel1).toBe(channel2);
    });

    it("should update lastActivity", async () => {
      const before = session.lastActivity;
      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));
      session.getChannel("test-channel");
      expect(session.lastActivity).toBeGreaterThan(before);
    });

    it("should handle multiple channels in session", () => {
      const channel1 = session.getChannel("channel-1");
      const channel2 = session.getChannel("channel-2");
      const channel3 = session.getChannel("channel-3");

      expect(channel1.name).toBe("channel-1");
      expect(channel2.name).toBe("channel-2");
      expect(channel3.name).toBe("channel-3");
      expect(session.channels.size).toBe(3);
    });
  });

  describe("removeChannel", () => {
    it("should remove and destroy channel", () => {
      const channel = session.getChannel("test-channel");
      const _unsubscribe = channel.subscribe(() => {});

      expect(session.channels.has("test-channel")).toBe(true);
      expect(channel.getSubscriberCount()).toBe(1);

      session.removeChannel("test-channel");

      expect(session.channels.has("test-channel")).toBe(false);
      expect(channel.getSubscriberCount()).toBe(0); // Destroyed
    });
  });

  describe("generateId", () => {
    it("should generate ID from user context", () => {
      const ctx: KernelContext = {
        requestId: "req-1",
        traceId: "trace-1",
        user: { id: "user-123" },
        metadata: { conversationId: "conv-456" },
        metrics: {},
        events: {} as any,
      };

      const id = ChannelSession.generateId(ctx);
      expect(id).toBe("user-123-conv-456");
    });

    it("should use anonymous if no user", () => {
      const ctx: KernelContext = {
        requestId: "req-1",
        traceId: "trace-1",
        metadata: { conversationId: "conv-456" },
        metrics: {},
        events: {} as any,
      };

      const id = ChannelSession.generateId(ctx);
      expect(id).toBe("anonymous-conv-456");
    });

    it("should use traceId if no conversationId", () => {
      const ctx: KernelContext = {
        requestId: "req-1",
        traceId: "trace-789",
        user: { id: "user-123" },
        metadata: {},
        metrics: {},
        events: {} as any,
      };

      const id = ChannelSession.generateId(ctx);
      expect(id).toBe("user-123-trace-789");
    });

    it("should handle na conversationId", () => {
      const ctx: KernelContext = {
        requestId: "req-1",
        traceId: "trace-789",
        user: { id: "user-123" },
        metadata: { conversationId: "na" },
        metrics: {},
        events: {} as any,
      };

      const id = ChannelSession.generateId(ctx);
      expect(id).toBe("user-123-trace-789"); // Should fall back to traceId
    });
  });

  describe("destroy", () => {
    it("should destroy all channels", () => {
      const channel1 = session.getChannel("channel-1");
      const channel2 = session.getChannel("channel-2");

      channel1.subscribe(() => {});
      channel2.subscribe(() => {});

      expect(channel1.getSubscriberCount()).toBe(1);
      expect(channel2.getSubscriberCount()).toBe(1);

      session.destroy();

      expect(channel1.getSubscriberCount()).toBe(0);
      expect(channel2.getSubscriberCount()).toBe(0);
      expect(session.channels.size).toBe(0);
    });
  });
});
