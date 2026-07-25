/**
 * Slice-4 (#138) — layered-tools wiring through the loop.
 *
 * Verifies the loop's tick contract:
 *   1. Render: pull tools from `RenderedTree.declarations.tools`.
 *   2. Sync: call `toolExecutor.replaceCompilerTools(mountId, ...)`
 *      to mirror the just-rendered slice into the registry.
 *   3. Compile: call `toolExecutor.compileForTick({ exposure: "model" })`
 *      to get the precedence-resolved set.
 *   4. Pass the compiled set as `tools` to `executor.run({...})` /
 *      `executor.project({...})`.
 *
 * Uses a real `ToolExecutorHarness` (not a stub) so the round-trip
 * through the registry's add → list pipeline is exercised. Uses
 * a custom executor stub that records the `tools` arg from its
 * `run()` invocation.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  AbortExecutorInput,
  ContentBlock,
  ExecuteInput,
  ExecutorStream,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  NormalizeInput,
  ProjectInput,
  CompilerProtocol,
  RenderedTree,
  RunInput,
  StateApplicator,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";
import { ToolExecutorHarness, InMemoryHandlerResolver } from "@agentick/tool-executor";
import { ElicitationHarness } from "@agentick/elicitation";

import { LoopExecutorHarness } from "../harness.js";

// ============================================================================
// Fixtures
// ============================================================================

function mkSubstrate() {
  return {
    journal: new MemoryJournal(),
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
  };
}

async function mkToolExecutor(
  scopeId: string,
  substrate: ReturnType<typeof mkSubstrate>,
  initialTools: readonly ToolRegistration[] = [],
): Promise<ToolExecutorHarness> {
  const elic = new ElicitationHarness(
    `${scopeId}:elic`,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
  );
  await elic.ready;
  const harness = new ToolExecutorHarness(
    scopeId,
    substrate.journal,
    substrate.bus,
    substrate.inbox,
    { handlerResolver: new InMemoryHandlerResolver(), elicitation: elic, initialTools },
  );
  await harness.ready;
  return harness;
}

function mkCompiler(tools: readonly ToolDeclaration[]): CompilerProtocol {
  const mkTree = (): RenderedTree => ({
    specVersion: SPEC_VERSION,
    context: { entries: [] },
    ...(tools.length > 0 ? { declarations: { tools } } : {}),
  });
  return {
    fx: {
      use: () => () => {},
      renderTree: () => Effect.succeed({ tree: mkTree(), diagnostics: [], iterations: 1 }),
    },
    mount: async () => ({ mountId: "stub-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => ({ tree: mkTree(), diagnostics: [], iterations: 1 }),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "stub-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

function noopApplicator(): StateApplicator {
  return {
    fx: {
      applyExecutorResult: () => Effect.void,
      applyToolResults: () => Effect.void,
    },
    applyExecutorResult: async () => undefined,
    applyToolResults: async () => undefined,
    appendEntry: async () => undefined,
  };
}

/**
 * Executor that records the `tools` arg from every `run()` call into a
 * shared `captured.runs` array. Always resolves with a trivial
 * succeeded terminal.
 */
function mkRecordingExecutor(): {
  readonly executor: LanguageModelExecutor;
  readonly captured: {
    runs: Array<readonly ToolDeclaration[]>;
    projects: Array<readonly ToolDeclaration[]>;
  };
} {
  const captured = {
    runs: [] as Array<readonly ToolDeclaration[]>,
    projects: [] as Array<readonly ToolDeclaration[]>,
  };
  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION,
    output: [{ type: "text", text: "ok" } satisfies ContentBlock],
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const runFx = (input: RunInput): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.sync(() => {
      captured.runs.push(input.tools);
      return { outcome: "succeeded", result };
    });
  const executor: LanguageModelExecutor = {
    family: "language-model",
    target: { kind: "language-model", provider: "fake", modelId: "fake-v1" },
    ready: Promise.resolve(),
    fx: {
      use: () => () => {},
      run: runFx,
      project: (input) =>
        Effect.sync(() => {
          captured.projects.push(input.tools);
          return { messages: [] };
        }),
      normalize: () => Effect.succeed(result),
      executeStream: () => Effect.succeed(result),
    },
    async project(input: ProjectInput): Promise<LanguageModelInput> {
      captured.projects.push(input.tools);
      return { messages: [] };
    },
    async execute(_: ExecuteInput<LanguageModelInput>): Promise<unknown> {
      return result;
    },
    async normalize(_: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> {
      return result;
    },
    run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
      return Effect.runPromise(runFx(input));
    },
    executeStream(_: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
      const iter: AsyncIterableIterator<never> & ExecutorStream<unknown> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          return { done: true as const, value: undefined as never };
        },
        result: Promise.resolve(result),
        async abort() {},
      };
      return iter;
    },
    async abort(_: AbortExecutorInput): Promise<void> {},
  };
  return { executor, captured };
}

// ============================================================================
// Suite
// ============================================================================

