/**
 * Structured cancellation (ADR 77 Stage 5) — `loop.abort()` tears down
 * IN-FLIGHT work immediately, not at the next tick boundary.
 *
 * Because the loop is one fiber (Stage 3), a per-execution `AbortController`
 * fired by `abort()` is merged with the caller's `input.signal` into one
 * `execSignal` threaded to `executor.fx.run` / `executeStream` and
 * `toolExecutor.fx.dispatch`. The executor turns that signal into real
 * Effect fiber interruption of the provider call; the tool executor honors
 * it on the handler. Before Stage 5 a mid-flight `abort()` only set a
 * cooperative flag checked between ticks — a long model call ran to
 * completion first.
 *
 * These tests use a HANGING executor whose `fx.run` blocks until the signal
 * aborts. If the signal did not reach it, the run would never settle and the
 * test would time out — so a passing test IS the proof the abort propagates.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  DispatchResult,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  ReconcilerProtocol,
  RunExecutionInput,
  RunInput,
  ToolExecutorProtocol,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";

import { LoopExecutorHarness } from "../harness.js";
import { NoopStateApplicator } from "../noop-state-applicator.js";

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

const okResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

const EMPTY_TREE = { specVersion: SPEC_VERSION, context: { entries: [] } };

function stubReconciler(): ReconcilerProtocol {
  return {
    fx: { renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }) },
    mount: async () => ({ mountId: "c-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    notifyLifecycle: async () => undefined,
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "c-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  } as unknown as ReconcilerProtocol;
}

function stubToolExecutor(
  dispatch: (input: {
    toolCallId: string;
    name: string;
    signal?: AbortSignal;
  }) => Promise<DispatchResult>,
): ToolExecutorProtocol {
  return {
    fx: {
      replaceReconcilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: (i: { toolCallId: string; name: string; signal?: AbortSignal }) =>
        Effect.tryPromise({ try: () => dispatch(i), catch: (e) => e }),
    },
  } as unknown as ToolExecutorProtocol;
}

/**
 * An executor whose `fx.run` HANGS until its `input.signal` aborts, then
 * settles a `canceled` terminal. `onStart` fires when the run is in-flight
 * so the test can abort at the right moment. No facade `executeStream` →
 * the loop takes the non-streaming (`fx.run`) path.
 */
function hangingExecutor(onStart: () => void): LanguageModelExecutor {
  return {
    family: "language-model",
    target: { kind: "language-model", provider: "fake", modelId: "hang-v1" },
    ready: Promise.resolve(),
    fx: {
      run: (input: RunInput) =>
        Effect.async<ExecutorTerminal<LanguageModelExecutionResult>>((resume) => {
          const signal = input.signal;
          const settleCanceled = (): void =>
            resume(
              Effect.succeed({
                outcome: "canceled",
                reason: String(signal?.reason ?? "aborted"),
              }),
            );
          onStart();
          if (signal?.aborted) {
            settleCanceled();
            return;
          }
          signal?.addEventListener("abort", settleCanceled, { once: true });
          // Otherwise HANG — only an abort settles this run.
        }),
      project: () => Effect.succeed({ messages: [] }),
      normalize: () => Effect.succeed(okResult),
      executeStream: () => Effect.succeed({} as unknown),
    },
  } as unknown as LanguageModelExecutor;
}

function baseInput(
  executionId: string,
  executor: LanguageModelExecutor,
  toolExecutor: ToolExecutorProtocol,
): RunExecutionInput {
  return {
    sessionId: "s_c",
    mountId: "c-mount",
    reconciler: stubReconciler(),
    executor,
    toolExecutor,
    target: executor.target,
    stateApplicator: new NoopStateApplicator(),
    executionId,
    maxTicks: 5,
  };
}

describe("LoopExecutorHarness — structured cancellation (Stage 5)", () => {
  it("abort() tears down an IN-FLIGHT model call → canceled terminal", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_c1", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const executor = hangingExecutor(started);
    const toolExecutor = stubToolExecutor(async (i) => ({
      toolCallId: i.toolCallId,
      name: i.name,
      content: [],
      durationMs: 1,
    }));

    const p = loop.runExecution(baseInput("exec_c1", executor, toolExecutor));

    // Wait until the model call is genuinely in flight, THEN abort.
    await inFlight;
    await loop.abort({ executionId: "exec_c1", reason: "user-stop" });

    // The run settled promptly (torn down by the merged signal) — no timeout.
    const terminal = await p;
    expect(terminal.outcome).toBe("canceled");
    expect(terminal.reason).toBe("user-stop");
  });

  it("abort() tears down an IN-FLIGHT tool handler (dispatch signal)", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_c2", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    // A model that returns a tool_use immediately, then the tool hangs until
    // its dispatch signal aborts. Non-hanging executor for tick 1.
    const toolUseExec = {
      family: "language-model",
      target: { kind: "language-model", provider: "fake", modelId: "tu-v1" },
      ready: Promise.resolve(),
      fx: {
        run: () =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "succeeded",
            result: {
              specVersion: SPEC_VERSION,
              output: [{ type: "text", text: "calling" }],
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [{ id: "tc1", name: "t", input: {} }],
            },
          }),
        project: () => Effect.succeed({ messages: [] }),
        normalize: () => Effect.succeed(okResult),
        executeStream: () => Effect.succeed({} as unknown),
      },
    } as unknown as LanguageModelExecutor;

    let toolStarted!: () => void;
    const toolInFlight = new Promise<void>((r) => {
      toolStarted = r;
    });
    // The tool hangs until its signal aborts, then rejects (hard failure).
    const toolExecutor = stubToolExecutor(
      (i) =>
        new Promise<DispatchResult>((_resolve, reject) => {
          toolStarted();
          const onAbort = (): void =>
            reject(new Error(`tool aborted: ${String(i.signal?.reason)}`));
          if (i.signal?.aborted) onAbort();
          else i.signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );

    const p = loop.runExecution(baseInput("exec_c2", toolUseExec, toolExecutor));

    await toolInFlight;
    await loop.abort({ executionId: "exec_c2", reason: "user-stop" });

    // The dispatch was torn down (rejected) → the loop caught it as a failed
    // tool result and the execution settled (canceled — abort set the map).
    const terminal = await p;
    expect(terminal.outcome).toBe("canceled");
    const tr = terminal.result!.toolResults;
    expect(tr).toHaveLength(1);
    expect(tr[0]!.succeeded).toBe(false);
    expect(tr[0]!.error).toBeInstanceOf(Error);
  });
});

