import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageSteering } from "../message-steering.js";
import { createMockClient, makeEvent } from "../testing.js";

describe("MessageSteering", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient(vi.fn);
  });

  describe("initial state", () => {
    it("starts with default steer mode", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      expect(steering.mode).toBe("steer");
      expect(steering.queued).toEqual([]);
      expect(steering.isExecuting).toBe(false);

      steering.destroy();
    });

    it("respects initial mode option", () => {
      const steering = new MessageSteering(client, { sessionId: "s1", mode: "queue" });

      expect(steering.mode).toBe("queue");

      steering.destroy();
    });
  });

  describe("submit", () => {
    it("sends immediately when idle", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.submit("Hello");

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
        { sessionId: "s1" },
      );

      steering.destroy();
    });

    it("steers when executing in steer mode", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(steering.isExecuting).toBe(true);

      steering.submit("During execution");

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "During execution" }] }] },
        { sessionId: "s1" },
      );

      steering.destroy();
    });

    it("queues when executing in queue mode", () => {
      const steering = new MessageSteering(client, { sessionId: "s1", mode: "queue" });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.submit("Queued msg");

      expect(steering.queued).toHaveLength(1);
      expect(steering.queued[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Queued msg" }],
      });
      expect(client.send).not.toHaveBeenCalled();

      steering.destroy();
    });
  });

  describe("steer", () => {
    it("always sends to session regardless of mode", () => {
      const steering = new MessageSteering(client, { sessionId: "s1", mode: "queue" });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.steer("Force send");

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "Force send" }] }] },
        { sessionId: "s1" },
      );

      steering.destroy();
    });
  });

  describe("queue", () => {
    it("always adds to local buffer", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.queue("Buffered 1");
      steering.queue("Buffered 2");

      expect(steering.queued).toHaveLength(2);
      expect(client.send).not.toHaveBeenCalled();

      steering.destroy();
    });
  });

  describe("interrupt", () => {
    it("calls accessor.interrupt with send input", async () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      await steering.interrupt("Stop and do this");

      const accessor = client.getAccessor("s1");
      expect(accessor.interrupt).toHaveBeenCalledWith({
        messages: [{ role: "user", content: [{ type: "text", text: "Stop and do this" }] }],
      });

      steering.destroy();
    });

    it("falls back to client.send without sessionId", async () => {
      const steering = new MessageSteering(client);

      await steering.interrupt("No session");

      expect(client.send).toHaveBeenCalledWith({
        messages: [{ role: "user", content: [{ type: "text", text: "No session" }] }],
      });

      steering.destroy();
    });
  });

  describe("no sessionId", () => {
    it("submit sends without session scope", () => {
      const steering = new MessageSteering(client);

      steering.submit("Hello");

      expect(client.send).toHaveBeenCalledWith({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });
      expect(steering.isExecuting).toBe(false);

      steering.destroy();
    });
  });

  describe("auto-flush", () => {
    it("flushes first queued message sequentially on execution_end", () => {
      const steering = new MessageSteering(client, {
        sessionId: "s1",
        mode: "queue",
        flushMode: "sequential",
      });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.submit("Q1");
      steering.submit("Q2");

      expect(steering.queued).toHaveLength(2);

      client._emitSessionEvent("s1", makeEvent("execution_end"));

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "Q1" }] }] },
        { sessionId: "s1" },
      );
      expect(steering.queued).toHaveLength(1);

      steering.destroy();
    });

    it("flushes all queued messages in batched mode on execution_end", () => {
      const steering = new MessageSteering(client, {
        sessionId: "s1",
        mode: "queue",
        flushMode: "batched",
      });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.submit("Q1");
      steering.submit("Q2");

      client._emitSessionEvent("s1", makeEvent("execution_end"));

      expect(client.send).toHaveBeenCalledWith(
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "Q1" }] },
            { role: "user", content: [{ type: "text", text: "Q2" }] },
          ],
        },
        { sessionId: "s1" },
      );
      expect(steering.queued).toHaveLength(0);

      steering.destroy();
    });

    it("does not flush when autoFlush is false", () => {
      const steering = new MessageSteering(client, {
        sessionId: "s1",
        mode: "queue",
        autoFlush: false,
      });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.submit("Q1");
      client._emitSessionEvent("s1", makeEvent("execution_end"));

      expect(client.send).not.toHaveBeenCalled();
      expect(steering.queued).toHaveLength(1);

      steering.destroy();
    });
  });

  describe("queue management", () => {
    it("removeQueued removes by index", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.queue("A");
      steering.queue("B");
      steering.queue("C");

      steering.removeQueued(1);

      expect(steering.queued).toHaveLength(2);
      expect(steering.queued[0].content).toEqual([{ type: "text", text: "A" }]);
      expect(steering.queued[1].content).toEqual([{ type: "text", text: "C" }]);

      steering.destroy();
    });

    it("clearQueued empties the buffer", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.queue("A");
      steering.queue("B");
      steering.clearQueued();

      expect(steering.queued).toHaveLength(0);

      steering.destroy();
    });

    it("manual flush sends sequentially and removes from queue", () => {
      const steering = new MessageSteering(client, {
        sessionId: "s1",
        flushMode: "sequential",
      });

      steering.queue("X");
      steering.queue("Y");
      steering.flush();

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "X" }] }] },
        { sessionId: "s1" },
      );
      expect(steering.queued).toHaveLength(1);

      steering.destroy();
    });

    it("manual flush sends all in batched mode", () => {
      const steering = new MessageSteering(client, {
        sessionId: "s1",
        flushMode: "batched",
      });

      steering.queue("X");
      steering.queue("Y");
      steering.flush();

      expect(client.send).toHaveBeenCalledWith(
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "X" }] },
            { role: "user", content: [{ type: "text", text: "Y" }] },
          ],
        },
        { sessionId: "s1" },
      );
      expect(steering.queued).toHaveLength(0);

      steering.destroy();
    });

    it("flush on empty queue is a no-op", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.flush();

      expect(client.send).not.toHaveBeenCalled();

      steering.destroy();
    });
  });

  describe("mode switching", () => {
    it("setMode changes steering behavior", () => {
      const steering = new MessageSteering(client, { sessionId: "s1", mode: "steer" });

      steering.setMode("queue");
      expect(steering.mode).toBe("queue");

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      steering.submit("Should be queued");

      expect(steering.queued).toHaveLength(1);
      expect(client.send).not.toHaveBeenCalled();

      steering.destroy();
    });
  });

  describe("execution tracking", () => {
    it("tracks isExecuting from execution events", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      expect(steering.isExecuting).toBe(false);

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(steering.isExecuting).toBe(true);

      client._emitSessionEvent("s1", makeEvent("execution_end"));
      expect(steering.isExecuting).toBe(false);

      steering.destroy();
    });
  });

  describe("snapshot / subscription", () => {
    it("onStateChange fires on state mutation", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });
      const listener = vi.fn();
      steering.onStateChange(listener);

      steering.queue("test");

      expect(listener).toHaveBeenCalledTimes(1);

      steering.destroy();
    });

    it("snapshot is immutable — new reference on each change", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      const snap1 = steering.state;
      steering.queue("test");
      const snap2 = steering.state;

      expect(snap1).not.toBe(snap2);
      expect(snap1.queued).toHaveLength(0);
      expect(snap2.queued).toHaveLength(1);

      steering.destroy();
    });

    it("unsubscribe stops notifications", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });
      const listener = vi.fn();
      const unsub = steering.onStateChange(listener);

      steering.queue("first");
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      steering.queue("second");
      expect(listener).toHaveBeenCalledTimes(1);

      steering.destroy();
    });

    it("destroy cleans up event subscriptions", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });
      const listener = vi.fn();
      steering.onStateChange(listener);

      steering.destroy();
      client._emitSessionEvent("s1", makeEvent("execution_start"));

      expect(listener).not.toHaveBeenCalled();
    });

    it("double destroy is safe", () => {
      const steering = new MessageSteering(client, { sessionId: "s1" });

      steering.destroy();
      expect(() => steering.destroy()).not.toThrow();
    });
  });
});
