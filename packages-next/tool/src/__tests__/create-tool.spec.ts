/**
 * Smoke tests for `createTool` — verifies the bundle shape and that
 * it registers cleanly with the tool-executor harness (testing the
 * peer-dependency arrangement end-to-end).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTool } from "../create-tool.js";

describe("createTool — bundle shape", () => {
  it("produces { declaration, handlerRef, handler, validator }", () => {
    const tool = createTool({
      name: "calculator",
      description: "Evaluate arithmetic",
      handler: async () => [{ type: "text", text: "ok" }],
    });
    expect(tool.declaration.name).toBe("calculator");
    expect(tool.declaration.description).toBe("Evaluate arithmetic");
    expect(tool.handlerRef).toMatch(/^tool:calculator:/);
    expect(typeof tool.handler).toBe("function");
    expect(typeof tool.validator.validate).toBe("function");
  });

  it("defaults exposure to ['model']", () => {
    const t = createTool({
      name: "x",
      description: "y",
      handler: async () => [],
    });
    expect(t.declaration.exposure).toEqual(["model"]);
  });

  it("respects caller-supplied handlerRef override", () => {
    const t = createTool({
      name: "x",
      description: "y",
      handlerRef: "my.custom.ref",
      handler: async () => [],
    });
    expect(t.handlerRef).toBe("my.custom.ref");
    expect(t.declaration.handlerRef).toBe("my.custom.ref");
  });

  it("forwards annotations + metadata to the declaration", () => {
    const t = createTool({
      name: "x",
      description: "y",
      annotations: { requiresConfirmation: true, timeout: 30_000 },
      metadata: { custom: "tag" },
      handler: async () => [],
    });
    expect(t.declaration.annotations?.requiresConfirmation).toBe(true);
    expect(t.declaration.annotations?.timeout).toBe(30_000);
    expect(t.declaration.metadata?.custom).toBe("tag");
  });
});

describe("createTool — Standard Schema runtime validation", () => {
  it("permissiveValidator when no input schema is supplied", async () => {
    const t = createTool({
      name: "permissive",
      description: "no validation",
      handler: async () => [],
    });
    const result = await t.validator.validate({ anything: "goes" });
    expect(result.value).toEqual({ anything: "goes" });
  });

  it("Zod schema validates and narrows the handler input type", async () => {
    type Calc = { a: number; b: number };
    const t = createTool<Calc>({
      name: "add",
      description: "sum two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }) => [{ type: "text", text: String(a + b) }],
    });
    const ok = await t.validator.validate({ a: 1, b: 2 });
    expect(ok.value).toEqual({ a: 1, b: 2 });
    const bad = await t.validator.validate({ a: "not a number" });
    expect(bad.issues).toBeDefined();
  });
});

describe("createTool — handler invocation contract", () => {
  it("handler receives validated input + ctx bundle", async () => {
    let receivedInput: unknown;
    let receivedCtx: unknown;
    const t = createTool({
      name: "echo",
      description: "echo input",
      handler: async (input, { ctx }) => {
        receivedInput = input;
        receivedCtx = ctx;
        return [{ type: "text", text: "ok" }];
      },
    });
    const fakeCtx = {
      toolCallId: "tc-1",
      signal: new AbortController().signal,
      setState: () => undefined,
      emit: () => undefined,
    };
    await t.handler({ foo: 1 }, { ctx: fakeCtx, use: {} });
    expect(receivedInput).toEqual({ foo: 1 });
    expect(receivedCtx).toBe(fakeCtx);
  });
});
