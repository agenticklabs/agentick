/**
 * Test suite demonstrating the property initializer pattern
 * which provides full type support without coercion.
 */

import { createProcedure, generatorProcedure } from "./procedure";

describe("Procedure v2 - Property Initializer Pattern", () => {
  it("should provide full type support for class properties", async () => {
    class Model {
      // ✅ Full type support - no coercion needed!
      execute = createProcedure(async (input: string): Promise<string> => {
        return input;
      });

      stream = generatorProcedure(async function* (input: string): AsyncIterable<string> {
        yield input;
      });
    }

    const model = new Model();

    // ✅ Full IntelliSense - execute is Procedure<[string], string>
    expect(typeof model.execute).toBe("function");
    expect("use" in model.execute).toBe(true);
    expect("withContext" in model.execute).toBe(true);

    // ✅ Can call directly - use .result to get the handler's return value
    const result = await model.execute("test").result;
    expect(result).toBe("test");

    // ✅ Can chain middleware
    const withMw = model.execute.use(async (args, envelope, next) => {
      return next(args);
    });
    expect(typeof withMw).toBe("function");

    // ✅ ProcedurePromise works with .result property
    const procPromise = model.execute("test");
    expect(procPromise).toBeDefined();
    // In pass-through mode (no handleFactory), .result chains to the final value
    const finalResult = await procPromise.result;
    expect(finalResult).toBe("test");
  });

  it("should work with static middleware", () => {
    const telemetryMw = async (envelope: any, next: any) => {
      return next();
    };

    class Model {
      static middleware = {
        execute: [telemetryMw],
      };

      execute = createProcedure({ name: "execute" }, async (input: string): Promise<string> => {
        return input;
      });
    }

    const model = new Model();
    expect(typeof model.execute).toBe("function");
  });

  it("should preserve method context when needed", async () => {
    class Model {
      private value = "test";

      // Note: Arrow functions capture 'this', regular functions don't
      // For methods that need 'this', use bind or regular function
      execute = createProcedure(async (input: string): Promise<string> => {
        // 'this' is captured from class instance
        return `${this.value}:${input}`;
      });
    }

    const model = new Model();
    const result = await model.execute("input").result;
    expect(result).toBe("test:input");
  });

  it("should work with hooks", async () => {
    class Model {
      processChunk = createProcedure(
        { name: "stream:chunk", sourceType: "hook" },
        async (chunk: string): Promise<string> => {
          return chunk.toUpperCase();
        },
      );
    }

    const model = new Model();
    const result = await model.processChunk("test").result;
    expect(result).toBe("TEST");
  });
});
