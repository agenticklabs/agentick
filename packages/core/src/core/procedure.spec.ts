import { createProcedure, createHook, createPipeline } from "./procedure";
import type { Middleware } from "./procedure";
import { Context } from "./context";

describe("Kernel Procedure", () => {
  it("should execute a simple handler", async () => {
    const proc = createProcedure({ name: "test" }, async (input: number) => input * 2);
    const result = await proc(5);
    expect(result).toBe(10);
  });

  it("should run middleware", async () => {
    const proc = createProcedure({ name: "test" }, async (input: number) => input).use(
      async (args, envelope, next) => {
        const res = await next();
        return res + 1;
      },
    );

    const result = await proc(1);
    expect(result).toBe(2);
  });

  it("should support observability through ExecutionHandle", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 10);
    const handle = await proc();

    const eventLog: any[] = [];
    handle.events.on("*", (e) => eventLog.push(e));
    // Also listen to specific event to ensure it fires
    handle.events.on("procedure:end", (e) => eventLog.push(e));

    await expect(handle.result).resolves.toBe(10);

    // Wait a tick for events to propagate
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventLog.length).toBeGreaterThanOrEqual(1);
    // Check for payload inside the ExecutionEvent
    const endEvent = eventLog.find((e) => e.payload?.result === 10);
    expect(endEvent).toBeDefined();
    expect(endEvent.type).toBe("procedure:end");
  });

  it("should support ad-hoc middleware extension via .use()", async () => {
    const baseProc = createProcedure({ name: "test" }, async () => 1);

    const extendedProc = baseProc.use(async (args, envelope, next) => {
      const res = await next();
      return res + 10;
    });

    const result = await extendedProc();
    expect(result).toBe(11);
  });

  it("should support chained ad-hoc middleware", async () => {
    const baseProc = createProcedure({ name: "test" }, async () => []);

    const chainedProc = baseProc
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, "mw1"];
      })
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, "mw2"];
      })
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, "mw3"];
      });

    // Execution order: mw1 -> mw2 -> mw3 -> handler
    // Return order: handler([]) -> mw3(['mw3']) -> mw2(['mw3', 'mw2']) -> mw1(['mw3', 'mw2', 'mw1'])
    const result = await chainedProc();
    expect(result).toEqual(["mw3", "mw2", "mw1"]);
  });

  it("should support input transformation in middleware", async () => {
    const proc = createProcedure({ name: "test" }, async (input: number) => input * 10)
      .use(async (args, envelope, next) => {
        // Transform input: multiply by 2
        return next([2]); // Pass transformed input
      })
      .use(async (args, envelope, next) => {
        // Transform input again: add 1
        return next([3]); // Pass transformed input
      });

    const result = await proc(1);
    // Input flow: 1 -> (mw1 transforms to 2) -> (mw2 transforms to 3) -> handler(3 * 10 = 30)
    expect(result).toBe(30);
  });

  it("should use original input if middleware does not transform", async () => {
    const proc = createProcedure({ name: "test" }, async (input: number) => input * 2).use(
      async (args, envelope, next) => {
        // Don't transform - just call next() without args
        return next();
      },
    );

    const result = await proc(5);
    // Input flow: 5 -> (mw1 doesn't transform) -> handler(5 * 2 = 10)
    expect(result).toBe(10);
  });

  it("should support mixed transformation and non-transformation middleware", async () => {
    const proc = createProcedure({ name: "test" }, async (input: number) => input * 2)
      .use(async (args, envelope, next) => {
        // Transform: multiply by 2
        return next([10]);
      })
      .use(async (args, envelope, next) => {
        // Don't transform - use current input (10)
        return next();
      })
      .use(async (args, envelope, next) => {
        // Transform again: add 5
        return next([15]);
      });

    const result = await proc(5);
    // Input flow: 5 -> (mw1: 10) -> (mw2: 10) -> (mw3: 15) -> handler(15 * 2 = 30)
    expect(result).toBe(30);
  });
});

/**
 * Tests for new Procedure implementation
 *
 * Tests:
 * - Variable arity (0, 1, N args)
 * - Decorator name inference
 * - Hooks as procedures (direct calls)
 * - Execution graph parent-child tracking
 * - Pipelines
 * - Fluent API
 */

