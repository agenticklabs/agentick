/**
 * In-process `ctx.log` / `ctx.progress` (ADR 64).
 *
 * A dispatched tool handler that calls `ctx.log(...)` / `ctx.progress(...)`
 * must emit ONE discrete bus event each — canonical
 * `tool:signal:log` / `tool:signal:progress` name, `terminal` phase,
 * the right payload, and the dispatch's work-path scope
 * (`{ sessionId, executionId, tickId }`). Fire-and-forget: the emit
 * never blocks or fails the handler.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type { DispatchInput, ProtocolEvent, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema, logEventName, progressEventName } from "@agentick/spec-next";

import { createTestHarness } from "../testing/index.js";

function reg(name = "signaller"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "emits a log + progress signal",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    toolCallId: "c_signaller",
    name: "signaller",
    input: {},
    context: {
      via: "dispatch",
      sessionId: "s1",
      executionId: "e1",
      tickId: "t1",
    },
    ...overrides,
  };
}

async function withBusCapture(
  bus: { subscribe: (q: Record<string, never>) => Stream.Stream<ProtocolEvent, unknown, never> },
  run: () => Promise<void>,
): Promise<ProtocolEvent[]> {
  const collected: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        collected.push(e);
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 5));
  await run();
  await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
  return collected;
}

describe("ctx.log / ctx.progress — in-process dispatch (ADR 64)", () => {
  it("ctx.log emits ONE tool:signal:log bus event with payload + dispatch scope", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.signaller",
          handler: async (_input, { ctx }) => {
            ctx.log("warning", { code: 7 }, "tool-logger");
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      const r = await harness.dispatch(dispatchOf());
      expect(r.succeeded).toBe(true);
    });

    const logs = events.filter((e) => e.name === logEventName("tool"));
    expect(logs).toHaveLength(1);
    const ev = logs[0]!;
    expect(ev.surface).toBe("tool");
    expect(ev.phase).toBe("terminal");
    expect(ev.payload).toEqual({ level: "warning", data: { code: 7 }, logger: "tool-logger" });
    expect(ev.scope).toMatchObject({ sessionId: "s1", executionId: "e1", tickId: "t1" });
  });

  it("ctx.progress emits ONE tool:signal:progress bus event with the token + fields", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.signaller",
          handler: async (_input, { ctx }) => {
            ctx.progress("job-1", { progress: 5, total: 20, message: "halfway-ish" });
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      await harness.dispatch(dispatchOf());
    });

    const prog = events.filter((e) => e.name === progressEventName("tool"));
    expect(prog).toHaveLength(1);
    expect(prog[0]!.payload).toEqual({
      token: "job-1",
      progress: 5,
      total: 20,
      message: "halfway-ish",
    });
    expect(prog[0]!.scope).toMatchObject({ sessionId: "s1", executionId: "e1", tickId: "t1" });
  });

  it("ctx.progress omits absent optional fields (total / message)", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.signaller",
          handler: async (_input, { ctx }) => {
            ctx.progress(42, { progress: 1 });
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      await harness.dispatch(dispatchOf());
    });

    const ev = events.find((e) => e.name === progressEventName("tool"))!;
    expect(ev.payload).toEqual({ token: 42, progress: 1 });
  });
});