describe("LoopExecutorHarness — layered tools (#138)", () => {
  it("syncs the compiler-emitted tools into the registry and passes them to run()", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_1", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const tools: readonly ToolDeclaration[] = [
      {
        id: "t.calc",
        name: "calc",
        description: "math",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.calc",
      },
    ];

    const compiler = mkCompiler(tools);
    const toolExecutor = await mkToolExecutor("tools_1", sub);
    const { executor, captured } = mkRecordingExecutor();

    await loop.runExecution({
      sessionId: "s_1",
      mountId: "m_test",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec",
      maxTicks: 1,
    });

    // The loop should have passed the compiler-emitted tool through
    // to executor.run via the registry's compile.
    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!.map((t) => t.name)).toEqual(["calc"]);
  });

  it("merges compiler tools with pre-existing extension-bound tools via precedence", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_2", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    // An extension already registered a tool at app level — slice 5/6
    // will wire this through `installer.registerExtensionTool`, but
    // here we seed it directly via initialTools.
    const extensionTool: ToolRegistration = {
      declaration: {
        id: "t.search",
        name: "search",
        description: "extension tool",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.search",
      },
      handlerRef: "h.search",
      binding: { scope: "extension", extensionName: "@x/y", level: "app" },
    };
    const toolExecutor = await mkToolExecutor("tools_2", sub, [extensionTool]);

    // Compiler emits a different tool.
    const compiler = mkCompiler([
      {
        id: "t.calc",
        name: "calc",
        description: "math",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.calc",
      },
    ]);
    const { executor, captured } = mkRecordingExecutor();

    await loop.runExecution({
      sessionId: "s_2",
      mountId: "m_test_2",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec",
      maxTicks: 1,
    });

    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!.map((t) => t.name).sort()).toEqual(["calc", "search"]);
  });

  it("compiler binding overrides extension binding on name collision", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_3", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const extensionTool: ToolRegistration = {
      declaration: {
        id: "t.calc",
        name: "calc",
        description: "extension's calc",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.calc.ext",
      },
      handlerRef: "h.calc.ext",
      binding: { scope: "extension", extensionName: "@x/y", level: "app" },
    };
    const toolExecutor = await mkToolExecutor("tools_3", sub, [extensionTool]);

    const compiler = mkCompiler([
      {
        id: "t.calc.rendered",
        name: "calc", // same name — compiler should win
        description: "rendered calc",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.calc.rendered",
      },
    ]);
    const { executor, captured } = mkRecordingExecutor();

    await loop.runExecution({
      sessionId: "s_3",
      mountId: "m_test_3",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec",
      maxTicks: 1,
    });

    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!).toHaveLength(1);
    expect(captured.runs[0]![0]!.description).toBe("rendered calc");
  });

  it("filters compileForTick to model-exposed tools (dispatch-only tools don't reach the model)", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_4", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const toolExecutor = await mkToolExecutor("tools_4", sub);
    const compiler = mkCompiler([
      {
        id: "t.visible",
        name: "visible",
        description: "model can see",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.visible",
      },
      {
        id: "t.hidden",
        name: "hidden",
        description: "host dispatch only",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["dispatch"],
        handlerRef: "h.hidden",
      },
    ]);
    const { executor, captured } = mkRecordingExecutor();

    await loop.runExecution({
      sessionId: "s_4",
      mountId: "m_test_4",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec",
      maxTicks: 1,
    });

    expect(captured.runs[0]!.map((t) => t.name)).toEqual(["visible"]);
  });

  it("rendering nothing this tick clears the prior compiler slice via replaceCompilerTools([])", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("loop_5", sub.journal, sub.bus, sub.inbox);
    await loop.ready;
    const toolExecutor = await mkToolExecutor("tools_5", sub);

    // First tick: compiler emits a tool, loop syncs it into the
    // registry. The registry's compiler slice has one entry.
    let stage = 0;
    const renderResult = () => {
      const tools: readonly ToolDeclaration[] =
        stage === 0
          ? [
              {
                id: "t.x",
                name: "x",
                description: "x",
                inputSchema: jsonSchema({ type: "object" }),
                exposure: ["model"] as const,
                handlerRef: "h.x",
              },
            ]
          : [];
      const tree: RenderedTree = {
        specVersion: SPEC_VERSION,
        context: { entries: [] },
        ...(tools.length > 0 ? { declarations: { tools } } : {}),
      };
      return { tree, diagnostics: [], iterations: 1 };
    };
    const compiler: CompilerProtocol = {
      fx: { use: () => () => {}, renderTree: () => Effect.succeed(renderResult()) },
      mount: async () => ({ mountId: "m_5", restoredFromSnapshot: false }),
      rerender: async () => undefined,
      renderTree: async () => renderResult(),
      renderToString: async () => ({
        payload: { text: "", mimeType: "text/plain" },
        diagnostics: [],
        iterations: 1,
      }),
      unmount: async () => undefined,
      snapshot: async () => ({
        specVersion: SPEC_VERSION,
        mountId: "m_5",
        dataCache: [],
        bridges: {},
        subscriptions: [],
      }),
      restore: async () => undefined,
    };
    const { executor, captured } = mkRecordingExecutor();

    // Tick 1.
    await loop.runExecution({
      sessionId: "s_5",
      mountId: "m_5",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec_5_1",
      maxTicks: 1,
    });
    expect(captured.runs[0]!.map((t) => t.name)).toEqual(["x"]);

    // Tick 2 — same mountId, compiler now emits nothing.
    stage = 1;
    await loop.runExecution({
      sessionId: "s_5",
      mountId: "m_5",
      compiler,
      modelExecutor: executor,
      toolExecutor,
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec_5_2",
      maxTicks: 1,
    });
    expect(captured.runs[1]!).toEqual([]);
  });
});
