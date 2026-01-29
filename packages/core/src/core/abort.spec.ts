import { createProcedure } from "./procedure";

describe("Kernel Abort Handling", () => {
  it("should throw AbortError if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const proc = createProcedure({ name: "test" }, async () => "success").withContext({
      signal: controller.signal,
    });

    await expect(proc()).rejects.toThrow("Operation aborted");
  });

  it("should throw AbortError during middleware execution if aborted", async () => {
    const controller = new AbortController();

    const proc = createProcedure({ name: "test" }, async () => "success")
      .withContext({ signal: controller.signal })
      .use(async (args, envelope, next) => {
        controller.abort(); // Abort before next
        return next(args);
      });

    await expect(proc()).rejects.toThrow("Operation aborted");
  });

  it("should throw AbortError during stream iteration if aborted", async () => {
    const controller = new AbortController();

    const proc = createProcedure({ name: "test" }, async function* () {
      yield 1;
      controller.abort(); // Abort after first chunk
      yield 2;
    }).withContext({ signal: controller.signal });

    const iterator = (await proc()) as AsyncIterable<any>;
    const gen = iterator[Symbol.asyncIterator]();

    await expect(gen.next()).resolves.toEqual({ value: 1, done: false });
    await expect(gen.next()).rejects.toThrow("Operation aborted");
  });
});
