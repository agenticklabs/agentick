import { COM } from "./object-model";
import type { Message } from "../content";
import type { ExecutableTool } from "../tool/tool";
import type { COMTimelineEntry, COMSection } from "./types";
import { createTool } from "../tool/tool";
import { z } from "zod";

describe("COM EventEmitter", () => {
  let ctx: COM;

  beforeEach(() => {
    ctx = new COM();
  });

  describe("EventEmitter inheritance", () => {
    it("should extend EventEmitter", () => {
      expect(ctx).toBeInstanceOf(require("node:events").EventEmitter);
    });

    it("should have type-safe on method", () => {
      const handler = vi.fn();
      ctx.on("message:added", handler);
      expect(typeof ctx.on).toBe("function");
    });

    it("should have type-safe once method", () => {
      const handler = vi.fn();
      ctx.once("message:added", handler);
      expect(typeof ctx.once).toBe("function");
    });

    it("should have type-safe emit method", () => {
      expect(typeof ctx.emit).toBe("function");
    });
  });

  describe("message:added event", () => {
    it("should emit message:added when addMessage is called", () => {
      const handler = vi.fn();
      ctx.on("message:added", handler);

      const message: Message = {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      };

      ctx.addMessage(message);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(message, {});
    });

    it("should emit message:added with options", () => {
      const handler = vi.fn();
      ctx.on("message:added", handler);

      const message: Message = {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      };
      const options = {
        tags: ["important"],
        visibility: "model" as const,
        metadata: { source: "test" },
      };

      ctx.addMessage(message, options);

      expect(handler).toHaveBeenCalledWith(message, options);
    });

    it("should emit message:added for system message consolidation", () => {
      const handler = vi.fn();
      ctx.on("message:added", handler);

      const message1: Message = {
        role: "system",
        content: [{ type: "text", text: "First" }],
      };
      const message2: Message = {
        role: "system",
        content: [{ type: "text", text: "Second" }],
      };

      ctx.addMessage(message1);
      ctx.addMessage(message2);

      // Should emit twice: once for first, once for merged
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("timeline:modified event", () => {
    it("should emit timeline:modified when addTimelineEntry is called", () => {
      const handler = vi.fn();
      ctx.on("timeline:modified", handler);

      const entry: COMTimelineEntry = {
        kind: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Test" }],
        },
      };

      ctx.addTimelineEntry(entry);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(entry, "add");
    });

    it("should emit timeline:modified when addMessage calls addTimelineEntry", () => {
      const handler = vi.fn();
      ctx.on("timeline:modified", handler);

      const message: Message = {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      };

      ctx.addMessage(message);

      // addMessage calls addTimelineEntry, so timeline:modified should fire
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("tool:registered event", () => {
    it("should emit tool:registered when addTool is called", async () => {
      const handler = vi.fn();
      ctx.on("tool:registered", handler);

      const mockTool = createTool({
        name: "test-tool",
        description: "Test tool",
        input: z.object({ value: z.string().optional() }),
        handler: async (_input: { value?: string }) => [],
      });

      await ctx.addTool(mockTool);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(mockTool);
    });

    it("should not emit tool:registered if tool has no name", async () => {
      const handler = vi.fn();
      ctx.on("tool:registered", handler);

      // Create a tool with empty name by directly manipulating metadata
      const mockTool = createTool({
        name: "valid-tool",
        description: "Test tool",
        input: z.object({ value: z.string().optional() }),
        handler: async (_input: { value?: string }) => [],
      });

      // Override name to empty string (this shouldn't happen in practice)
      (mockTool.metadata as any).name = "";

      await ctx.addTool(mockTool);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("tool:removed event", () => {
    it("should emit tool:removed when removeTool is called", async () => {
      const handler = vi.fn();
      ctx.on("tool:removed", handler);

      const mockTool = createTool({
        name: "test-tool",
        description: "Test tool",
        input: z.object({ value: z.string().optional() }),
        handler: async (_input: { value?: string }) => [],
      });

      await ctx.addTool(mockTool);
      ctx.removeTool("test-tool");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("test-tool");
    });

    it("should not emit tool:removed if tool does not exist", () => {
      const handler = vi.fn();
      ctx.on("tool:removed", handler);

      ctx.removeTool("non-existent-tool");

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("state:changed event", () => {
    it("should emit state:changed when setState is called", () => {
      const handler = vi.fn();
      ctx.on("state:changed", handler);

      ctx.setState("testKey", "testValue");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("testKey", "testValue", undefined);
    });

    it("should emit state:changed with previous value", () => {
      const handler = vi.fn();
      ctx.on("state:changed", handler);

      ctx.setState("testKey", "firstValue");
      ctx.setState("testKey", "secondValue");

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, "testKey", "firstValue", undefined);
      expect(handler).toHaveBeenNthCalledWith(2, "testKey", "secondValue", "firstValue");
    });

    it("should emit state:changed for each key in setStatePartial", () => {
      const handler = vi.fn();
      ctx.on("state:changed", handler);

      ctx.setStatePartial({
        key1: "value1",
        key2: "value2",
        key3: "value3",
      });

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenCalledWith("key1", "value1", undefined);
      expect(handler).toHaveBeenCalledWith("key2", "value2", undefined);
      expect(handler).toHaveBeenCalledWith("key3", "value3", undefined);
    });
  });

  describe("state:cleared event", () => {
    it("should emit state:cleared when clear is called", () => {
      const handler = vi.fn();
      ctx.on("state:cleared", handler);

      ctx.clear();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith();
    });

    it("should not remove event listeners when clear is called", () => {
      const handler = vi.fn();
      ctx.on("state:cleared", handler);

      ctx.clear();
      ctx.clear();

      // Handler should still be registered and called again
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("model:changed event", () => {
    it("should emit model:changed when setModel is called", () => {
      const handler = vi.fn();
      ctx.on("model:changed", handler);

      const mockModel = { id: "test-model" } as any;
      ctx.setModel(mockModel);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(mockModel);
    });

    it("should emit model:changed with undefined when clearing model", () => {
      const handler = vi.fn();
      ctx.on("model:changed", handler);

      ctx.setModel("test-model");
      ctx.setModel(undefined);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(2, undefined);
    });
  });

  describe("model:unset event", () => {
    it("should emit model:unset when unsetModel is called", () => {
      const handler = vi.fn();
      ctx.on("model:unset", handler);

      ctx.unsetModel();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith();
    });
  });

  describe("section:updated event", () => {
    it('should emit section:updated with action "add" when new section is added', () => {
      const handler = vi.fn();
      ctx.on("section:updated", handler);

      const section: COMSection = {
        id: "test-section",
        content: "Test content",
      };

      ctx.addSection(section);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(section, "add");
    });

    it('should emit section:updated with action "update" when existing section is updated', () => {
      const handler = vi.fn();
      ctx.on("section:updated", handler);

      const section1: COMSection = {
        id: "test-section",
        content: "First content",
      };
      const section2: COMSection = {
        id: "test-section",
        content: "Second content",
      };

      ctx.addSection(section1);
      ctx.addSection(section2);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, section1, "add");
      expect(handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: "test-section" }),
        "update",
      );
    });
  });

  describe("metadata:changed event", () => {
    it("should emit metadata:changed when addMetadata is called", () => {
      const handler = vi.fn();
      ctx.on("metadata:changed", handler);

      ctx.addMetadata("testKey", "testValue");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("testKey", "testValue", undefined);
    });

    it("should emit metadata:changed with previous value", () => {
      const handler = vi.fn();
      ctx.on("metadata:changed", handler);

      ctx.addMetadata("testKey", "firstValue");
      ctx.addMetadata("testKey", "secondValue");

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, "testKey", "firstValue", undefined);
      expect(handler).toHaveBeenNthCalledWith(2, "testKey", "secondValue", "firstValue");
    });
  });

  describe("Synchronous event emission", () => {
    it("should emit events synchronously", () => {
      const callOrder: string[] = [];

      ctx.on("state:changed", () => {
        callOrder.push("event-handler");
      });

      ctx.setState("test", "value");
      callOrder.push("after-setState");

      expect(callOrder).toEqual(["event-handler", "after-setState"]);
    });
  });

  describe("Event listener cleanup", () => {
    it("should allow removing listeners", () => {
      const handler = vi.fn();
      ctx.on("state:changed", handler);

      ctx.setState("test", "value");
      expect(handler).toHaveBeenCalledTimes(1);

      ctx.removeListener("state:changed", handler);
      ctx.setState("test", "value2");

      expect(handler).toHaveBeenCalledTimes(1); // Should not be called again
    });

    it("should allow using once for one-time listeners", () => {
      const handler = vi.fn();
      ctx.once("state:changed", handler);

      ctx.setState("test", "value1");
      ctx.setState("test", "value2");

      expect(handler).toHaveBeenCalledTimes(1); // Should only be called once
    });
  });

  describe("Component pattern example", () => {
    it("should support component-scoped listener management", () => {
      const cleanup: Array<() => void> = [];
      const messageHandler = vi.fn();
      const stateHandler = vi.fn();

      // Simulate component onMount
      ctx.on("message:added", messageHandler);
      cleanup.push(() => ctx.removeListener("message:added", messageHandler));

      ctx.on("state:changed", stateHandler);
      cleanup.push(() => ctx.removeListener("state:changed", stateHandler));

      // Trigger events
      ctx.addMessage({ role: "user", content: [{ type: "text", text: "Hello" }] });
      ctx.setState("test", "value");

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(stateHandler).toHaveBeenCalledTimes(1);

      // Simulate component onUnmount
      cleanup.forEach((fn) => fn());

      // Trigger events again - handlers should not be called
      ctx.addMessage({ role: "user", content: [{ type: "text", text: "Hello again" }] });
      ctx.setState("test", "value2");

      expect(messageHandler).toHaveBeenCalledTimes(1); // Still 1
      expect(stateHandler).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe("Type safety", () => {
    it("should enforce correct event handler signatures", () => {
      // This test verifies TypeScript type safety
      // If types are wrong, TypeScript will error at compile time

      // Correct usage - should compile
      ctx.on("message:added", (message: Message, _options: any) => {
        expect(message.role).toBeDefined();
      });

      ctx.on("state:changed", (key: string, _value: unknown, _previousValue: unknown) => {
        expect(typeof key).toBe("string");
      });

      ctx.on("tool:registered", (tool: ExecutableTool) => {
        expect(tool.metadata).toBeDefined();
      });

      ctx.on("state:cleared", () => {
        // No arguments
      });

      // All should compile without errors
      expect(true).toBe(true);
    });
  });

  describe("Multiple listeners", () => {
    it("should support multiple listeners for the same event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      ctx.on("state:changed", handler1);
      ctx.on("state:changed", handler2);
      ctx.on("state:changed", handler3);

      ctx.setState("test", "value");

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });
  });
});
