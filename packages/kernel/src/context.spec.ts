import { Context } from "./context";

describe("Kernel Context (ALS)", () => {
  it("should propagate context to nested async calls", async () => {
    const ctx = Context.create({ traceId: "test-trace" });

    await Context.run(ctx, async () => {
      // Level 1
      expect(Context.get().traceId).toBe("test-trace");

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Level 2 (Async)
      expect(Context.get().traceId).toBe("test-trace");
    });
  });

  it("should isolate contexts", async () => {
    const ctx1 = Context.create({ traceId: "trace-1" });
    const ctx2 = Context.create({ traceId: "trace-2" });

    const p1 = Context.run(ctx1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Context.get().traceId;
    });

    const p2 = Context.run(ctx2, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Context.get().traceId;
    });

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toBe("trace-1");
    expect(res2).toBe("trace-2");
  });

  it("should throw if accessed outside of context", () => {
    expect(() => Context.get()).toThrow("Context not found");
  });
});
