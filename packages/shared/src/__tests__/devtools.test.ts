import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  devToolsEmitter,
  type DevToolsEvent,
  type DTExecutionStartEvent,
  type DTContentDeltaEvent,
  normalizeDevToolsConfig,
  DEVTOOLS_CHANNEL,
} from "../devtools.js";

describe("DevToolsEmitter", () => {
  beforeEach(() => {
    devToolsEmitter.clear();
  });

  afterEach(() => {
    devToolsEmitter.clear();
  });

  describe("subscribe", () => {
    it("should notify subscribers when events are emitted", () => {
      const handler = vi.fn();
      devToolsEmitter.subscribe(handler);

      const event: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "TestAgent",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should return an unsubscribe function", () => {
      const handler = vi.fn();
      const unsubscribe = devToolsEmitter.subscribe(handler);

      const event: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "TestAgent",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(event);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      devToolsEmitter.emitEvent(event);
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it("should support multiple subscribers", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      devToolsEmitter.subscribe(handler1);
      devToolsEmitter.subscribe(handler2);

      const event: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "TestAgent",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(event);

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });

    it("should not throw if subscriber throws", () => {
      devToolsEmitter.setDebug(false);
      const badHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      const goodHandler = vi.fn();

      devToolsEmitter.subscribe(badHandler);
      devToolsEmitter.subscribe(goodHandler);

      const event: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "TestAgent",
        timestamp: Date.now(),
      };

      expect(() => devToolsEmitter.emitEvent(event)).not.toThrow();
      expect(goodHandler).toHaveBeenCalled();
    });
  });

  describe("batching", () => {
    it("should batch content_delta events", async () => {
      const handler = vi.fn();
      devToolsEmitter.subscribe(handler);

      const delta1: DTContentDeltaEvent = {
        type: "content_delta",
        executionId: "exec-1",
        tick: 1,
        delta: "Hello ",
        timestamp: Date.now(),
      };

      const delta2: DTContentDeltaEvent = {
        type: "content_delta",
        executionId: "exec-1",
        tick: 1,
        delta: "world!",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(delta1);
      devToolsEmitter.emitEvent(delta2);

      // Not called yet - batched
      expect(handler).not.toHaveBeenCalled();

      // Wait for batch flush (10ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, delta1);
      expect(handler).toHaveBeenNthCalledWith(2, delta2);
    });

    it("should flush batch before emitting non-batched event", () => {
      const handler = vi.fn();
      devToolsEmitter.subscribe(handler);

      const delta: DTContentDeltaEvent = {
        type: "content_delta",
        executionId: "exec-1",
        tick: 1,
        delta: "Hello",
        timestamp: Date.now(),
      };

      const tickEnd: DevToolsEvent = {
        type: "tick_end",
        executionId: "exec-1",
        tick: 1,
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(delta);
      expect(handler).not.toHaveBeenCalled(); // Batched

      devToolsEmitter.emitEvent(tickEnd);
      // Both should be emitted now - delta flushed before tick_end
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, delta);
      expect(handler).toHaveBeenNthCalledWith(2, tickEnd);
    });

    it("should call batch subscribers with array of events", async () => {
      const batchHandler = vi.fn();
      devToolsEmitter.subscribeBatch(batchHandler);

      const delta1: DTContentDeltaEvent = {
        type: "content_delta",
        executionId: "exec-1",
        tick: 1,
        delta: "Hello ",
        timestamp: Date.now(),
      };

      const delta2: DTContentDeltaEvent = {
        type: "content_delta",
        executionId: "exec-1",
        tick: 1,
        delta: "world!",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(delta1);
      devToolsEmitter.emitEvent(delta2);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(batchHandler).toHaveBeenCalledTimes(1);
      expect(batchHandler).toHaveBeenCalledWith([delta1, delta2]);
    });
  });

  describe("history", () => {
    it("should store events in history", () => {
      const event: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "TestAgent",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(event);

      const history = devToolsEmitter.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(event);
    });

    it("should filter history by executionId", () => {
      const event1: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "Agent1",
        timestamp: Date.now(),
      };

      const event2: DTExecutionStartEvent = {
        type: "execution_start",
        executionId: "exec-2",
        rootComponent: "Agent2",
        timestamp: Date.now(),
      };

      devToolsEmitter.emitEvent(event1);
      devToolsEmitter.emitEvent(event2);

      const history = devToolsEmitter.getHistory("exec-1");
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(event1);
    });

    it("should limit history size", () => {
      // Emit more than MAX_HISTORY_SIZE events
      for (let i = 0; i < 1100; i++) {
        devToolsEmitter.emitEvent({
          type: "tick_start",
          executionId: `exec-${i}`,
          tick: 1,
          timestamp: Date.now(),
        });
      }

      const history = devToolsEmitter.getHistory();
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });

  describe("hasSubscribers", () => {
    it("should return false when no subscribers", () => {
      expect(devToolsEmitter.hasSubscribers()).toBe(false);
    });

    it("should return true when there are subscribers", () => {
      devToolsEmitter.subscribe(() => {});
      expect(devToolsEmitter.hasSubscribers()).toBe(true);
    });

    it("should return false after unsubscribe", () => {
      const unsubscribe = devToolsEmitter.subscribe(() => {});
      expect(devToolsEmitter.hasSubscribers()).toBe(true);
      unsubscribe();
      expect(devToolsEmitter.hasSubscribers()).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all state", () => {
      devToolsEmitter.subscribe(() => {});
      devToolsEmitter.emitEvent({
        type: "execution_start",
        executionId: "exec-1",
        rootComponent: "Agent",
        timestamp: Date.now(),
      });

      expect(devToolsEmitter.hasSubscribers()).toBe(true);
      expect(devToolsEmitter.getHistory()).toHaveLength(1);

      devToolsEmitter.clear();

      expect(devToolsEmitter.hasSubscribers()).toBe(false);
      expect(devToolsEmitter.getHistory()).toHaveLength(0);
    });
  });
});

describe("normalizeDevToolsConfig", () => {
  it("should return false for false", () => {
    expect(normalizeDevToolsConfig(false)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(normalizeDevToolsConfig(undefined)).toBe(false);
  });

  it("should return default config for true", () => {
    const config = normalizeDevToolsConfig(true);
    expect(config).toEqual({
      enabled: true,
      inheritOnFork: true,
      inheritOnSpawn: true,
    });
  });

  it("should normalize config object", () => {
    const config = normalizeDevToolsConfig({
      enabled: true,
      remote: true,
      remoteUrl: "http://localhost:9000",
      debug: true,
    });

    expect(config).toEqual({
      enabled: true,
      channel: DEVTOOLS_CHANNEL,
      remote: true,
      remoteUrl: "http://localhost:9000",
      secret: undefined,
      inheritOnFork: true,
      inheritOnSpawn: true,
      debug: true,
    });
  });

  it("should respect explicit inheritance settings", () => {
    const config = normalizeDevToolsConfig({
      inheritOnFork: false,
      inheritOnSpawn: false,
    });

    expect(config).not.toBe(false);
    if (config !== false) {
      expect(config.inheritOnFork).toBe(false);
      expect(config.inheritOnSpawn).toBe(false);
    }
  });
});
