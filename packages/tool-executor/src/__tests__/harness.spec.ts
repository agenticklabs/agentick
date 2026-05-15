import { describe, expect, it } from "vitest";
import type { DispatchInput, ToolRegistration } from "@agentick/spec";
import { createTestHarness } from "../testing/index.js";
import { permissiveValidator } from "../validator.js";

function echoReg(name = "echo", exposure: ("model" | "dispatch")[] = ["model", "dispatch"]): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "echo",
      inputSchema: { type: "object" },
      exposure,
    },
    handlerRef: `h.${name}`,
  };
}

function dispatchOf(
  name: string,
  via: "model" | "dispatch",
  input: unknown,
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    toolCallId: overrides.toolCallId ?? `c_${name}`,
    name,
    input,
    context: { via },
    ...overrides,
  };
}

describe("ToolExecutorHarness — dispatch happy path", () => {
  it("invokes the handler with validated input + use deps", async () => {
    const seen: unknown[] = [];
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async (input, deps) => {
            seen.push({ input, useDeps: deps.use });
            return [{ type: "text", text: JSON.stringify(input) }];
          },
        },
      ],
    });

    const result = await harness.dispatch(
      dispatchOf("echo", "dispatch", { a: 1 }, { context: { via: "dispatch", use: { sandbox: "s1" } } }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(result.executedBy).toBe("agentick");
    expect(typeof result.durationMs).toBe("number");
    expect(seen).toEqual([{ input: { a: 1 }, useDeps: { sandbox: "s1" } }]);
  });

  it("preserves toolCallId across the round-trip", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    const result = await harness.dispatch(
      dispatchOf("echo", "dispatch", {}, { toolCallId: "stable-123" }),
    );
    expect(result.toolCallId).toBe("stable-123");
  });
});

describe("ToolExecutorHarness — error paths", () => {
  it("unknown tool → ToolNotFoundError", async () => {
    const { harness } = await createTestHarness({});
    await expect(harness.dispatch(dispatchOf("missing", "dispatch", {}))).rejects.toMatchObject({
      _tag: "ToolNotFoundError",
      name: "missing",
    });
  });

  it("wrong door → ToolPermissionError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("model-only", ["model"])],
      handlers: [{ handlerRef: "h.model-only", handler: async () => [] }],
    });
    await expect(
      harness.dispatch(dispatchOf("model-only", "dispatch", {})),
    ).rejects.toMatchObject({
      _tag: "ToolPermissionError",
      toolName: "model-only",
      via: "dispatch",
    });
  });

  it("missing handler → ToolHandlerMissing", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("noimpl")],
      // No handler registered for h.noimpl.
    });
    await expect(harness.dispatch(dispatchOf("noimpl", "dispatch", {}))).rejects.toMatchObject({
      _tag: "ToolHandlerMissing",
      toolName: "noimpl",
      handlerRef: "h.noimpl",
    });
  });

  it("validator failure → ToolValidationError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("strict")],
      handlers: [
        {
          handlerRef: "h.strict",
          handler: async () => [{ type: "text", text: "should not run" }],
          validator: {
            validate: (v: unknown) => {
              const obj = v as Record<string, unknown> | null;
              if (obj === null || typeof obj.q !== "string") {
                return { issues: [{ message: "q required", path: ["q"] }] };
              }
              return { value: v };
            },
          },
        },
      ],
    });
    await expect(harness.dispatch(dispatchOf("strict", "dispatch", {}))).rejects.toMatchObject({
      _tag: "ToolValidationError",
      toolName: "strict",
      issues: [{ message: "q required", path: ["q"] }],
    });
  });

  it("handler throw → ToolHandlerError (cause preserved)", async () => {
    const cause = new Error("boom");
    const { harness } = await createTestHarness({
      tools: [echoReg("boom")],
      handlers: [
        {
          handlerRef: "h.boom",
          handler: async () => {
            throw cause;
          },
        },
      ],
    });
    await expect(harness.dispatch(dispatchOf("boom", "dispatch", {}))).rejects.toMatchObject({
      _tag: "ToolHandlerError",
      toolName: "boom",
      cause,
    });
  });
});

