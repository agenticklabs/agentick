import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { generateId } from "@agentick/runtime";
import type {
  DispatchInput,
  DispatchResult,
  ProtocolEvent,
  ToolRegistration,
} from "@agentick/spec";
import {
  ToolAbortedError,
  ToolHandlerMissing,
  ToolNotFoundError,
  ToolPermissionError,
  ToolTimeoutError,
  jsonSchema,
} from "@agentick/spec";
import { createTestHarness } from "../testing/index.js";
import { permissiveValidator } from "../validator.js";

function echoReg(
  name = "echo",
  exposure: ("model" | "dispatch")[] = ["model", "dispatch"],
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "echo",
      inputSchema: jsonSchema({ type: "object" }),
      exposure,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
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

describe("ToolExecutorHarness — dispatch idempotency (ADR 51)", () => {
  it("re-dispatching the same toolCallId replays the cached terminal — the tool runs ONCE", async () => {
    let runs = 0;
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => {
            runs += 1;
            return [{ type: "text", text: `run-${runs}` }];
          },
        },
      ],
    });
    // Same toolCallId → deterministic opId `tool:dispatch:dup-call` → the
    // second dispatch hits `lookupTerminal` and replays instead of
    // re-executing a (potentially side-effecting) tool.
    const call = dispatchOf("echo", "dispatch", { a: 1 }, { toolCallId: "dup-call" });
    const first = await harness.dispatch(call);
    const second = await harness.dispatch(call);
    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });
});