describe("Procedure v2 - Variable Arity", () => {
  beforeEach(() => {
    // Clear context before each test
  });

  it("should support 0 args", async () => {
    const proc = createProcedure(async () => {
      return "result";
    });

    const result = await proc();
    expect(result).toBe("result");
  });

  it("should support 1 arg", async () => {
    const proc = createProcedure(async (input: string) => {
      return input.toUpperCase();
    });

    const result = await proc("test");
    expect(result).toBe("TEST");
  });

  it("should support N args", async () => {
    const proc = createProcedure(async (a: number, b: string, c: boolean) => {
      return `${a}-${b}-${c}`;
    });

    const result = await proc(1, "test", true);
    expect(result).toBe("1-test-true");
  });
});

describe("Procedure v2 - createHook", () => {
  it("should support createHook for private methods", () => {
    class TestClass {
      // generatorProcedure preserves 'this' type - specify it for IntelliSense
      stream = createProcedure(
        { name: "stream" },
        async function* (this: TestClass, input: string) {
          yield await this.processChunk(input); // ✅ Full IntelliSense
        },
      );

      private processChunk = createHook({ name: "stream:chunk" }, async (chunk: string) => {
        return chunk.toUpperCase();
      });
    }

    const instance = new TestClass();
    instance.stream("test").then(console.log);
    // Both should be Procedures
    expect(instance.stream.use).toBeDefined();
    // processChunk is private, but should still be a Procedure
  });
});

describe("Procedure v2 - Pipelines", () => {
  it("should create and use pipelines", async () => {
    const mw1: Middleware = async (args, envelope, next) => {
      return next();
    };

    const mw2: Middleware = async (args, envelope, next) => {
      return next();
    };

    const pipeline = createPipeline([mw1, mw2]);
    pipeline.use(mw1);

    const proc = createProcedure(async (input: string) => {
      return input;
    }).use(pipeline as any);

    const result = await proc("test");
    expect(result).toBe("test");
  });
});

