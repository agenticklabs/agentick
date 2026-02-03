import { createProcedure } from "./procedure";
import { Context } from "./context";

describe("Kernel Streaming", () => {
  it("should stream data via AsyncGenerator (pass-through mode)", async () => {
    // Use handleFactory: false for pass-through mode where the generator is returned directly
    const proc = createProcedure({ name: "test", handleFactory: false }, async function* () {
      yield 1;
      yield 2;
    });

    const iterator = (await proc()) as AsyncIterable<number>;
    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([1, 2]);
  });

  it("should preserve context across yields when run within Context.run (pass-through mode)", async () => {
    // Use handleFactory: false for pass-through mode
    // Context preservation during generator iteration requires the iteration
    // to happen within a context. ExecutionTracker.track() wraps async iterables
    // to maintain context, but we need to iterate within that wrapped context.
    const proc = createProcedure({ name: "test", handleFactory: false }, async function* () {
      const ctx = Context.tryGet();
      yield ctx?.traceId ?? "no-context";
      yield ctx?.traceId ?? "no-context";
    });

    // Create a context and run iteration within it
    const ctx = Context.create({ traceId: "test-trace-id" });
    const chunks: string[] = [];

    await Context.run(ctx, async () => {
      const iterator = (await proc()) as AsyncIterable<string>;
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    });

    // Context should be preserved across yields
    expect(chunks[0]).toBe("test-trace-id");
    expect(chunks[0]).toBe(chunks[1]);
  });

  it("should expose events emitter on ExecutionHandle", async () => {
    // ExecutionHandle exposes events emitter for custom event handling
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => {
      return "done";
    });

    const handle = await proc();
    const events: string[] = [];

    // Handle exposes events emitter that can be used for custom events
    handle.events.on("custom:event", (event) => events.push(event.payload));
    handle.events.emit("custom:event", { payload: "test" });

    expect(events).toEqual(["test"]);
    await handle.result;
  });
});
