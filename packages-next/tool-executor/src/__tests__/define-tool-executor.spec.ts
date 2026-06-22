/**
 * `defineToolExecutor` — smoke tests for the callback-style factory.
 *
 * The full ToolExecutorProtocol conformance suite covers the reference
 * `ToolExecutorHarness`; these tests focus on:
 *
 *   1. Marker + factory shape (passes `isToolExecutorFactory`).
 *   2. Dispatch callback receives the input and its result flows back.
 *   3. Default in-memory registry + custom registry callbacks.
 *   4. Abort default + custom path.
 *   5. Substrate sharing — calling with explicit deps surfaces envelopes
 *      on the supplied bus.
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream, Fiber } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  isToolExecutorFactory,
  jsonSchema,
  type DispatchInput,
  type ProtocolEvent,
  type ToolRegistration,
} from "@agentick/spec-next";

import { defineToolExecutor } from "../define-tool-executor.js";

function dispatchOf(name: string, input: unknown): DispatchInput {
  return {
    toolCallId: `c_${name}_${Math.random()}`,
    name,
    input,
    context: { via: "dispatch" },
  };
}

function regOf(name: string): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: name,
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

describe("defineToolExecutor — factory shape", () => {
  it("returns a ToolExecutorFactory (passes the marker type guard)", () => {
    const factory = defineToolExecutor({
      dispatch: async (input) => ({
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: [{ type: "text", text: "ok" }],
      }),
    });
    expect(isToolExecutorFactory(factory)).toBe(true);
  });

  it("constructs an executor that responds to dispatch", async () => {
    const factory = defineToolExecutor({
      dispatch: async (input) => ({
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: [{ type: "text", text: `ran:${input.name}` }],
      }),
    });
    const exec = factory({
      scopeId: "test-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const result = await exec.dispatch(dispatchOf("calc", { a: 1 }));
    expect(result.succeeded).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ran:calc" });
  });
});

describe("defineToolExecutor — registry behavior", () => {
  it("default registry: register/list/unregister work in-memory", async () => {
    const factory = defineToolExecutor({
      dispatch: async (input) => ({
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: [],
      }),
    });
    const exec = factory({
      scopeId: "reg-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await exec.register({ registration: regOf("foo") });
    await exec.register({ registration: regOf("bar") });
    const all = await exec.list();
    expect(all.map((d) => d.name).sort()).toEqual(["bar", "foo"]);
    await exec.unregister({ name: "foo" });
    const after = await exec.list();
    expect(after.map((d) => d.name)).toEqual(["bar"]);
  });

  it("custom list callback overrides the default registry", async () => {
    const remote = [regOf("remote-1").declaration, regOf("remote-2").declaration];
    const factory = defineToolExecutor({
      dispatch: async (input) => ({
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: [],
      }),
      list: async () => remote,
    });
    const exec = factory({
      scopeId: "reg-2",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const all = await exec.list();
    expect(all.map((d) => d.name).sort()).toEqual(["remote-1", "remote-2"]);
  });
});

describe("defineToolExecutor — abort + envelopes", () => {
  it("default abort signals the in-flight controller", async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = defineToolExecutor({
      dispatch: async (input, ctx) => {
        receivedSignal = ctx.signal;
        // Block until aborted.
        await new Promise<void>((resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true });
          setTimeout(resolve, 10_000);
        });
        return {
          toolCallId: input.toolCallId,
          name: input.name,
          succeeded: false,
          content: [],
        };
      },
    });
    const exec = factory({
      scopeId: "abort-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const callId = "c_blocker";
    const dispatchPromise = exec.dispatch({
      toolCallId: callId,
      name: "blocker",
      input: {},
      context: { via: "dispatch" },
    });
    // Give the dispatch a tick to register the in-flight controller.
    await new Promise((r) => setImmediate(r));
    await exec.abort({ toolCallId: callId, reason: "test-abort" });
    await expect(dispatchPromise).rejects.toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("dispatch emits envelopes on the supplied bus", async () => {
    const bus = new LocalEventBus();
    const factory = defineToolExecutor({
      dispatch: async (input) => ({
        toolCallId: input.toolCallId,
        name: input.name,
        succeeded: true,
        content: [{ type: "text", text: "ok" }],
      }),
    });
    const exec = factory({
      scopeId: "env-1",
      journal: new MemoryJournal(),
      bus,
      inbox: new LocalInbox(),
    });

    const events: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "tool" }), (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await exec.dispatch(dispatchOf("ping", {}));
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
  });
});
