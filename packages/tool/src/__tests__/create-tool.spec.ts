/**
 * Smoke tests for `createTool` — verifies the bundle shape and that
 * it registers cleanly with the tool-executor harness (testing the
 * peer-dependency arrangement end-to-end).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeToolHandlerCtx } from "@agentick/spec-conformance";

import { createTool, isCreatedTool } from "../create-tool.js";

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
    expect(typeof tool.validator!.validate).toBe("function");
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

  it("threads confirmation seams + aliases (typed on createTool, on the declaration)", () => {
    type Del = { path: string };
    const preview = async (i: Del) => ({ path: i.path });
    const message = (i: Del) => `Delete ${i.path}?`;
    const t = createTool<Del>({
      name: "delete_file",
      description: "risky",
      inputSchema: z.object({ path: z.string() }),
      aliases: ["rm", "del"],
      confirmationMessage: message,
      confirmationPreview: preview,
      annotations: { requiresConfirmation: true },
      handler: async () => [],
    });
    expect(t.declaration.aliases).toEqual(["rm", "del"]);
    // Seams merge INTO annotations alongside the caller's annotations.
    expect(t.declaration.annotations?.requiresConfirmation).toBe(true);
    expect(t.declaration.annotations?.confirmationMessage).toBe(message);
    expect(t.declaration.annotations?.confirmationPreview).toBe(preview);
  });

  it("callable defaultResult on a client-handled tool lands on annotations", () => {
    const fn = () => [{ type: "text" as const, text: "ack" }];
    const t = createTool({
      name: "client_default",
      description: "client",
      defaultResult: fn,
    });
    expect(t.declaration.handlerRef).toBeUndefined();
    expect(t.declaration.annotations?.defaultResult).toBe(fn);
  });
});

describe("createTool — Standard Schema runtime validation", () => {
  it("permissiveValidator when no input schema is supplied", async () => {
    const t = createTool({
      name: "permissive",
      description: "no validation",
      handler: async () => [],
    });
    const result = await t.validator!.validate({ anything: "goes" });
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
    const ok = await t.validator!.validate({ a: 1, b: 2 });
    expect(ok.value).toEqual({ a: 1, b: 2 });
    const bad = await t.validator!.validate({ a: "not a number" });
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
    const fakeCtx = fakeToolHandlerCtx({ toolCallId: "tc-1" });
    await t.handler!({ foo: 1 }, { ctx: fakeCtx, use: {} });
    expect(receivedInput).toEqual({ foo: 1 });
    expect(receivedCtx).toBe(fakeCtx);
  });
});

describe("createTool — client-handled (no handler)", () => {
  it("produces a declaration with handlerRef undefined + no handler/validator", () => {
    const t = createTool({
      name: "client_tool",
      description: "handled by the client",
      annotations: { requiresResponse: true },
    });
    expect(t.declaration.name).toBe("client_tool");
    expect(t.declaration.handlerRef).toBeUndefined();
    expect(t.handlerRef).toBeUndefined();
    expect(t.handler).toBeUndefined();
    expect(t.validator).toBeUndefined();
    // Still a CreatedTool by the structural guard (nested declaration).
    expect(isCreatedTool(t)).toBe(true);
    // Annotations still flow through for the executor's client path.
    expect(t.declaration.annotations?.requiresResponse).toBe(true);
  });
});