describe("ToolExecutorHarness — host door via override (DispatchOptions.via)", () => {
  it("tools.dispatch reaches a model-only tool with { via: 'model' } and refuses without", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("model_only", ["model"])],
      handlers: [
        {
          handlerRef: "h.model_only",
          handler: async () => [{ type: "text", text: "ran" }],
        },
      ],
    });
    await expect(harness.tools.dispatch("model_only", {})).rejects.toThrow(/not exposed/);
    const blocks = await harness.tools.dispatch("model_only", {}, { via: "model" });
    expect(blocks).toEqual([{ type: "text", text: "ran" }]);
  });

  it("{ envelope: true } resolves with the full DispatchResult — typed output and error flag intact", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("typed", ["model", "dispatch"])],
      handlers: [
        {
          handlerRef: "h.typed",
          handler: async () => ({
            content: [{ type: "text", text: "4102" }],
            structuredContent: { total: 4102 },
            isError: false,
          }),
        },
      ],
    });
    const result = await harness.tools.dispatch("typed", {}, { envelope: true });
    expect(result.structuredContent).toEqual({ total: 4102 });
    expect(result.content).toEqual([{ type: "text", text: "4102" }]);
    expect(result.name).toBe("typed");
  });
});

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
      dispatchOf(
        "echo",
        "dispatch",
        { a: 1 },
        { context: { via: "dispatch", use: { sandbox: "s1" } } },
      ),
    );

    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(result.executedBy).toBe("agentick");
    expect(typeof result.durationMs).toBe("number");
    expect(seen).toEqual([{ input: { a: 1 }, useDeps: { sandbox: "s1" } }]);
  });

  it("stamps executedBy from declaration annotations (MCP provenance seam)", async () => {
    // A server-handled tool whose declaration carries `annotations.executedBy`
    // (as `mcpDeclaration` does with `mcp:<serverId>`) surfaces that provenance
    // on the result — the stamp site reads `annotations.executedBy ?? "agentick"`.
    const reg: ToolRegistration = {
      declaration: {
        id: "search",
        name: "search",
        description: "mcp search",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model", "dispatch"],
        annotations: { executedBy: "mcp:linear" },
      },
      handlerRef: "h.search",
      binding: { scope: "runtime" },
    };
    const { harness } = await createTestHarness({
      tools: [reg],
      handlers: [{ handlerRef: "h.search", handler: async () => [{ type: "text", text: "hit" }] }],
    });
    const result = await harness.dispatch(dispatchOf("search", "dispatch", {}));
    expect(result.executedBy).toBe("mcp:linear");
  });

  it("defaults executedBy to agentick when the declaration carries no provenance", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    const result = await harness.dispatch(dispatchOf("echo", "dispatch", {}));
    expect(result.executedBy).toBe("agentick");
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
    await expect(harness.dispatch(dispatchOf("missing", "dispatch", {}))).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
  });

  it("wrong door → ToolPermissionError", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("model-only", ["model"])],
      handlers: [{ handlerRef: "h.model-only", handler: async () => [] }],
    });
    await expect(harness.dispatch(dispatchOf("model-only", "dispatch", {}))).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  it("missing handler → ToolHandlerMissing", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("noimpl")],
      // No handler registered for h.noimpl.
    });
    await expect(harness.dispatch(dispatchOf("noimpl", "dispatch", {}))).rejects.toBeInstanceOf(
      ToolHandlerMissing,
    );
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
      cause: expect.objectContaining({ message: cause.message }),
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
    await expect(inFlight).rejects.toBeInstanceOf(ToolAbortedError);
  });

  it("abort of an unknown id is a no-op", async () => {
    const { harness } = await createTestHarness({});
    await harness.abort({ toolCallId: "never" });
  });

  it("inbox abort (a tool:abort message) cancels an in-flight dispatch with ToolAbortedError", async () => {
    // `abort` is a declared command, so an external actor cancels an
    // in-flight dispatch by `send`-ing the generic command-invocation
    // shape (type `tool:abort`, payload AbortInput) to the harness's
    // address — BaseHarness.dispatchMessage auto-routes it. No custom
    // inbox switch.
    const { harness, inbox } = await createTestHarness({
      tools: [echoReg("slow-inbox")],
      handlers: [
        {
          handlerRef: "h.slow-inbox",
          handler: async (_input, deps) => {
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

    const callId = "inbox-abort-target";
    const inFlight = harness.dispatch(
      dispatchOf("slow-inbox", "dispatch", {}, { toolCallId: callId }),
    );
    await new Promise((r) => setTimeout(r, 10));
    await Effect.runPromise(
      inbox.send(harness.address, {
        messageId: generateId(),
        type: "tool:abort",
        payload: { toolCallId: callId, reason: "inbox cancel" },
      }),
    );
    await expect(inFlight).rejects.toBeInstanceOf(ToolAbortedError);
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
    await expect(inFlight).rejects.toBeInstanceOf(ToolAbortedError);
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
    ).rejects.toBeInstanceOf(ToolTimeoutError);
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

// ============================================================================
// dispatch as a declared command (ADR 51/66) — provenance + inbox-by-name
// ============================================================================

/** Collect bus events until `count` are seen; resolves with the buffer. */
function collectEvents(
  bus: import("@agentick/runtime").LocalEventBus,
  count: number,
): { events: ProtocolEvent[]; done: Promise<void> } {
  const events: ProtocolEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        events.push(e);
        if (events.length >= count) resolve();
      }),
    ),
  );
  return { events, done };
}

describe("ToolExecutorHarness — dispatch command provenance (ADR 51 §5/§6)", () => {
  it("a model-driven dispatch stamps origin 'model' on the journaled envelope", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [echoReg()],
      handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    const { events, done } = collectEvents(bus, 3); // requested → before → terminal

    await harness.dispatch(dispatchOf("echo", "model", { a: 1 }));
    await done;

    const requested = events.find(
      (e) => e.name === "tool:command:dispatch" && e.phase === "requested",
    );
    expect(requested?.scope.origin).toBe("model");
  });

  it("a host/session dispatch stamps origin 'host'", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [echoReg()],
      handlers: [{ handlerRef: "h.echo", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    const { events, done } = collectEvents(bus, 3);

    await harness.dispatch(dispatchOf("echo", "dispatch", { a: 1 }));
    await done;

    const requested = events.find(
      (e) => e.name === "tool:command:dispatch" && e.phase === "requested",
    );
    expect(requested?.scope.origin).toBe("host");
  });
});

describe("ToolExecutorHarness — inbox dispatch-by-name (declared command)", () => {
  it("a tool:dispatch inbox message (serializable payload, no signal) invokes the tool + returns its result", async () => {
    const { harness, inbox } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async (input) => [{ type: "text", text: JSON.stringify(input) }],
        },
      ],
    });

    // Wire-safe DispatchInput: name + input + context (no `signal`). Routes
    // via BaseHarness.dispatchMessage → the declared `tool:dispatch` command.
    const payload: DispatchInput = {
      toolCallId: "inbox-dispatch-1",
      name: "echo",
      input: { hello: "world" },
      context: { via: "dispatch", sessionId: "s1" },
    };

    const result = await Effect.runPromise(
      inbox.ask<DispatchInput, DispatchResult>(harness.address, {
        messageId: generateId(),
        type: "tool:dispatch",
        payload,
      }),
    );

    expect(result.toolCallId).toBe("inbox-dispatch-1");
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: '{"hello":"world"}' }]);
  });
});

