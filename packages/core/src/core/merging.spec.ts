import { Context } from "./context";
import { mergeStreams, type StreamTag } from "./stream";

describe("Kernel Stream Merging", () => {
  // Helper to create a delayed stream
  const createDelayedStream = async function* (id: string, delays: number[]) {
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      yield `${id}-${Context.tryGet()?.traceId || "no-ctx"}`;
    }
  };

  it("should interleave streams concurrently based on arrival time", async () => {
    const ctx = Context.create({ traceId: "merge-race" });

    await Context.run(ctx, async () => {
      const s1 = createDelayedStream("A", [10, 30]); // A1 (10ms), A2 (40ms)
      const s2 = createDelayedStream("B", [20, 10]); // B1 (20ms), B2 (30ms)

      const merged = mergeStreams([s1, s2]);
      const results: string[] = [];

      for await (const item of merged) {
        results.push(item as string);
      }

      expect(results).toEqual(["A-merge-race", "B-merge-race", "B-merge-race", "A-merge-race"]);
    });
  });

  it("should propagate errors correctly", async () => {
    const s1 = (async function* () {
      yield 1;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("Boom");
    })();
    const s2 = (async function* () {
      yield 2;
      await new Promise((r) => setTimeout(r, 50));
      yield 3;
    })();

    const merged = mergeStreams([s1, s2]);
    const results: any[] = [];

    try {
      for await (const item of merged) {
        results.push(item);
      }
    } catch (e: any) {
      expect(e.message).toBe("Boom");
    }

    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).not.toContain(3);
  });

  it("should support tagged merging (Record input)", async () => {
    const s1 = (async function* () {
      yield "Hello";
    })();
    // Explicit type to satisfy the mergeStreams generic constraint or let it infer union
    const s2 = (async function* () {
      yield { status: "done" };
    })();

    // We cast to any to simplify the test setup for mixed types
    // Real usage would typically merge streams of a discriminated union or base type
    const merged = mergeStreams<any>({
      model: s1,
      tool: s2,
    });

    const results: any[] = [];
    for await (const item of merged) {
      results.push(item);
    }

    // Cast results to StreamTag to inspect
    const modelMsg = results.find((r) => (r as StreamTag<any>).source === "model");
    const toolMsg = results.find((r) => (r as StreamTag<any>).source === "tool");

    expect(modelMsg).toEqual({ source: "model", value: "Hello" });
    expect(toolMsg).toEqual({ source: "tool", value: { status: "done" } });
  });
});
