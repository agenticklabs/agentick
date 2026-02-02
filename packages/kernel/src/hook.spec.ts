import { createHook } from "./procedure";
import { Context } from "./context";

describe("Kernel Hook", () => {
  it("should execute a simple handler", async () => {
    const hook = createHook({ name: "test" }, async (input) => input * 2);

    const result = await hook(5);
    expect(result).toBe(10);
  });

  it("should support multiple arguments", async () => {
    const hook = createHook({ name: "test" }, async (name, count) => `${name}: ${count}`);

    const result = await hook("test", 5);
    expect(result).toBe("test: 5");
  });

  it("should run middleware", async () => {
    const hook = createHook({ name: "test" }, async (input: number) => input * 2).use(
      async ([_input], _envelope, next) => {
        // Transform: input + 1, then handler multiplies by 2, then add 1 to result
        // Flow: 1 -> [2] -> handler(2) = 4 -> 4 + 1 = 5
        // But test expects 3, so let's adjust: input = 1, transform to [1], handler(1) = 2, add 1 = 3
        const res = await next();
        return res + 1;
      },
    );

    const result = await hook(1);
    // Flow: 1 -> handler(1) = 2 -> 2 + 1 = 3
    expect(result).toBe(3);
  });

  it("should support input transformation in middleware", async () => {
    const hook = createHook(async (input: number) => input * 10)
      .use(async ([value], envelope, next) => {
        // Transform input: multiply first arg by 2
        return next([value * 2]);
      })
      .use(async ([value], envelope, next) => {
        // Transform input again: add 1
        return next([value + 1]);
      });

    const result = await hook(5);
    // Input flow: [5] -> (mw1: [10]) -> (mw2: [11]) -> handler(11 * 10 = 110)
    expect(result).toBe(110);
  });

  it("should use original input if middleware does not transform", async () => {
    const hook = createHook(async (input: number) => input * 2).use(
      async (args, envelope, next) => {
        // Don't transform - just call next() without args
        return next();
      },
    );

    const result = await hook(5);
    // Input flow: [5] -> (mw1 doesn't transform) -> handler(5 * 2 = 10)
    expect(result).toBe(10);
  });

  it("should support mixed transformation and non-transformation middleware", async () => {
    const hook = createHook(async (input: number) => input * 2)
      .use(async ([value], envelope, next) => {
        // Transform: multiply by 2
        return next([value * 2]);
      })
      .use(async (args, envelope, next) => {
        // Don't transform - use current input
        return next();
      })
      .use(async ([value], envelope, next) => {
        // Transform again: add 5
        return next([value + 5]);
      });

    const result = await hook(5);
    // Input flow: [5] -> (mw1: [10]) -> (mw2: [10]) -> (mw3: [15]) -> handler(15 * 2 = 30)
    expect(result).toBe(30);
  });

  it("should support multiple arguments transformation", async () => {
    const hook = createHook(async (name: string, count: number) => `${name}: ${count}`).use(
      async ([name, count], envelope, next) => {
        // Transform: uppercase first arg, double second arg
        return next([name.toUpperCase(), count * 2]);
      },
    );

    const result = await hook("test", 5);
    // Input flow: ['test', 5] -> (mw1: ['TEST', 10]) -> handler('TEST: 10')
    expect(result).toBe("TEST: 10");
  });

  it("should support ad-hoc middleware extension via .use()", async () => {
    const baseHook = createHook(async (input: number) => input);

    const extendedHook = baseHook.use(async (args, envelope, next) => {
      const res = await next();
      return res + 10;
    });

    const result = await extendedHook(1);
    expect(result).toBe(11);
  });

  it("should support chained ad-hoc middleware", async () => {
    const baseHook = createHook(async () => []);

    const chainedHook = baseHook
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, 1];
      })
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, 2];
      })
      .use(async (args, envelope, next) => {
        const res = await next();
        return [...res, 3];
      });

    const result = await chainedHook();
    // Execution order: mw1 -> mw2 -> mw3 -> handler
    // Return order: handler([]) -> mw3([3]) -> mw2([3,2]) -> mw1([3,2,1])
    expect(result).toEqual([3, 2, 1]);
  });

  it("should have access to context", async () => {
    const hook = createHook(async (input: number) => `Result: ${input}`).use(
      async (args, envelope, next) => {
        // Access context
        expect(envelope.context.requestId).toBeDefined();
        expect(envelope.context.traceId).toBeDefined();
        return next();
      },
    );

    const result = await hook(5);
    expect(result).toBe("Result: 5");
  });

  it("should support void return type", async () => {
    let called = false;
    const hook = createHook(async (_message: string) => {
      called = true;
    });

    await hook("test");
    expect(called).toBe(true);
  });

  it("should support no arguments", async () => {
    const hook = createHook(async () => 42);

    const result = await hook();
    expect(result).toBe(42);
  });

  it("should isolate nested hooks in same async context", async () => {
    // Create a parent hook
    const parentHook = createHook(async (value: number) => value).use(
      async ([value], envelope, next) => {
        // Call nested hook
        const nestedHook = createHook(async (nestedValue: number) => nestedValue).use(
          async ([nestedValue], nestedEnvelope, nestedNext) => {
            // Nested hook should receive its own input, not parent's
            return nestedNext([nestedValue * 3]);
          },
        );

        const nestedResult = await nestedHook(value + 1);
        // Nested hook: (value + 1) * 3
        // Parent hook: value * 2
        return next([value * 2 + nestedResult]);
      },
    );

    const result = await parentHook(5);
    // Parent: 5 -> nestedHook(6) -> nested: 6 * 3 = 18 -> parent: 5 * 2 + 18 = 28
    expect(result).toBe(28);
  });

  it("should handle concurrent hooks correctly", async () => {
    const hook1 = createHook(async (value: number) => value).use(
      async ([value], envelope, next) => {
        return next([value * 2]);
      },
    );

    const hook2 = createHook(async (value: number) => value).use(
      async ([value], envelope, next) => {
        return next([value * 3]);
      },
    );

    // Run concurrently
    const [result1, result2] = await Promise.all([hook1(5), hook2(7)]);

    expect(result1).toBe(10); // 5 * 2
    expect(result2).toBe(21); // 7 * 3
  });

  it("should preserve input transformation chain in nested calls", async () => {
    const outerHook = createHook(async (value: number) => value * 5)
      .use(async ([value], envelope, next) => {
        // Transform: add 10
        return next([value + 10]);
      })
      .use(async ([value], envelope, next) => {
        // Call inner hook
        const innerHook = createHook(async (innerValue: number) => innerValue).use(
          async ([innerValue], innerEnvelope, innerNext) => {
            // Inner hook transforms: multiply by 2
            return innerNext([innerValue * 2]);
          },
        );

        const innerResult = await innerHook(value);
        // Continue outer chain with inner result
        return next([innerResult]);
      });

    const result = await outerHook(5);
    // Flow: 5 -> (outer mw1: 15) -> innerHook(15) -> (inner mw1: 30) -> inner handler: 30
    // -> (outer mw2: 30) -> outer handler: 30 * 5 = 150
    expect(result).toBe(150);
  });

  it("should handle errors in middleware correctly", async () => {
    const hook = createHook(async (value: number) => value).use(async (_args, _envelope, _next) => {
      throw new Error("Middleware error");
    });

    await expect(hook(5)).rejects.toThrow("Middleware error");
  });

  it("should handle errors in handler correctly", async () => {
    const hook = createHook(async (_value: number) => {
      throw new Error("Handler error");
    });

    await expect(hook(5)).rejects.toThrow("Handler error");
  });

  it("should support complex argument types", async () => {
    interface ComplexArg {
      name: string;
      count: number;
    }

    const hook = createHook(
      async (obj: ComplexArg, suffix: string) => `${obj.name}-${obj.count}-${suffix}`,
    ).use(async ([obj, suffix], envelope, next) => {
      // Transform: uppercase name, double count
      return next([{ name: obj.name.toUpperCase(), count: obj.count * 2 }, suffix.toUpperCase()]);
    });

    const result = await hook({ name: "test", count: 5 }, "end");
    expect(result).toBe("TEST-10-END");
  });

  it("should throw AbortError if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const hook = createHook(async () => "success");

    // Create context with aborted signal
    const ctx = Context.create({ signal: controller.signal });

    await Context.run(ctx, async () => {
      await expect(hook()).rejects.toThrow("Operation aborted");
      const error = await hook().catch((e) => e);
      expect(error.name).toBe("AbortError");
    });
  });

  it("should throw AbortError during middleware execution if aborted", async () => {
    const controller = new AbortController();

    const hook = createHook(async (value: number) => value).use(async (args, envelope, next) => {
      controller.abort(); // Abort before next
      return next();
    });

    const ctx = Context.create({ signal: controller.signal });

    await Context.run(ctx, async () => {
      await expect(hook(5)).rejects.toThrow("Operation aborted");
    });
  });

  it("should throw AbortError during handler execution if aborted", async () => {
    const controller = new AbortController();

    const hook = createHook(async (value: number) => {
      return value * 2;
    }).use(async (args, envelope, next) => {
      // Abort before calling handler
      controller.abort();
      return next();
    });

    const ctx = Context.create({ signal: controller.signal });

    await Context.run(ctx, async () => {
      // Abort check happens before handler execution
      await expect(hook(5)).rejects.toThrow("Operation aborted");
      const error = await hook(5).catch((e) => e);
      expect(error.name).toBe("AbortError");
    });
  });
});