describe("ToolExecutorHarness — abort", () => {
  it("abort(toolCallId) on an in-flight dispatch rejects with ToolAbortedError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("slow")],
      handlers: [
        {
          handlerRef: "h.slow",
          handler: async (_input, deps) => {
            // Wait until aborted.
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(undefined), 200);
              deps.ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(deps.ctx.signal.reason);
              });
            });
            return [{ type: "text", text: "should not return" }];
          },
        },
      ],
    });

    const callId = "abort-target";
    const inFlight = harness.dispatch(dispatchOf("slow", "dispatch", {}, { toolCallId: callId }));
    await new Promise((r) => setTimeout(r, 10));
    await harness.abort({ toolCallId: callId, reason: "test cancel" });
    await expect(inFlight).rejects.toMatchObject({
      _tag: "ToolAbortedError",
      toolCallId: callId,
    });
  });

  it("abort of an unknown id is a no-op", async () => {
    const { harness } = await createTestHarness({});
    await harness.abort({ toolCallId: "never" });
  });

  it("caller-supplied signal also triggers ToolAbortedError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("slow2")],
      handlers: [
        {
          handlerRef: "h.slow2",
          handler: async (_input, deps) => {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(undefined), 200);
              deps.ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(deps.ctx.signal.reason);
              });
            });
            return [{ type: "text", text: "x" }];
          },
        },
      ],
    });

    const controller = new AbortController();
    const inFlight = harness.dispatch(
      dispatchOf("slow2", "dispatch", {}, { signal: controller.signal }),
    );
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(inFlight).rejects.toMatchObject({ _tag: "ToolAbortedError" });
  });

  it("timeoutMs causes the handler to reject with ToolTimeoutError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("never")],
      handlers: [
        {
          handlerRef: "h.never",
          handler: async (_input, deps) => {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(undefined), 500);
              deps.ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(deps.ctx.signal.reason);
              });
            });
            return [{ type: "text", text: "x" }];
          },
        },
      ],
    });

    await expect(
      harness.dispatch(dispatchOf("never", "dispatch", {}, { timeoutMs: 20 })),
    ).rejects.toMatchObject({
      _tag: "ToolTimeoutError",
      toolName: "never",
      ms: 20,
    });
  });
});

describe("ToolExecutorHarness — registry surface", () => {
  it("register adds + list reports the new tool", async () => {
    const { harness } = await createTestHarness({});
    await harness.register({
      registration: echoReg("later"),
    });
    const names = (await harness.list()).map((d) => d.name);
    expect(names).toContain("later");
  });

  it("unregister removes; subsequent dispatch rejects with ToolNotFoundError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "x" }] }],
    });
    await harness.unregister({ name: "echo" });
    await expect(harness.dispatch(dispatchOf("echo", "dispatch", {}))).rejects.toMatchObject({
      _tag: "ToolNotFoundError",
    });
  });

  it("list filter narrows by exposure", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("model-only", ["model"]), echoReg("dispatch-only", ["dispatch"])],
    });
    const dispatchOnly = (await harness.list({ exposure: "dispatch" })).map((d) => d.name);
    expect(dispatchOnly).toEqual(["dispatch-only"]);
  });
});

describe("ToolExecutorHarness — state store", () => {
  it("setState in a handler is observable via getState", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("setter")],
      handlers: [
        {
          handlerRef: "h.setter",
          handler: async (input, deps) => {
            deps.ctx.setState("seen", input);
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });
    await harness.dispatch(dispatchOf("setter", "dispatch", { v: 42 }));
    expect(harness.getState("seen")).toEqual({ v: 42 });
    expect(harness.snapshotState()).toEqual({ seen: { v: 42 } });
  });
});

// Suppress unused-symbol warning for permissive validator (verified via
// resolver tests; harness integration tests use explicit ones).
void permissiveValidator;
