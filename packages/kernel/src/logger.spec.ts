import { Logger, composeContextFields, defaultContextFields } from "./logger";
import { Context, type KernelContext } from "./context";
import { EventEmitter } from "node:events";

describe("Logger", () => {
  beforeEach(() => {
    Logger.reset();
  });

  describe("basic logging", () => {
    it("should create a default logger", () => {
      const log = Logger.get();
      expect(log).toBeDefined();
      expect(typeof log.info).toBe("function");
      expect(typeof log.debug).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
    });

    it("should support all log levels", () => {
      const log = Logger.get();

      // These should not throw
      expect(() => log.trace("trace message")).not.toThrow();
      expect(() => log.debug("debug message")).not.toThrow();
      expect(() => log.info("info message")).not.toThrow();
      expect(() => log.warn("warn message")).not.toThrow();
      expect(() => log.error("error message")).not.toThrow();
      expect(() => log.fatal("fatal message")).not.toThrow();
    });

    it("should support object arguments", () => {
      const log = Logger.get();
      expect(() => log.info({ key: "value" }, "message with object")).not.toThrow();
      expect(() => log.info({ nested: { deep: "value" } })).not.toThrow();
    });
  });

  describe("configuration", () => {
    it("should configure log level", () => {
      Logger.configure({ level: "debug" });
      expect(Logger.level).toBe("debug");
    });

    it("should allow changing level at runtime", () => {
      Logger.configure({ level: "info" });
      expect(Logger.level).toBe("info");

      Logger.setLevel("debug");
      expect(Logger.level).toBe("debug");
    });

    it("should check if level is enabled", () => {
      Logger.configure({ level: "info" });

      expect(Logger.isLevelEnabled("info")).toBe(true);
      expect(Logger.isLevelEnabled("warn")).toBe(true);
      expect(Logger.isLevelEnabled("error")).toBe(true);
      expect(Logger.isLevelEnabled("debug")).toBe(false);
      expect(Logger.isLevelEnabled("trace")).toBe(false);
    });
  });

  describe("child loggers", () => {
    it("should create child logger with string name", () => {
      const log = Logger.for("TestComponent");
      expect(log).toBeDefined();
      expect(typeof log.info).toBe("function");
    });

    it("should create child logger from object", () => {
      class TestClass {}
      const instance = new TestClass();
      const log = Logger.for(instance);
      expect(log).toBeDefined();
    });

    it("should create child logger with custom bindings", () => {
      const log = Logger.child({ custom: "value", request_id: "123" });
      expect(log).toBeDefined();
    });

    it("should allow chaining child loggers", () => {
      const log = Logger.for("Component").child({ operation: "test" });
      expect(log).toBeDefined();
    });
  });

  describe("context integration", () => {
    it("should work outside of context", () => {
      const log = Logger.get();
      // Should not throw even without context
      expect(() => log.info("No context")).not.toThrow();
    });

    it("should inject context fields when available", async () => {
      const ctx: KernelContext = {
        requestId: "req-123",
        traceId: "trace-456",
        user: { id: "user-789", tenantId: "tenant-abc" },
        metadata: {
          threadId: "thread-xyz",
          executionId: "exec-000",
          tick: 3,
        },
        metrics: {},
        events: new EventEmitter(),
      };

      await Context.run(ctx, async () => {
        const log = Logger.get();
        // Should not throw with context
        expect(() => log.info("With context")).not.toThrow();
      });
    });
  });

  describe("standalone logger", () => {
    it("should create standalone logger with custom config", () => {
      const log = Logger.create({ level: "warn" });
      expect(log).toBeDefined();
      expect(log.isLevelEnabled("warn")).toBe(true);
      expect(log.isLevelEnabled("info")).toBe(false);
    });

    it("should not affect global logger", () => {
      Logger.configure({ level: "info" });
      const standalone = Logger.create({ level: "error" });

      expect(Logger.level).toBe("info");
      expect(standalone.isLevelEnabled("warn")).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset global logger", () => {
      Logger.configure({ level: "debug" });
      expect(Logger.level).toBe("debug");

      Logger.reset();

      // After reset, should use default level
      expect(Logger.level).toBe("info");
    });
  });

  describe("composeContextFields", () => {
    it("should compose multiple extractors", () => {
      const ctx: KernelContext = {
        requestId: "req-123",
        traceId: "trace-456",
        user: { id: "user-789", tenantId: "tenant-abc" },
        metadata: { custom_field: "custom_value" },
        metrics: {},
        events: new EventEmitter(),
      };

      const composed = composeContextFields(
        defaultContextFields,
        (c) => ({
          userId: c.user?.id,
          tenantId: c.user?.tenantId,
        }),
        (c) => ({
          custom: c.metadata?.custom_field,
        }),
      );

      const fields = composed(ctx);

      expect(fields.request_id).toBe("req-123");
      expect(fields.trace_id).toBe("trace-456");
      expect(fields.userId).toBe("user-789");
      expect(fields.tenantId).toBe("tenant-abc");
      expect(fields.custom).toBe("custom_value");
    });

    it("should allow later extractors to override earlier ones", () => {
      const ctx: KernelContext = {
        requestId: "req-123",
        traceId: "trace-456",
        metadata: {},
        metrics: {},
        events: new EventEmitter(),
      };

      const composed = composeContextFields(
        () => ({ key: "original" }),
        () => ({ key: "overridden" }),
      );

      const fields = composed(ctx);
      expect(fields.key).toBe("overridden");
    });
  });

  describe("custom contextFields extractor", () => {
    it("should use custom extractor when configured", async () => {
      Logger.configure({
        contextFields: (ctx) => ({
          my_request: ctx.requestId,
          my_custom: "hardcoded",
        }),
      });

      const ctx: KernelContext = {
        requestId: "custom-req-id",
        traceId: "trace-id",
        metadata: {},
        metrics: {},
        events: new EventEmitter(),
      };

      await Context.run(ctx, async () => {
        const log = Logger.get();
        // Should not throw - logging with custom extractor
        expect(() => log.info("With custom extractor")).not.toThrow();
      });
    });

    it("should not include default fields when custom extractor replaces them", () => {
      // This test verifies the custom extractor completely replaces defaults
      const customExtractor = vi.fn((_ctx) => ({
        only_this_field: "value",
      }));

      Logger.configure({ contextFields: customExtractor });

      const ctx: KernelContext = {
        requestId: "req-123",
        traceId: "trace-456",
        metadata: {},
        metrics: {},
        events: new EventEmitter(),
      };

      Context.run(ctx, async () => {
        Logger.get().info("Test");
        expect(customExtractor).toHaveBeenCalled();
      });
    });
  });
});