describe("Procedure v2 - Fluent API", () => {
  it("should support .exec() for explicit execution", async () => {
    const proc = createProcedure(async (input: string) => {
      return input.toUpperCase();
    });

    const result1 = await proc("test");
    const result2 = await proc.exec("test");

    expect(result1).toBe("TEST");
    expect(result2).toBe("TEST");
  });

  it("should support .withContext()", async () => {
    const proc = createProcedure(async (input: string) => {
      const ctx = Context.get();
      return ctx.traceId || input;
    });

    const result = await proc.withContext({ traceId: "123" }).exec("test");
    expect(result).toBe("123");
  });

  it("should not create duplicate procedure tracking with .withContext()", async () => {
    // withContext() creates a wrapper that delegates to the original procedure
    // Only the original procedure should be tracked, not the wrapper
    const proc = createProcedure({ name: "myproc" }, async (input: string) => {
      return input.toUpperCase();
    });

    // Track procedure:start events
    const procedureStarts: { pid: string; name: string }[] = [];
    const unsubscribe = Context.subscribeGlobal((event) => {
      if (event.type === "procedure:start") {
        procedureStarts.push(event.payload as { pid: string; name: string });
      }
    });

    try {
      const result = await proc.withContext({ traceId: "test-trace" }).exec("hello");
      expect(result).toBe("HELLO");

      // Check that only ONE procedure:start was emitted (not two)
      const myProcStarts = procedureStarts.filter((p) => p.name === "myproc");
      expect(myProcStarts.length).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("should support .use() chaining", async () => {
    const mw: Middleware<any[]> = async (args, envelope, next) => {
      return next();
    };

    const proc = createProcedure(async (input: string) => {
      return input;
    }).use(mw as any);

    const result = await proc("test");
    expect(result).toBe("test");
  });
});

describe("Procedure v2 - Hooks as Procedures", () => {
  it("should allow direct calls to hooks", async () => {
    const processChunk = createHook(async (chunk: string) => {
      return chunk.toUpperCase();
    });

    const result = await processChunk("test");
    expect(result).toBe("TEST");
  });

  it("should track parent-child in execution graph", async () => {
    // Use middleware to force execution through the tracking path
    // (pass-through without middleware skips tracking for performance)
    const noopMiddleware: Middleware<[string]> = async (_args, _envelope, next) => next();

    const stream = createProcedure({ name: "stream" }, async function* (_input: string) {
      const processChunk = createHook({ name: "stream:chunk" }, async (chunk: string) => {
        return chunk;
      });

      for (const chunk of ["a", "b", "c"]) {
        yield await processChunk(chunk);
      }
    }).use(noopMiddleware);

    const ctx = Context.create();
    const results: string[] = [];

    const iterable = await Context.run(ctx, async () => stream("test"));
    for await (const chunk of iterable) {
      results.push(chunk);
    }

    expect(results).toEqual(["a", "b", "c"]);

    // Check execution graph exists
    expect(ctx.procedureGraph).toBeDefined();
    if (ctx.procedureGraph) {
      const allNodes = ctx.procedureGraph.getAllNodes();
      expect(allNodes.length).toBeGreaterThan(0);
      // At least the root procedure should be tracked
      const root = allNodes.find((node) => !node.parentPid);
      expect(root).toBeDefined();
    }
  });
});

describe("Procedure Timeout", () => {
  it("should complete before timeout", async () => {
    const proc = createProcedure({ name: "fast", timeout: 1000 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    });

    const result = await proc();
    expect(result).toBe("done");
  });

  it("should throw AbortError.timeout when exceeded", async () => {
    const proc = createProcedure({ name: "slow", timeout: 50 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "should not get here";
    });

    await expect(proc()).rejects.toThrow("timed out");
  });

  it("should support withTimeout() for ad-hoc timeout", async () => {
    const proc = createProcedure({ name: "slow" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "should not get here";
    });

    const timedProc = proc.withTimeout(50);

    await expect(timedProc()).rejects.toThrow("timed out");
  });

  it("should not apply timeout when set to 0", async () => {
    const proc = createProcedure({ name: "no-timeout", timeout: 0 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    });

    const result = await proc();
    expect(result).toBe("done");
  });

  it("should clear timeout on successful completion", async () => {
    // This test ensures we don't have timer leaks
    const proc = createProcedure({ name: "fast", timeout: 5000 }, async () => "done");

    const result = await proc();
    expect(result).toBe("done");
    // If timeout wasn't cleared, Jest would complain about open handles
  });

  it("should work with ExecutionHandle", async () => {
    const proc = createProcedure({ name: "slow", timeout: 50 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "should not get here";
    });

    const handle = proc();

    await expect(handle).rejects.toThrow("timed out");
  });
});

describe("Procedure Pipe", () => {
  it("should pipe two procedures together", async () => {
    const double = createProcedure({ name: "double" }, async (n: number) => n * 2);
    const addTen = createProcedure({ name: "addTen" }, async (n: number) => n + 10);

    const pipeline = double.pipe(addTen);
    const result = await pipeline(5);

    // 5 * 2 = 10, 10 + 10 = 20
    expect(result).toBe(20);
  });

  it("should chain multiple pipes", async () => {
    const parse = createProcedure({ name: "parse" }, async (json: string) => JSON.parse(json));
    const getName = createProcedure({ name: "getName" }, async (obj: { name: string }) => obj.name);
    const toUpper = createProcedure({ name: "toUpper" }, async (s: string) => s.toUpperCase());

    const pipeline = parse.pipe(getName).pipe(toUpper);
    const result = await pipeline('{"name": "hello"}');

    expect(result).toBe("HELLO");
  });

  it("should propagate errors through the pipeline", async () => {
    const willFail = createProcedure({ name: "fail" }, async () => {
      throw new Error("oops");
    });
    const shouldNotRun = createProcedure({ name: "never" }, async (x: any) => x);

    const pipeline = willFail.pipe(shouldNotRun);

    await expect(pipeline()).rejects.toThrow("oops");
  });

  it("should work with the static pipe function", async () => {
    const { pipe } = await import("./procedure");

    const a = createProcedure({ name: "a" }, async (n: number) => n + 1);
    const b = createProcedure({ name: "b" }, async (n: number) => n * 2);
    const c = createProcedure({ name: "c" }, async (n: number) => n - 3);

    const pipeline = pipe(a, b, c);
    const result = await pipeline(5);

    // (5 + 1) * 2 - 3 = 9
    expect(result).toBe(9);
  });

  it("should return the same procedure when pipe has one argument", async () => {
    const { pipe } = await import("./procedure");

    const single = createProcedure({ name: "single" }, async (n: number) => n);
    const result = pipe(single);

    expect(result).toBe(single);
  });

  it("should preserve context through piped procedures", async () => {
    const traceIds: string[] = [];

    const captureTrace = createProcedure({ name: "capture" }, async (n: number) => {
      const ctx = Context.tryGet();
      if (ctx?.traceId) traceIds.push(ctx.traceId);
      return n;
    });

    const addOne = createProcedure({ name: "addOne" }, async (n: number) => {
      const ctx = Context.tryGet();
      if (ctx?.traceId) traceIds.push(ctx.traceId);
      return n + 1;
    });

    const pipeline = captureTrace.pipe(addOne);

    await Context.run(Context.create({ traceId: "test-trace" }), async () => {
      await pipeline(1);
    });

    // Both procedures should see the same trace ID
    expect(traceIds.length).toBe(2);
    expect(traceIds[0]).toBe("test-trace");
    expect(traceIds[1]).toBe("test-trace");
  });
});

describe("Procedure Compose", () => {
  it("should compose procedures right-to-left", async () => {
    const { compose } = await import("./procedure");

    const double = createProcedure({ name: "double" }, async (n: number) => n * 2);
    const addTen = createProcedure({ name: "addTen" }, async (n: number) => n + 10);

    // compose(double, addTen)(5) = double(addTen(5)) = double(15) = 30
    const composed = compose(double, addTen);
    const result = await composed(5);

    expect(result).toBe(30);
  });

  it("should be opposite of pipe", async () => {
    const { pipe, compose } = await import("./procedure");

    const a = createProcedure({ name: "a" }, async (n: number) => n + 1);
    const b = createProcedure({ name: "b" }, async (n: number) => n * 2);
    const c = createProcedure({ name: "c" }, async (n: number) => n - 3);

    // pipe(a, b, c)(5) = c(b(a(5))) = c(b(6)) = c(12) = 9
    const piped = pipe(a, b, c);
    const pipedResult = await piped(5);

    // compose(c, b, a)(5) = c(b(a(5))) = same as pipe(a, b, c)
    const composed = compose(c, b, a);
    const composedResult = await composed(5);

    expect(pipedResult).toBe(composedResult);
    expect(pipedResult).toBe(9);
  });

  it("should return the same procedure when compose has one argument", async () => {
    const { compose } = await import("./procedure");

    const single = createProcedure({ name: "single" }, async (n: number) => n);
    const result = compose(single);

    expect(result).toBe(single);
  });

  it("should chain multiple procedures in FP order", async () => {
    const { compose } = await import("./procedure");

    const format = createProcedure({ name: "format" }, async (s: string) => s.toUpperCase());
    const trim = createProcedure({ name: "trim" }, async (s: string) => s.trim());
    const parse = createProcedure({ name: "parse" }, async (input: string) => input);

    // compose(format, trim, parse)(x) = format(trim(parse(x)))
    const composed = compose(format, trim, parse);
    const result = await composed("  hello  ");

    expect(result).toBe("HELLO");
  });
});

describe("Procedure Symbol Branding", () => {
  it("should brand procedures with PROCEDURE_SYMBOL", async () => {
    const { PROCEDURE_SYMBOL } = await import("./procedure");

    const proc = createProcedure(async (x: number) => x * 2);

    expect(PROCEDURE_SYMBOL in proc).toBe(true);
    expect((proc as any)[PROCEDURE_SYMBOL]).toBe(true);
  });

  it("isProcedure should return true for branded procedures", async () => {
    const { isProcedure } = await import("./procedure");

    const proc = createProcedure(async (x: number) => x * 2);

    expect(isProcedure(proc)).toBe(true);
  });

  it("isProcedure should return false for plain functions", async () => {
    const { isProcedure } = await import("./procedure");

    const plainFn = async (x: number) => x * 2;

    expect(isProcedure(plainFn)).toBe(false);
  });

  it("isProcedure should return false for objects with similar methods (duck typing defeated)", async () => {
    const { isProcedure } = await import("./procedure");

    // This would pass duck typing but should fail symbol check
    const fakeProcedure = {
      use: () => {},
      withContext: () => {},
      exec: () => {},
    };

    expect(isProcedure(fakeProcedure)).toBe(false);
  });

  it("isProcedure should return false for null/undefined", async () => {
    const { isProcedure } = await import("./procedure");

    expect(isProcedure(null)).toBe(false);
    expect(isProcedure(undefined)).toBe(false);
  });

  it("piped procedures should also be branded", async () => {
    const { isProcedure, pipe } = await import("./procedure");

    const a = createProcedure(async (n: number) => n + 1);
    const b = createProcedure(async (n: number) => n * 2);
    const piped = pipe(a, b);

    expect(isProcedure(piped)).toBe(true);
  });

  it("composed procedures should also be branded", async () => {
    const { isProcedure, compose } = await import("./procedure");

    const a = createProcedure(async (n: number) => n + 1);
    const b = createProcedure(async (n: number) => n * 2);
    const composed = compose(a, b);

    expect(isProcedure(composed)).toBe(true);
  });
});

// ============================================================================
// ExecutionHandle Tests - PromiseLike + AsyncIterable Interface
// ============================================================================

describe("ExecutionHandle - PromiseLike interface", () => {
  it("should resolve to result when awaited", async () => {
    const proc = createProcedure({ name: "test" }, async (x: number) => x * 2);
    const handle = proc(5);

    // Handle should have then method (PromiseLike)
    expect(typeof handle.then).toBe("function");

    // Awaiting should give the result
    const result = await handle;
    expect(result).toBe(10);
  });

  it("should support .then() chaining", async () => {
    const proc = createProcedure({ name: "test" }, async (x: number) => x + 1);
    const handle = proc(5);

    const result = await handle.then((r) => r * 2);
    expect(result).toBe(12); // (5 + 1) * 2
  });

  it("should support .then() with rejection handler", async () => {
    const proc = createProcedure({ name: "test" }, async () => {
      throw new Error("test error");
    });

    const handle = proc();
    const result = await handle.then(
      () => "success",
      (err) => `caught: ${err.message}`,
    );

    expect(result).toBe("caught: test error");
  });

  it("should have status property", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const handle = await proc();

    // Status should be running initially
    expect(handle.status).toBe("running");

    await handle.result;

    // Status should be completed after awaiting
    expect(handle.status).toBe("completed");
  });

  it("should have traceId property", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 1);
    const handle = await proc();

    expect(typeof handle.traceId).toBe("string");
    expect(handle.traceId.length).toBeGreaterThan(0);

    await handle.result;
  });

  it("should have events property (EventEmitter)", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 1);
    const handle = await proc();

    expect(handle.events).toBeDefined();
    expect(typeof handle.events.on).toBe("function");
    expect(typeof handle.events.emit).toBe("function");

    await handle.result;
  });

  it("should have abort method", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 1);
    const handle = await proc();

    expect(typeof handle.abort).toBe("function");

    await handle.result;
  });

  it("should update status to aborted when abort is called", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => {
      // Long running operation
      await new Promise((r) => setTimeout(r, 1000));
      return 1;
    });

    const handle = await proc();
    expect(handle.status).toBe("running");

    handle.abort("user cancelled");
    expect(handle.status).toBe("aborted");
  });

  it("should have deprecated result property that resolves to same value", async () => {
    const proc = createProcedure({ name: "test" }, async () => 42);
    const handle = proc();

    // Both should give same result
    const [awaitResult, resultProp] = await Promise.all([handle, handle.result]);

    expect(awaitResult).toBe(42);
    expect(resultProp).toBe(42);
  });

  it("handle should work with Promise.all", async () => {
    const proc = createProcedure({ name: "test" }, async (x: number) => x * 2);

    const results = await Promise.all([proc(1), proc(2), proc(3)]);

    expect(results).toEqual([2, 4, 6]);
  });

  it("handle should work with Promise.race", async () => {
    const fast = createProcedure({ name: "fast" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "fast";
    });

    const slow = createProcedure({ name: "slow" }, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "slow";
    });

    const result = await Promise.race([fast(), slow()]);
    expect(result).toBe("fast");
  });

  it("should maintain error handling through PromiseLike", async () => {
    const proc = createProcedure({ name: "test" }, async () => {
      throw new Error("expected error");
    });

    const handle = proc();

    await expect(handle).rejects.toThrow("expected error");
  });
});

