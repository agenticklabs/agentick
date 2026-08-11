/**
 * Tool executor middleware + lifecycle hook exposure (4a.6).
 *
 * `.use(middleware)` and `.fx.guard(decider)` are thin typed
 * wrappers over `BaseHarness.middleware.use` and (ADR 83)
 * `BaseHarness.guardEffect(...)` — one composed interceptor seam. The base
 * composes both into every operation; these tests verify the typed
 * surfaces work as advertised.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { DispatchInput, DispatchResult, ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

function echoReg(name = "echo"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "echo",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(name: string, toolCallId: string, input: unknown = {}): DispatchInput {
  return {
    toolCallId,
    name,
    input,
    context: { via: "model" },
  };
}

describe("ToolExecutorHarness — .fx.use(middleware)", () => {
  it("wraps the dispatch body — sees both input and result", async () => {
    const observed: Array<{ phase: string; payload: unknown }> = [];
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => [{ type: "text", text: "ran" }],
        },
      ],
    });

    harness.fx.use((input, next) =>
      Effect.gen(function* () {
        observed.push({ phase: "before", payload: input });
        const result = yield* next(input);
        observed.push({ phase: "after", payload: result });
        return result;
      }),
    );

    await harness.dispatch(dispatchOf("echo", "c-mw-1"));
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ phase: "before" });
    expect(observed[1]!.phase).toBe("after");
    expect((observed[1]!.payload as DispatchResult).isError ?? false).toBe(false);
  });

  it("composes outer→inner — first registered is outermost", async () => {
    const order: string[] = [];
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => [{ type: "text", text: "x" }],
        },
      ],
    });

    harness.fx.use((input, next) =>
      Effect.gen(function* () {
        order.push("A-in");
        const r = yield* next(input);
        order.push("A-out");
        return r;
      }),
    );
    harness.fx.use((input, next) =>
      Effect.gen(function* () {
        order.push("B-in");
        const r = yield* next(input);
        order.push("B-out");
        return r;
      }),
    );

    await harness.dispatch(dispatchOf("echo", "c-mw-2"));
    expect(order).toEqual(["A-in", "B-in", "B-out", "A-out"]);
  });

  it("Unsubscribe removes the middleware", async () => {
    let count = 0;
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => [{ type: "text", text: "y" }],
        },
      ],
    });
    const unsub = harness.fx.use((input, next) =>
      Effect.gen(function* () {
        count++;
        return yield* next(input);
      }),
    );
    await harness.dispatch(dispatchOf("echo", "c-mw-3"));
    unsub();
    await harness.dispatch(dispatchOf("echo", "c-mw-4"));
    expect(count).toBe(1);
  });
});

describe("ToolExecutorHarness — .fx.guard(decider)", () => {
  it("proceed verdict (or void) lets dispatch run normally", async () => {
    let ran = 0;
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => {
            ran++;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });
    harness.fx.guard(() => Effect.succeed(undefined));
    const result = await harness.dispatch(dispatchOf("echo", "c-h-1"));
    expect(result.isError ?? false).toBe(false);
    expect(ran).toBe(1);
  });

  it("veto verdict terminates with outcome:vetoed (caller sees the terminal envelope)", async () => {
    let ran = 0;
    const { harness, journal } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => {
            ran++;
            return [{ type: "text", text: "should-not-run" }];
          },
        },
      ],
    });
    harness.fx.guard(() => Effect.succeed({ kind: "veto", reason: "policy block" } as const));
    // Veto path: BaseHarness's terminate emits terminal:vetoed and
    // replayTerminal causes the caller to receive an
    // OperationOutcomeError (Promise reject).
    await expect(harness.dispatch(dispatchOf("echo", "c-h-2"))).rejects.toMatchObject({
      _tag: "OperationOutcomeError",
    });
    expect(ran).toBe(0);
    void journal;
  });

  it("Unsubscribe removes the handler", async () => {
    let vetoes = 0;
    const { harness } = await createTestHarness({
      tools: [echoReg()],
      handlers: [
        {
          handlerRef: "h.echo",
          handler: async () => [{ type: "text", text: "z" }],
        },
      ],
    });
    const unsub = harness.fx.guard(() => {
      vetoes++;
      return Effect.succeed({ kind: "veto", reason: "no" } as const);
    });
    await expect(harness.dispatch(dispatchOf("echo", "c-h-3"))).rejects.toBeTruthy();
    expect(vetoes).toBe(1);
    unsub();
    // After unsub, dispatch should succeed.
    const result = await harness.dispatch(dispatchOf("echo", "c-h-4"));
    expect(result.isError ?? false).toBe(false);
  });
});
