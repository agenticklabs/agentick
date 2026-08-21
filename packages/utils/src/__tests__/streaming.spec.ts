import { describe, expect, it } from "vitest";

import { pipeAsyncIterableTo, readableFromAsyncIterable, throttle } from "../streaming.js";

async function* range(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) yield i;
}

/** Collect a ReadableStream to an array via its reader. */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** A WritableStream that records what it was handed, in order. */
function collector<T>(onWrite?: (chunk: T) => Promise<void> | void): {
  readonly stream: WritableStream<T>;
  readonly written: T[];
} {
  const written: T[] = [];
  const stream = new WritableStream<T>({
    async write(chunk) {
      written.push(chunk);
      await onWrite?.(chunk);
    },
  });
  return { stream, written };
}

describe("readableFromAsyncIterable", () => {
  it("yields every value in order, then closes", async () => {
    expect(await drain(readableFromAsyncIterable(range(5)))).toEqual([0, 1, 2, 3, 4]);
  });

  it("is pull-based — it does not drain the source ahead of the consumer", async () => {
    let produced = 0;
    async function* counted(): AsyncGenerator<number> {
      while (true) yield produced++;
    }
    const reader = readableFromAsyncIterable(counted()).getReader();
    await reader.read();
    await reader.read();
    // Default highWaterMark is 1, so at most a small look-ahead — never the
    // whole (infinite) source.
    expect(produced).toBeLessThanOrEqual(4);
    await reader.cancel();
  });

  it("calls the iterator's return() when the stream is cancelled", async () => {
    let returned = false;
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ value: 1, done: false }),
          return: () => {
            returned = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    const reader = readableFromAsyncIterable(iterable).getReader();
    await reader.read();
    await reader.cancel();
    expect(returned).toBe(true);
  });

  it("errors the stream when the source throws", async () => {
    async function* boom(): AsyncGenerator<number> {
      yield 1;
      throw new Error("kaboom");
    }
    await expect(drain(readableFromAsyncIterable(boom()))).rejects.toThrow("kaboom");
  });
});

describe("throttle", () => {
  it("passes every chunk through in order (never drops)", async () => {
    const out = await drain(readableFromAsyncIterable(range(6)).pipeThrough(throttle<number>(5)));
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("spaces emissions at least the requested gap apart", async () => {
    const ms = 30;
    const stamps: number[] = [];
    const { stream } = collector<number>((c) => {
      void c;
      stamps.push(Date.now());
    });
    await readableFromAsyncIterable(range(4)).pipeThrough(throttle<number>(ms)).pipeTo(stream);
    for (let i = 1; i < stamps.length; i++) {
      // `>=` is robust to a slow CI host (slowness only widens gaps).
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(ms - 5);
    }
  });
});

describe("pipeAsyncIterableTo", () => {
  it("writes every event to the destination in order", async () => {
    const { stream, written } = collector<number>();
    await pipeAsyncIterableTo(range(4), stream);
    expect(written).toEqual([0, 1, 2, 3]);
  });

  it("delivers everything even when the sink is slow (backpressure holds)", async () => {
    const { stream, written } = collector<number>(() => new Promise((r) => setTimeout(r, 5)));
    await pipeAsyncIterableTo(range(4), stream);
    expect(written).toEqual([0, 1, 2, 3]);
  });

  it("delivers everything with throttleMs set", async () => {
    const { stream, written } = collector<number>();
    await pipeAsyncIterableTo(range(3), stream, { throttleMs: 5 });
    expect(written).toEqual([0, 1, 2]);
  });

  it("rejects when handed an already-aborted signal", async () => {
    const { stream } = collector<number>();
    await expect(
      pipeAsyncIterableTo(range(4), stream, { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
  });
});