describe("ExecutionHandle - AsyncIterable interface", () => {
  it("should have Symbol.asyncIterator", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 1);
    const handle = await proc();

    expect(typeof handle[Symbol.asyncIterator]).toBe("function");

    await handle.result;
  });

  it("should be iterable with for-await-of (empty when no events)", async () => {
    const proc = createProcedure({ name: "test", handleFactory: true }, async () => 1);
    const handle = await proc();

    const events: any[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    // Default implementation may or may not yield events
    // The key thing is it should not throw and should terminate
    expect(Array.isArray(events)).toBe(true);
  });
});

describe("ExecutionHandle - with handleFactory", () => {
  it("custom handleFactory should receive result promise", async () => {
    const { ExecutionHandleImpl } = await import("./procedure");
    let receivedResult: Promise<any> | null = null;

    const customHandleFactory = (
      events: any,
      traceId: string,
      result: Promise<any>,
      context: any,
      abortController?: AbortController,
    ) => {
      receivedResult = result;
      // Return a default handle implementation
      return new ExecutionHandleImpl(result, events, traceId, abortController);
    };

    const proc = createProcedure(
      { name: "test", handleFactory: customHandleFactory },
      async () => 42,
    );

    const handle = proc();
    await handle;

    expect(receivedResult).not.toBeNull();
    expect(await receivedResult).toBe(42);
  });
});

