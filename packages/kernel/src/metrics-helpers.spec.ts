import { Context, KernelContext } from "./context";
import {
  addMetric,
  setMetric,
  getMetric,
  addUsageMetrics,
  getUsageMetrics,
} from "./metrics-helpers";

describe("Metrics Helpers", () => {
  let ctx: KernelContext;

  beforeEach(() => {
    ctx = Context.create();
  });

  describe("addMetric", () => {
    it("should add a metric value", () => {
      addMetric(ctx, "usage.inputTokens", 100);

      expect(ctx.metrics!["usage.inputTokens"]).toBe(100);
    });

    it("should accumulate metric values", () => {
      addMetric(ctx, "usage.inputTokens", 100);
      addMetric(ctx, "usage.inputTokens", 50);

      expect(ctx.metrics!["usage.inputTokens"]).toBe(150);
    });

    it("should initialize metrics if not present", () => {
      ctx.metrics = undefined as any;

      addMetric(ctx, "test", 10);

      expect(ctx.metrics).toBeDefined();
      expect(ctx.metrics!["test"]).toBe(10);
    });
  });

  describe("setMetric", () => {
    it("should set a metric value", () => {
      setMetric(ctx, "usage.inputTokens", 100);

      expect(ctx.metrics!["usage.inputTokens"]).toBe(100);
    });

    it("should overwrite existing metric value", () => {
      setMetric(ctx, "usage.inputTokens", 100);
      setMetric(ctx, "usage.inputTokens", 200);

      expect(ctx.metrics!["usage.inputTokens"]).toBe(200);
    });
  });

  describe("getMetric", () => {
    it("should get a metric value", () => {
      ctx.metrics!["usage.inputTokens"] = 100;

      expect(getMetric(ctx, "usage.inputTokens")).toBe(100);
    });

    it("should return 0 for non-existent metric", () => {
      expect(getMetric(ctx, "non.existent")).toBe(0);
    });
  });

  describe("addUsageMetrics", () => {
    it("should add usage metrics with dot notation", () => {
      addUsageMetrics(ctx, {
        inputTokens: 100,
        outputTokens: 50,
        total_tokens: 150,
      });

      expect(ctx.metrics!["usage.inputTokens"]).toBe(100);
      expect(ctx.metrics!["usage.outputTokens"]).toBe(50);
      expect(ctx.metrics!["usage.total_tokens"]).toBe(150);
    });

    it("should accumulate usage metrics", () => {
      addUsageMetrics(ctx, { inputTokens: 100 });
      addUsageMetrics(ctx, { inputTokens: 50 });

      expect(ctx.metrics!["usage.inputTokens"]).toBe(150);
    });
  });

  describe("getUsageMetrics", () => {
    it("should get usage metrics as nested object", () => {
      ctx.metrics!["usage.inputTokens"] = 100;
      ctx.metrics!["usage.outputTokens"] = 50;
      ctx.metrics!["usage.total_tokens"] = 150;

      const usage = getUsageMetrics(ctx);

      expect(usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        total_tokens: 150,
      });
    });

    it("should return empty object if no usage metrics", () => {
      expect(getUsageMetrics(ctx)).toEqual({});
    });

    it("should only return usage.* metrics", () => {
      ctx.metrics!["usage.inputTokens"] = 100;
      ctx.metrics!["other.metric"] = 50;

      const usage = getUsageMetrics(ctx);

      expect(usage).toEqual({ inputTokens: 100 });
      expect(usage).not.toHaveProperty("other");
    });
  });

  describe("dot notation support", () => {
    it("should support flat keys", () => {
      addMetric(ctx, "inputTokens", 100);

      expect(getMetric(ctx, "inputTokens")).toBe(100);
    });

    it("should support nested keys via dot notation", () => {
      addMetric(ctx, "usage.inputTokens", 100);
      addMetric(ctx, "usage.outputTokens", 50);

      expect(getMetric(ctx, "usage.inputTokens")).toBe(100);
      expect(getMetric(ctx, "usage.outputTokens")).toBe(50);
    });

    it("should support deeply nested keys", () => {
      addMetric(ctx, "model.gpt4.usage.inputTokens", 100);

      expect(getMetric(ctx, "model.gpt4.usage.inputTokens")).toBe(100);
    });
  });
});