// ============================================================================
// Parallel tool dispatch (Stage 5)
// ============================================================================

/** A 2-tick executor: tick 1 returns `tool_use` with the given calls; tick 2 ends. */
function multiToolExec(toolCalls: readonly { id: string; name: string }[]): LanguageModelExecutor {
  let call = 0;
  return {
    family: "language-model",
    target: { kind: "language-model", provider: "fake", modelId: "mt-v1" },
    ready: Promise.resolve(),
    fx: {
      run: () =>
        Effect.sync(() => {
          call += 1;
          if (call === 1) {
            return {
              outcome: "succeeded",
              result: {
                specVersion: SPEC_VERSION,
                output: [{ type: "text", text: "calling" }],
                stopReason: "tool_use",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, input: {} })),
              },
            } satisfies ExecutorTerminal<LanguageModelExecutionResult>;
          }
          return {
            outcome: "succeeded",
            result: okResult,
          } satisfies ExecutorTerminal<LanguageModelExecutionResult>;
        }),
      project: () => Effect.succeed({ messages: [] }),
      normalize: () => Effect.succeed(okResult),
      executeStream: () => Effect.succeed({} as unknown),
    },
  } as unknown as LanguageModelExecutor;
}

describe("LoopExecutorHarness — parallel tool dispatch (Stage 5)", () => {
  it("dispatches a tick's tool calls CONCURRENTLY (default unbounded); results stay in call-order", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_p1", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    // RENDEZVOUS proof of concurrency: tool "A" (FIRST in call order) awaits a
    // gate that tool "B" (second) opens. Sequential dispatch (A then B) would
    // DEADLOCK — A waits for B, which never starts. Parallel completes.
    let openA!: () => void;
    const aGate = new Promise<void>((r) => {
      openA = r;
    });
    const completed: string[] = [];
    const toolExecutor = stubToolExecutor(async (i) => {
      if (i.name === "A") await aGate;
      else openA();
      completed.push(i.name);
      return { toolCallId: i.toolCallId, name: i.name, content: [], durationMs: 1 };
    });

    const executor = multiToolExec([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    const terminal = await loop.runExecution(baseInput("exec_p1", executor, toolExecutor));

    // Completed at all ⇒ parallel (a sequential loop would hang forever).
    expect(terminal.outcome).toBe("succeeded");
    // Results are in CALL order regardless of completion order (Effect.all).
    expect(terminal.result!.toolResults.map((r) => r.toolName)).toEqual(["A", "B"]);
    // But B genuinely COMPLETED before A — the concurrency actually happened.
    expect(completed).toEqual(["B", "A"]);
  });

  it("toolConcurrency: 1 opts out to sequential — independent tools, call-order", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_p2", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const order: string[] = [];
    const toolExecutor = stubToolExecutor(async (i) => {
      order.push(i.name);
      return { toolCallId: i.toolCallId, name: i.name, content: [], durationMs: 1 };
    });
    const executor = multiToolExec([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);

    const terminal = await loop.runExecution({
      ...baseInput("exec_p2", executor, toolExecutor),
      toolConcurrency: 1,
    });

    expect(terminal.outcome).toBe("succeeded");
    expect(order).toEqual(["A", "B"]);
    expect(terminal.result!.toolResults.map((r) => r.toolName)).toEqual(["A", "B"]);
  });
});

// ============================================================================
// Execution timeout (Stage 5)
// ============================================================================

describe("LoopExecutorHarness — execution timeout (Stage 5)", () => {
  it("timeoutMs → structured abort → canceled terminal, stopReason 'timeout'", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_t1", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    // A hanging model call — only the timeout can end it.
    const executor = hangingExecutor(() => {});
    const toolExecutor = stubToolExecutor(async (i) => ({
      toolCallId: i.toolCallId,
      name: i.name,
      content: [],
      durationMs: 1,
    }));

    const terminal = await loop.runExecution({
      ...baseInput("exec_t1", executor, toolExecutor),
      timeoutMs: 40,
    });

    expect(terminal.outcome).toBe("canceled");
    expect(terminal.reason).toBe("execution timeout");
    expect(terminal.result!.stopReason).toBe("timeout");
  });
});