// Suppress unused-symbol warning for permissive validator (verified via
// resolver tests; harness integration tests use explicit ones).
void permissiveValidator;

// ============================================================================
// Slice-2 (#136) — replaceCompilerTools + compileForTick via the harness
// ============================================================================

describe("ToolExecutorHarness — replaceCompilerTools (#136)", () => {
  function compilerReg(name: string, mountId: string): ToolRegistration {
    return {
      declaration: {
        id: name,
        name,
        description: name,
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
      },
      handlerRef: `h.${name}`,
      binding: { scope: "compiler", mountId },
    };
  }

  it("swaps the compiler slice atomically per mountId", async () => {
    const { harness } = await createTestHarness();
    await harness.replaceCompilerTools({
      mountId: "m1",
      registrations: [compilerReg("a", "m1"), compilerReg("b", "m1")],
    });
    expect((await harness.list()).map((d) => d.name).sort()).toEqual(["a", "b"]);

    await harness.replaceCompilerTools({
      mountId: "m1",
      registrations: [compilerReg("a", "m1"), compilerReg("c", "m1")],
    });
    expect((await harness.list()).map((d) => d.name).sort()).toEqual(["a", "c"]);
  });

  it("does not disturb other binding slices", async () => {
    const { harness } = await createTestHarness({
      tools: [echoReg("rt-only", ["model"])], // binding: runtime
    });
    await harness.replaceCompilerTools({
      mountId: "m1",
      registrations: [compilerReg("rendered", "m1")],
    });
    const names = (await harness.list()).map((d) => d.name).sort();
    expect(names).toEqual(["rendered", "rt-only"]);

    await harness.replaceCompilerTools({ mountId: "m1", registrations: [] });
    const after = (await harness.list()).map((d) => d.name).sort();
    expect(after).toEqual(["rt-only"]);
  });
});

describe("ToolExecutorHarness — compileForTick precedence (#136)", () => {
  it("compiler binding wins over runtime on name collision", async () => {
    const { harness } = await createTestHarness({
      tools: [
        {
          declaration: {
            id: "foo",
            name: "foo",
            description: "runtime version",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
          },
          handlerRef: "h.foo.runtime",
          binding: { scope: "runtime" },
        },
      ],
    });
    await harness.replaceCompilerTools({
      mountId: "m1",
      registrations: [
        {
          declaration: {
            id: "foo",
            name: "foo",
            description: "compiler version",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
          },
          handlerRef: "h.foo.compiler",
          binding: { scope: "compiler", mountId: "m1" },
        },
      ],
    });
    const compiled = await harness.compileForTick({ exposure: "model" });
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.description).toBe("compiler version");
  });

  it("filter applies BEFORE precedence (high-rank failing filter doesn't shadow lower-rank passing)", async () => {
    const { harness } = await createTestHarness({
      tools: [
        {
          // Higher rank (session) but dispatch-only — should be hidden from model filter
          declaration: {
            id: "foo",
            name: "foo",
            description: "session dispatch-only",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["dispatch"],
          },
          handlerRef: "h.foo.session",
          binding: { scope: "session", sessionId: "s1" },
        },
        {
          // Lower rank (runtime) but model-exposed — should win the filter
          declaration: {
            id: "foo",
            name: "foo",
            description: "runtime model",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
          },
          handlerRef: "h.foo.runtime",
          binding: { scope: "runtime" },
        },
      ],
    });
    const modelView = await harness.compileForTick({ exposure: "model" });
    expect(modelView).toHaveLength(1);
    expect(modelView[0]!.description).toBe("runtime model");
  });
});
