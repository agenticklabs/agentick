/**
 * `defineLoop` — smoke tests for the callback-style factory.
 *
 *   1. Marker + factory shape.
 *   2. runExecution callback receives the input and returns the terminal.
 *   3. abort default + custom path.
 *   4. Envelopes emit on the supplied bus.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  isLoopExecutorFactory,
  type ExecutionTerminal,
  type ProtocolEvent,
  type RunExecutionInput,
} from "@agentick/spec";

import { defineLoop } from "../define-loop.js";

function fakeInput(executionId: string, sessionId = "s_1"): RunExecutionInput {
  // The callback never touches these fields in our smoke tests; cast
  // to satisfy the type while exercising the wrapping behavior.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = {} as any;
  return {
    executionId,
    sessionId,
    reconciler: stub,
    mountId: "m_1",
    executor: stub,
    target: { kind: "language-model", provider: "test", modelId: "x" },
    toolExecutor: stub,
    stateApplicator: stub,
    maxTicks: 1,
  };
}

describe("defineLoop — factory shape", () => {
  it("returns a LoopExecutorFactory (passes the marker type guard)", () => {
    const factory = defineLoop({
      runExecution: async () => ({ outcome: "succeeded" }) as ExecutionTerminal,
    });
    expect(isLoopExecutorFactory(factory)).toBe(true);
  });

  it("constructs a loop that delegates runExecution to the callback", async () => {
    let seen: RunExecutionInput | undefined;
    const factory = defineLoop({
      runExecution: async (input) => {
        seen = input;
        return { outcome: "succeeded" };
      },
    });
    const loop = factory({
      scopeId: "test-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const terminal = await loop.runExecution(fakeInput("e_1"));
    expect(terminal.outcome).toBe("succeeded");
    expect(seen?.executionId).toBe("e_1");
  });
});

describe("defineLoop — abort", () => {
  it("default abort signals the in-flight execution", async () => {
    let receivedSignal: AbortSignal | undefined;
    const factory = defineLoop({
      runExecution: async (input) => {
        receivedSignal = input.signal;
        return new Promise<ExecutionTerminal>((resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal!.reason), {
            once: true,
          });
          setTimeout(() => resolve({ outcome: "succeeded" }), 10_000);
        });
      },
    });
    const loop = factory({
      scopeId: "abort-1",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    const runPromise = loop.runExecution(fakeInput("e_blocker"));
    await new Promise((r) => setImmediate(r));
    await loop.abort({ executionId: "e_blocker", reason: "test" });
    await expect(runPromise).rejects.toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("custom abort callback takes precedence", async () => {
    const aborts: Array<{ executionId: string; reason?: string }> = [];
    const factory = defineLoop({
      runExecution: async () => ({ outcome: "succeeded" }),
      abort: async (input) => {
        aborts.push(input);
      },
    });
    const loop = factory({
      scopeId: "abort-2",
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    });
    await loop.abort({ executionId: "e_x", reason: "manual" });
    expect(aborts).toEqual([{ executionId: "e_x", reason: "manual" }]);
  });
});

describe("defineLoop — envelopes", () => {
  it("runExecution emits requested + terminal envelopes on the supplied bus", async () => {
    const bus = new LocalEventBus();
    const factory = defineLoop({
      runExecution: async () => ({ outcome: "succeeded" }),
    });
    const loop = factory({
      scopeId: "env-1",
      journal: new MemoryJournal(),
      bus,
      inbox: new LocalInbox(),
    });

    const events: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "loop" }), (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await loop.runExecution(fakeInput("e_envelope"));
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
  });
});