describe("DirectProcedure - handleFactory: false (pass-through)", () => {
  it("should return handler result directly without wrapping", async () => {
    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async (x: number) => x * 2,
    );

    const result = await proc(5);
    expect(result).toBe(10);
  });

  it("should pass through handler result directly", async () => {
    // Pass-through mode passes the handler's return value through
    // Note: if handler returns a PromiseLike (like ExecutionHandle),
    // the async middleware chain will await it, giving the resolved value

    // For non-PromiseLike returns, the value passes through as-is
    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async () => ({ type: "custom", value: 42 }),
    );

    const result = await proc();
    expect(result).toEqual({ type: "custom", value: 42 });
  });

  it("should work when delegating to another procedure", async () => {
    // When delegating to another procedure, the result is the inner procedure's result
    // (not its handle, since ExecutionHandle is PromiseLike and gets awaited)
    const innerProc = createProcedure({ name: "inner" }, async () => "inner-result");

    const outerProc = createProcedure(
      { name: "outer", handleFactory: false },
      () => innerProc(), // Returns ExecutionHandle which is PromiseLike
    );

    // The result is the inner procedure's resolved value
    const result = await outerProc();
    expect(result).toBe("inner-result");
  });

  it("should still run middleware in pass-through mode", async () => {
    const log: string[] = [];

    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async (x: number) => x * 2,
    ).use(async (args, envelope, next) => {
      log.push("before");
      const result = await next();
      log.push("after");
      return result + 1;
    });

    const result = await proc(5);

    expect(log).toEqual(["before", "after"]);
    expect(result).toBe(11); // (5 * 2) + 1
  });

  it("should support withContext in pass-through mode", async () => {
    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async () => {
        const ctx = Context.tryGet();
        return ctx?.metadata?.custom;
      },
    );

    const procWithCtx = proc.withContext({ metadata: { custom: "value" } });
    const result = await procWithCtx();

    expect(result).toBe("value");
  });

  it("should support withMiddleware in pass-through mode", async () => {
    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async (x: number) => x,
    );

    const procWithMw = proc.withMiddleware(async (args, envelope, next) => {
      const result = await next();
      return result * 10;
    });

    const result = await procWithMw(5);
    expect(result).toBe(50);
  });

  it("should support withTimeout in pass-through mode", async () => {
    const proc = createProcedure(
      { name: "pass-through", handleFactory: false },
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "done";
      },
    );

    const procWithTimeout = proc.withTimeout(10);

    await expect(procWithTimeout()).rejects.toThrow();
  });

  it("should work with use() chaining", async () => {
    const proc = createProcedure({ name: "pass-through", handleFactory: false }, async () => 1)
      .use(async (args, env, next) => (await next()) + 1)
      .use(async (args, env, next) => (await next()) * 2);

    // Middleware runs in registration order:
    // +1 middleware calls next -> *2 middleware calls next -> handler returns 1
    // *2 returns 1 * 2 = 2, +1 returns 2 + 1 = 3
    const result = await proc();
    expect(result).toBe(3);
  });
});
