/**
 * Conformance suite for `LoopExecutorProtocol` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/05-loop-executor.md`.
 *
 * Factories accept everything the loop needs to run — reconciler harness,
 * executor harness, tool executor harness, state applicator. Most tests
 * construct minimal stubs internally and only the loop-under-test
 * differs per impl.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type {
  ExecutionRunResult,
  ExecutionTarget,
  ExecutorProtocol,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LoopExecutorProtocol,
  ReconcilerProtocol,
  RenderedTree,
  StateApplicator,
  ToolDeclaration,
  ToolExecutorProtocol,
} from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

// ============================================================================
// Factory contract
// ============================================================================

export interface LoopExecutorConformanceFactoryInput {
  readonly harnessId: string;
}

export type LoopExecutorConformanceFactory = (
  input: LoopExecutorConformanceFactoryInput,
) => Promise<LoopExecutorProtocol>;

// ============================================================================
// Minimal stubs — every conformance test composes these
// ============================================================================

function mkRenderedTree(tools: readonly ToolDeclaration[] = []): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        {
          kind: "message",
          id: "m_user",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    },
    ...(tools.length > 0 ? { declarations: { tools } } : {}),
  };
}

function mkTarget(): ExecutionTarget {
  return { kind: "language-model", provider: "stub", modelId: "stub-v1" };
}

/** Reconciler stub — returns a canned tree on every `renderTree`. */
function stubReconciler(tree: RenderedTree): ReconcilerProtocol {
  return {
    fx: { renderTree: () => Effect.succeed({ tree, diagnostics: [], iterations: 1 }) },
    mount: async () => ({ mountId: "stub-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree, diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    notifyLifecycle: async () => undefined,
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: "2026-05-08",
      mountId: "stub-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

/**
 * Executor stub — scripted by an array of outcomes. Each `run()` call
 * consumes the next entry. Use to drive multi-tick scenarios.
 */
function stubExecutor(
  scripts: readonly LanguageModelExecutionResult[],
): ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult> {
  let i = 0;
  const runFx = (): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.sync(() => {
      const result = scripts[Math.min(i, scripts.length - 1)] ?? scripts[scripts.length - 1]!;
      i++;
      return { outcome: "succeeded", result };
    });
  return {
    fx: {
      run: runFx,
      project: () => Effect.succeed({ messages: [] }),
      normalize: (input) => Effect.succeed(input.targetOutput as LanguageModelExecutionResult),
      executeStream: () => Effect.succeed(scripts[Math.min(i, scripts.length - 1)] as unknown),
    },
    ready: Promise.resolve(),
    project: async () => ({ messages: [] }),
    execute: async () => scripts[Math.min(i, scripts.length - 1)],
    normalize: async (input) => input.targetOutput as LanguageModelExecutionResult,
    run: () => Effect.runPromise(runFx()),
    abort: async () => undefined,
  };
}

/** Tool executor stub — every dispatch echoes the input. */
function stubToolExecutor(): ToolExecutorProtocol {
  const dispatchFx = (input: { toolCallId: string; name: string; input: unknown }) =>
    Effect.succeed({
      toolCallId: input.toolCallId,
      name: input.name,
      succeeded: true,
      content: [{ type: "text" as const, text: `echoed: ${JSON.stringify(input.input)}` }],
      executedBy: "agentick",
      durationMs: 1,
    });
  return {
    fx: {
      dispatch: (input) => dispatchFx(input),
      replaceReconcilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
    },
    register: async () => undefined,
    unregister: async () => undefined,
    list: async () => [],
    dispatch: (input) => Effect.runPromise(dispatchFx(input)),
    abort: async () => undefined,
    replaceReconcilerTools: async () => undefined,
    removeBoundTools: async () => undefined,
    compileForTick: async () => [],
  };
}

/** State applicator stub — records calls; doesn't apply anywhere. */
function makeRecordingApplicator() {
  const calls: { method: string; payload: unknown }[] = [];
  const applicator: StateApplicator = {
    applyExecutorResult: async (payload) => {
      calls.push({ method: "applyExecutorResult", payload });
    },
    applyToolResults: async (payload) => {
      calls.push({ method: "applyToolResults", payload });
    },
    appendEntry: async (payload) => {
      calls.push({ method: "appendEntry", payload });
    },
  };
  return { applicator, calls };
}

// ============================================================================
// Suite
// ============================================================================

export function runLoopExecutorConformance(factory: LoopExecutorConformanceFactory): void {
  describe("LoopExecutorProtocol — happy path", () => {
    it("runs one tick, returns ExecutionTerminal{succeeded}", async () => {
      const loop = await factory({ harnessId: "loop-happy-1" });
      const tree = mkRenderedTree();
      const { applicator } = makeRecordingApplicator();

      const terminal = await loop.runExecution({
        executionId: "exec-1",
        sessionId: "s-1",
        reconciler: stubReconciler(tree),
        mountId: "stub-mount",
        executor: stubExecutor([
          {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "hi" }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
        target: mkTarget(),
        toolExecutor: stubToolExecutor(),
        stateApplicator: applicator,
        maxTicks: 4,
      });

      expect(terminal.outcome).toBe("succeeded");
      const result = terminal.result as ExecutionRunResult;
      expect(result).toBeDefined();
      expect(result.ticks).toBe(1);
      expect(result.stopReason).toBe("end");
    });

    it("calls applyExecutorResult once per tick", async () => {
      const loop = await factory({ harnessId: "loop-apply-1" });
      const { applicator, calls } = makeRecordingApplicator();
      await loop.runExecution({
        executionId: "exec-2",
        sessionId: "s-1",
        reconciler: stubReconciler(mkRenderedTree()),
        mountId: "stub-mount",
        executor: stubExecutor([
          {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
          },
        ]),
        target: mkTarget(),
        toolExecutor: stubToolExecutor(),
        stateApplicator: applicator,
        maxTicks: 4,
      });
      const applyCalls = calls.filter((c) => c.method === "applyExecutorResult");
      expect(applyCalls).toHaveLength(1);
    });
  });

  describe("LoopExecutorProtocol — tool-call round-trip", () => {
    it("dispatches each toolCall and accumulates results", async () => {
      const loop = await factory({ harnessId: "loop-tools-1" });
      const tools: readonly ToolDeclaration[] = [
        {
          id: "t.calc",
          name: "calculator",
          description: "math",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.calc",
        },
      ];
      const tree = mkRenderedTree(tools);

      const firstRun: LanguageModelExecutionResult = {
        specVersion: "2026-05-08",
        output: [
          {
            type: "tool_use",
            toolUseId: "tc-1",
            name: "calculator",
            input: { expression: "1 + 1" },
          },
        ],
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-1", name: "calculator", input: { expression: "1 + 1" } }],
      };
      const secondRun: LanguageModelExecutionResult = {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "= 2" }],
        stopReason: "end",
      };

      const { applicator, calls } = makeRecordingApplicator();
      const terminal = await loop.runExecution({
        executionId: "exec-tools-1",
        sessionId: "s-1",
        reconciler: stubReconciler(tree),
        mountId: "stub-mount",
        executor: stubExecutor([firstRun, secondRun]),
        target: mkTarget(),
        toolExecutor: stubToolExecutor(),
        stateApplicator: applicator,
        maxTicks: 4,
      });

      expect(terminal.outcome).toBe("succeeded");
      const result = terminal.result as ExecutionRunResult;
      expect(result.ticks).toBeGreaterThanOrEqual(2);
      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0]!.toolName).toBe("calculator");
      expect(result.toolResults[0]!.succeeded).toBe(true);

      const toolApplyCalls = calls.filter((c) => c.method === "applyToolResults");
      expect(toolApplyCalls).toHaveLength(1);
    });
  });

  describe("LoopExecutorProtocol — max ticks", () => {
    it("terminates with stopReason='max_ticks' when the loop would continue past the bound", async () => {
      const loop = await factory({ harnessId: "loop-maxticks-1" });
      const looping: LanguageModelExecutionResult = {
        specVersion: "2026-05-08",
        output: [
          {
            type: "tool_use",
            toolUseId: "tc-x",
            name: "calculator",
            input: {},
          },
        ],
        stopReason: "tool_use",
        toolCalls: [{ id: "tc-x", name: "calculator", input: {} }],
      };

      const { applicator } = makeRecordingApplicator();
      const terminal = await loop.runExecution({
        executionId: "exec-max-1",
        sessionId: "s-1",
        reconciler: stubReconciler(
          mkRenderedTree([
            {
              id: "t.calc",
              name: "calculator",
              description: "",
              inputSchema: jsonSchema({ type: "object" }),
              exposure: ["model"],
              handlerRef: "h.calc",
            },
          ]),
        ),
        mountId: "stub-mount",
        executor: stubExecutor([looping]),
        target: mkTarget(),
        toolExecutor: stubToolExecutor(),
        stateApplicator: applicator,
        maxTicks: 2,
      });

      expect(terminal.outcome).toBe("succeeded");
      const result = terminal.result as ExecutionRunResult;
      expect(result.ticks).toBe(2);
      expect(result.stopReason).toBe("max_ticks");
    });
  });

  describe("LoopExecutorProtocol — abort", () => {
    it("abort with unknown executionId is a no-op", async () => {
      const loop = await factory({ harnessId: "loop-abort-1" });
      await expect(loop.abort({ executionId: "no-such" })).resolves.toBeUndefined();
    });
  });
}
