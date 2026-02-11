import { EventBuffer } from "./event-buffer";

// Test event types
type TestEvent =
  | { type: "delta"; value: string }
  | { type: "complete"; result: number }
  | { type: "error"; error: Error };

describe("EventBuffer", () => {
  describe("push", () => {
    it("should add events to buffer", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 42 });

      expect(buffer.length).toBe(2);
      expect(buffer.getBuffer()).toEqual([
        { type: "delta", value: "first" },
        { type: "complete", result: 42 },
      ]);
    });

    it("should notify wildcard subscribers", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.on((event) => received.push(event));
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 42 });

      expect(received).toEqual([
        { type: "delta", value: "first" },
        { type: "complete", result: 42 },
      ]);
    });

    it("should notify type-specific subscribers only for matching events", () => {
      const buffer = new EventBuffer<TestEvent>();
      const deltas: Array<{ type: "delta"; value: string }> = [];

      buffer.on("delta", (event) => deltas.push(event));
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 42 });
      buffer.push({ type: "delta", value: "second" });

      expect(deltas).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });

    it("should not push after close", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.close();
      buffer.push({ type: "delta", value: "second" });

      expect(buffer.length).toBe(1);
    });
  });

  describe("emit", () => {
    it("should work with full event object (one param)", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.on((event) => received.push(event));
      buffer.emit({ type: "delta", value: "hello" });

      expect(received).toEqual([{ type: "delta", value: "hello" }]);
    });

    it("should work with type + partial event (two params)", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.on((event) => received.push(event));
      buffer.emit("delta", { value: "hello" });

      expect(received).toEqual([{ type: "delta", value: "hello" }]);
    });

    it("should return true if there are listeners", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.on(() => {});

      expect(buffer.emit({ type: "delta", value: "test" })).toBe(true);
    });

    it("should return false if there are no listeners", () => {
      const buffer = new EventBuffer<TestEvent>();

      expect(buffer.emit({ type: "delta", value: "test" })).toBe(false);
    });
  });

  describe("close", () => {
    it("should set closed state", () => {
      const buffer = new EventBuffer<TestEvent>();
      expect(buffer.closed).toBe(false);

      buffer.close();
      expect(buffer.closed).toBe(true);
    });

    it("should be idempotent", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.close();
      buffer.close();

      expect(buffer.closed).toBe(true);
    });
  });

  describe("error", () => {
    it("should set error state", () => {
      const buffer = new EventBuffer<TestEvent>();
      const err = new Error("test error");

      buffer.error(err);

      expect(buffer.closed).toBe(true);
      expect(buffer.errorValue).toBe(err);
    });

    it("should not error after close", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.close();

      const err = new Error("test error");
      buffer.error(err);

      expect(buffer.errorValue).toBeNull();
    });
  });

  describe("on (subscribe)", () => {
    it("should receive events from subscription point forward", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "before" });

      const received: TestEvent[] = [];
      buffer.on((event) => received.push(event));

      buffer.push({ type: "delta", value: "after" });

      expect(received).toEqual([{ type: "delta", value: "after" }]);
    });

    it("should return unsubscribe function", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      const unsubscribe = buffer.on((event) => received.push(event));
      buffer.push({ type: "delta", value: "first" });

      unsubscribe();
      buffer.push({ type: "delta", value: "second" });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should support multiple subscribers", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received1: TestEvent[] = [];
      const received2: TestEvent[] = [];

      buffer.on((event) => received1.push(event));
      buffer.on((event) => received2.push(event));

      buffer.push({ type: "delta", value: "test" });

      expect(received1).toEqual([{ type: "delta", value: "test" }]);
      expect(received2).toEqual([{ type: "delta", value: "test" }]);
    });

    it("should support type-specific subscriptions", () => {
      const buffer = new EventBuffer<TestEvent>();
      const deltas: Array<{ type: "delta"; value: string }> = [];
      const completes: Array<{ type: "complete"; result: number }> = [];

      buffer.on("delta", (event) => deltas.push(event));
      buffer.on("complete", (event) => completes.push(event));

      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });
      buffer.push({ type: "delta", value: "second" });
      buffer.push({ type: "complete", result: 2 });

      expect(deltas).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
      expect(completes).toEqual([
        { type: "complete", result: 1 },
        { type: "complete", result: 2 },
      ]);
    });
  });

  describe("onReplay", () => {
    it("should replay buffered events then receive new ones (wildcard)", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "delta", value: "second" });

      const received: TestEvent[] = [];
      buffer.onReplay((event) => received.push(event));

      buffer.push({ type: "delta", value: "third" });

      expect(received).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
        { type: "delta", value: "third" },
      ]);
    });

    it("should replay only matching events for type-specific subscription", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });
      buffer.push({ type: "delta", value: "second" });

      const deltas: Array<{ type: "delta"; value: string }> = [];
      buffer.onReplay("delta", (event) => deltas.push(event));

      buffer.push({ type: "delta", value: "third" });
      buffer.push({ type: "complete", result: 2 });

      expect(deltas).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
        { type: "delta", value: "third" },
      ]);
    });

    it("should return unsubscribe function", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });

      const received: TestEvent[] = [];
      const unsubscribe = buffer.onReplay((event) => received.push(event));

      unsubscribe();
      buffer.push({ type: "delta", value: "second" });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });
  });

  describe("once", () => {
    it("should only fire handler once (wildcard)", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.once((event) => received.push(event));
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "delta", value: "second" });
      buffer.push({ type: "delta", value: "third" });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should only fire handler once for specific type", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: Array<{ type: "delta"; value: string }> = [];

      buffer.once("delta", (event) => received.push(event));
      buffer.push({ type: "complete", result: 1 }); // Ignored
      buffer.push({ type: "delta", value: "first" }); // Received
      buffer.push({ type: "delta", value: "second" }); // Ignored (already fired once)

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should return unsubscribe function", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      const unsubscribe = buffer.once((event) => received.push(event));
      unsubscribe();
      buffer.push({ type: "delta", value: "first" });

      expect(received).toEqual([]);
    });
  });

  describe("off", () => {
    it("should remove a wildcard subscriber", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];
      const handler = (event: TestEvent) => received.push(event);

      buffer.on(handler);
      buffer.push({ type: "delta", value: "first" });

      const removed = buffer.off(handler);
      buffer.push({ type: "delta", value: "second" });

      expect(removed).toBe(true);
      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should remove a type-specific subscriber", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: Array<{ type: "delta"; value: string }> = [];
      const handler = (event: { type: "delta"; value: string }) => received.push(event);

      buffer.on("delta", handler);
      buffer.push({ type: "delta", value: "first" });

      const removed = buffer.off("delta", handler);
      buffer.push({ type: "delta", value: "second" });

      expect(removed).toBe(true);
      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should return false if handler not found", () => {
      const buffer = new EventBuffer<TestEvent>();
      const handler = (_event: TestEvent) => {};

      const removed = buffer.off(handler);

      expect(removed).toBe(false);
    });
  });

  describe("getListenerCount", () => {
    it("should return total listener count", () => {
      const buffer = new EventBuffer<TestEvent>();

      buffer.on(() => {});
      buffer.on("delta", () => {});
      buffer.on("complete", () => {});

      expect(buffer.listenerCount).toBe(3);
    });

    it("should return count for specific event type", () => {
      const buffer = new EventBuffer<TestEvent>();

      buffer.on("delta", () => {});
      buffer.on("delta", () => {});
      buffer.on("complete", () => {});

      expect(buffer.getListenerCount("delta")).toBe(2);
      expect(buffer.getListenerCount("complete")).toBe(1);
    });

    it("should return wildcard listener count", () => {
      const buffer = new EventBuffer<TestEvent>();

      buffer.on(() => {});
      buffer.on(() => {});
      buffer.on("delta", () => {});

      expect(buffer.getListenerCount()).toBe(2);
    });
  });

  describe("getBufferByType", () => {
    it("should return only events of specific type", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });
      buffer.push({ type: "delta", value: "second" });

      const deltas = buffer.getBufferByType("delta");

      expect(deltas).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });
  });

  describe("async iteration", () => {
    it("should yield buffered events", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "delta", value: "second" });
      buffer.close();

      const received: TestEvent[] = [];
      for await (const event of buffer) {
        received.push(event);
      }

      expect(received).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });

    it("should wait for new events", async () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of buffer) {
          received.push(event);
          if (received.length >= 2) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      buffer.push({ type: "delta", value: "first" });
      await new Promise((r) => setTimeout(r, 10));
      buffer.push({ type: "delta", value: "second" });

      await iteratorPromise;

      expect(received).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });

    it("should complete when buffer closes", async () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of buffer) {
          received.push(event);
        }
      })();

      buffer.push({ type: "delta", value: "first" });
      await new Promise((r) => setTimeout(r, 10));
      buffer.close();

      await iteratorPromise;

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("should throw error when buffer errors", async () => {
      const buffer = new EventBuffer<TestEvent>();
      const testError = new Error("test error");

      const iteratorPromise = (async () => {
        const received: TestEvent[] = [];
        for await (const event of buffer) {
          received.push(event);
        }
        return received;
      })();

      buffer.push({ type: "delta", value: "first" });
      await new Promise((r) => setTimeout(r, 10));
      buffer.error(testError);

      await expect(iteratorPromise).rejects.toThrow("test error");
    });

    it("should support multiple iterators (dual consumption)", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "delta", value: "second" });
      buffer.close();

      const received1: TestEvent[] = [];
      const received2: TestEvent[] = [];

      await Promise.all([
        (async () => {
          for await (const event of buffer) {
            received1.push(event);
          }
        })(),
        (async () => {
          for await (const event of buffer) {
            received2.push(event);
          }
        })(),
      ]);

      expect(received1).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
      expect(received2).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });

    it("should replay for late iterators", async () => {
      const buffer = new EventBuffer<TestEvent>();

      const received1: TestEvent[] = [];
      const iter1Promise = (async () => {
        for await (const event of buffer) {
          received1.push(event);
        }
      })();

      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "delta", value: "second" });
      await new Promise((r) => setTimeout(r, 10));

      const received2: TestEvent[] = [];
      const iter2Promise = (async () => {
        for await (const event of buffer) {
          received2.push(event);
        }
      })();

      buffer.push({ type: "delta", value: "third" });
      await new Promise((r) => setTimeout(r, 10));
      buffer.close();

      await Promise.all([iter1Promise, iter2Promise]);

      expect(received1).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
        { type: "delta", value: "third" },
      ]);
      expect(received2).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
        { type: "delta", value: "third" },
      ]);
    });
  });

  describe("filter", () => {
    it("should yield only events of the specified type", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });
      buffer.push({ type: "delta", value: "second" });
      buffer.close();

      const deltas: Array<{ type: "delta"; value: string }> = [];
      for await (const event of buffer.filter("delta")) {
        deltas.push(event);
      }

      expect(deltas).toEqual([
        { type: "delta", value: "first" },
        { type: "delta", value: "second" },
      ]);
    });
  });

  describe("wildcard '*' compatibility", () => {
    it("on('*', handler) should subscribe to all events", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.on("*", (event) => received.push(event));
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });

      expect(received).toEqual([
        { type: "delta", value: "first" },
        { type: "complete", result: 1 },
      ]);
    });

    it("emit('*', event) should be a no-op (push handles wildcards)", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.on((event) => received.push(event));
      buffer.emit("*", { type: "delta", value: "test" });

      // emit("*", ...) is a no-op — push() already notifies wildcards.
      // Use push() for direct event injection.
      expect(received).toEqual([]);
      expect(buffer.length).toBe(0);
    });

    it("once('*', handler) should fire once for any event", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.once("*", (event) => received.push(event));
      buffer.push({ type: "delta", value: "first" });
      buffer.push({ type: "complete", result: 1 });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });

    it("off('*', handler) should remove wildcard subscription", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];
      const handler = (event: TestEvent) => received.push(event);

      buffer.on("*", handler);
      buffer.push({ type: "delta", value: "first" });
      buffer.off("*", handler);
      buffer.push({ type: "delta", value: "second" });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });
  });

  describe("EventEmitter aliases", () => {
    it("addListener should work like on", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];

      buffer.addListener((event) => received.push(event));
      buffer.push({ type: "delta", value: "test" });

      expect(received).toEqual([{ type: "delta", value: "test" }]);
    });

    it("addListener should work with event type", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: Array<{ type: "delta"; value: string }> = [];

      buffer.addListener("delta", (event) => received.push(event));
      buffer.push({ type: "delta", value: "test" });
      buffer.push({ type: "complete", result: 1 });

      expect(received).toEqual([{ type: "delta", value: "test" }]);
    });

    it("removeListener should work like off", () => {
      const buffer = new EventBuffer<TestEvent>();
      const received: TestEvent[] = [];
      const handler = (event: TestEvent) => received.push(event);

      buffer.addListener(handler);
      buffer.push({ type: "delta", value: "first" });
      buffer.removeListener(handler);
      buffer.push({ type: "delta", value: "second" });

      expect(received).toEqual([{ type: "delta", value: "first" }]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty buffer", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.close();

      const received: TestEvent[] = [];
      for await (const event of buffer) {
        received.push(event);
      }

      expect(received).toEqual([]);
    });

    it("should handle iteration on already closed buffer", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "test" });
      buffer.close();

      const received: TestEvent[] = [];
      for await (const event of buffer) {
        received.push(event);
      }

      expect(received).toEqual([{ type: "delta", value: "test" }]);
    });

    it("should handle iteration on already errored buffer", async () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "test" });
      buffer.error(new Error("test error"));

      const iteratorPromise = (async () => {
        const received: TestEvent[] = [];
        for await (const event of buffer) {
          received.push(event);
        }
        return received;
      })();

      await expect(iteratorPromise).rejects.toThrow("test error");
    });

    it("should handle getBuffer returning readonly array", () => {
      const buffer = new EventBuffer<TestEvent>();
      buffer.push({ type: "delta", value: "test" });

      const arr = buffer.getBuffer();
      expect(arr).toEqual([{ type: "delta", value: "test" }]);
    });
  });
});
