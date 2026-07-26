/**
 * Trunk derivation at the tool-dispatch seam (ADR 91 §3).
 *
 * The law: the ctx a handler receives carries its parent CROSSING's coordinates
 * — the ambient dispatch op's `opId`, the dispatch's work-path ids — NOT
 * fabricated ones. This drives a REAL dispatch on the reference substrate and
 * reads the trunk off the handler `ctx`, asserting it matches the enclosing
 * dispatch op (proving the ctx now routes through `deriveContext(ambient, …)`).
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type {
  DispatchInput,
  ProtocolEvent,
  ToolHandlerCtx,
  ToolRegistration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";
import type { TestHarnessBundle } from "../testing/index.js";

function reg(name = "trunk-tool"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "reads its ctx trunk",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    toolCallId: "c_trunk",
    name: "trunk-tool",
    input: {},
    context: { via: "dispatch", sessionId: "s1", executionId: "e1", tickId: "t1" },
    ...overrides,
  };
}

async function withBusCapture(
  bus: TestHarnessBundle["bus"],
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

describe("tool dispatch ctx — trunk derivation (ADR 91)", () => {
  it("carries the dispatch crossing's work-path ids + the ambient op's opId, not fabricated ones", async () => {
    let seen: ToolHandlerCtx | undefined;
    const { harness, bus } = await createTestHarness({
      tools: [reg()],
      handlers: [
        {
          handlerRef: "h.trunk-tool",
          handler: (_input, { ctx }) => {
            seen = ctx;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const events = await withBusCapture(bus, async () => {
      await harness.dispatch(dispatchOf());
    });

    expect(seen).toBeDefined();
    // Work-path ids come from the dispatch input's context (the crossing).
    expect(seen!.sessionId).toBe("s1");
    expect(seen!.executionId).toBe("e1");
    expect(seen!.tickId).toBe("t1");
    // `opId` is the ambient dispatch op's id — derived from the crossing's
    // RuntimeContext, NOT synthesized. It matches the dispatch op envelope.
    const dispatchOp = events.find((e) => e.name === "tool:command:dispatch");
    expect(dispatchOp).toBeDefined();
    expect(seen!.opId).toBe(dispatchOp!.opId);
  });
});
