import { describe, it, expect } from "vitest";
import { createTestProcedure } from "./testing.js";
import { isProcedure } from "./procedure.js";

describe("createTestProcedure", () => {
  it("isProcedure() returns true", () => {
    const proc = createTestProcedure();
    expect(isProcedure(proc)).toBe(true);
  });

  it("returns ProcedurePromise with .result chaining", async () => {
    const proc = createTestProcedure({ handler: async (x: number) => x * 2 });
    const result = await proc(5).result;
    expect(result).toBe(10);
  });

  it("default handler returns undefined", async () => {
    const proc = createTestProcedure();
    const result = await proc().result;
    expect(result).toBeUndefined();
  });

  it("custom handler called with correct args", async () => {
    const proc = createTestProcedure({
      handler: async (a: string, b: number) => `${a}-${b}`,
    });
    const result = await proc("hello", 42).result;
    expect(result).toBe("hello-42");
  });

  it("_calls tracks args and timestamps", async () => {
    const proc = createTestProcedure();
    expect(proc._calls).toEqual([]);

    await proc("a", 1);
    await proc("b", 2);

    expect(proc._calls).toHaveLength(2);
    expect(proc._calls[0].args).toEqual(["a", 1]);
    expect(proc._calls[1].args).toEqual(["b", 2]);
    expect(proc._calls[0].timestamp).toBeGreaterThan(0);
    expect(proc._calls[1].timestamp).toBeGreaterThanOrEqual(proc._calls[0].timestamp);
  });

  it("_callCount returns calls.length", async () => {
    const proc = createTestProcedure();
    expect(proc._callCount).toBe(0);
    await proc();
    expect(proc._callCount).toBe(1);
    await proc();
    expect(proc._callCount).toBe(2);
  });

  it("_lastArgs returns last call args", async () => {
    const proc = createTestProcedure();
    expect(proc._lastArgs).toBeUndefined();
    await proc("first");
    expect(proc._lastArgs).toEqual(["first"]);
    await proc("second", 99);
    expect(proc._lastArgs).toEqual(["second", 99]);
  });

  it("respondWith overrides next call only, then reverts", async () => {
    const proc = createTestProcedure({ handler: async () => "default" });

    proc.respondWith("override");
    expect(await proc().result).toBe("override");
    expect(await proc().result).toBe("default");
  });

  it("respondWith accepts a function", async () => {
    let counter = 0;
    const proc = createTestProcedure({ handler: async () => "default" });

    proc.respondWith(() => `call-${++counter}` as any);
    expect(await proc().result).toBe("call-1");
    // Function was consumed, back to default
    expect(await proc().result).toBe("default");
  });

  it("setResponse overrides all subsequent calls", async () => {
    const proc = createTestProcedure({ handler: async () => "default" });

    proc.setResponse("always");
    expect(await proc().result).toBe("always");
    expect(await proc().result).toBe("always");
    expect(await proc().result).toBe("always");
  });

  it("setResponse with function is called each time", async () => {
    let counter = 0;
    const proc = createTestProcedure({ handler: async () => "default" });

    proc.setResponse(() => `call-${++counter}` as any);
    expect(await proc().result).toBe("call-1");
    expect(await proc().result).toBe("call-2");
    expect(await proc().result).toBe("call-3");
  });

  it("respondWith takes priority over setResponse", async () => {
    const proc = createTestProcedure({ handler: async () => "default" });

    proc.setResponse("persistent");
    proc.respondWith("one-shot");

    expect(await proc().result).toBe("one-shot");
    expect(await proc().result).toBe("persistent");
  });

  it("reset() clears everything", async () => {
    const proc = createTestProcedure({ handler: async () => "default" });

    await proc("a");
    await proc("b");
    proc.setResponse("override");
    proc.respondWith("one-shot");

    proc.reset();

    expect(proc._calls).toEqual([]);
    expect(proc._callCount).toBe(0);
    expect(proc._lastArgs).toBeUndefined();
    expect(await proc().result).toBe("default");
  });

  it("all 7 chainable methods exist and return self", () => {
    const proc = createTestProcedure();

    expect(proc.exec).toBe(proc);
    expect(proc.use()).toBe(proc);
    expect(proc.withContext({})).toBe(proc);
    expect(proc.withMiddleware(() => Promise.resolve())).toBe(proc);
    expect(proc.withTimeout(1000)).toBe(proc);
    expect(proc.withMetadata({})).toBe(proc);
    expect(proc.pipe(proc)).toBe(proc);
  });

  it("await proc() resolves to the return value (passthrough mode)", async () => {
    const proc = createTestProcedure({ handler: async () => ({ data: 42 }) });
    const value = await proc();
    expect(value).toEqual({ data: 42 });
  });

  it("handles synchronous handlers", async () => {
    const proc = createTestProcedure({ handler: (x: number) => x + 1 });
    const result = await proc(10).result;
    expect(result).toBe(11);
  });

  it("handles handler that throws", async () => {
    const proc = createTestProcedure({
      handler: () => {
        throw new Error("boom");
      },
    });
    await expect(proc().result).rejects.toThrow("boom");
    expect(proc._callCount).toBe(1);
  });
});
