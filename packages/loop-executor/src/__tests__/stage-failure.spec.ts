/**
 * A project or normalize failure is a FAILED TICK, not a rejected run.
 *
 * Before this, both threw past the streaming path's `Effect.either` and exited
 * through the run's `catchAll` as an `ExecutionError`: the boundary recorded
 * `failed` with no cause, and the ADR 99 decide fold never saw the tick.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  CompilerProtocol,
  DispatchResult,
  LanguageModelExecutionResult,
  RenderedTree,
  RunExecutionInput,
  StateApplicator,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { NormalizationFailed, ProjectionFailed, SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";

import { LoopExecutorHarness } from "../harness.js";

type ModelExecutor = FakeLanguageModelExecutor;

const EMPTY_TREE: RenderedTree = { specVersion: SPEC_VERSION, context: { entries: [] } };

const compiler: CompilerProtocol = {
  fx: {
    use: () => () => {},
    guard: () => () => {},
    renderTree: () => Effect.succeed({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
  },
  mount: async () => ({ mountId: "sf-mount" }),
  rerender: async () => undefined,
  renderTree: async () => ({ tree: EMPTY_TREE, diagnostics: [], iterations: 1 }),
  renderToString: async () => ({
    payload: { text: "", mimeType: "text/plain" },
    diagnostics: [],
    iterations: 1,
  }),
  unmount: async () => undefined,
};

const applicator: StateApplicator = {
  fx: { applyExecutorResult: () => Effect.void, applyToolResults: () => Effect.void },
  applyExecutorResult: async () => undefined,
  applyToolResults: async () => undefined,
  appendEntry: async () => undefined,
};

const toolExecutor = {
  fx: {
    use: () => () => {},
    guard: () => () => {},
    replaceCompilerTools: () => Effect.void,
    compileForTick: () => Effect.succeed([]),
    dispatch: (i: { name: string; toolCallId: string }): Effect.Effect<DispatchResult> =>
      Effect.succeed({ toolCallId: i.toolCallId, name: i.name, content: [], durationMs: 1 }),
  },
  replaceCompilerTools: async () => undefined,
  compileForTick: async () => [],
  tools: { list: () => [] },
} as unknown as ToolExecutorProtocol;

const answered: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

/** The fake executor with ONE `fx` phase replaced by a failing twin. */
function executorFailingAt(
  phase: "project" | "normalize",
  error: ProjectionFailed | NormalizationFailed,
): Promise<ModelExecutor> {
  const real = new FakeLanguageModelExecutor(
    `sf-exec-${phase}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: { result: answered } },
  );
  return real.ready.then(() => {
    const broken = Object.create(real) as ModelExecutor;
    Object.defineProperty(broken, "fx", {
      value: { ...real.fx, [phase]: () => Effect.fail(error) },
    });
    return broken;
  });
}

async function runWith(executor: ModelExecutor) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const loop = new LoopExecutorHarness("sf-loop", journal, bus, inbox);
  await loop.ready;
  const input: RunExecutionInput = {
    sessionId: "sf-s",
    mountId: "sf-mount",
    compiler,
    modelExecutor: executor,
    toolExecutor,
    target: executor.target,
    stateApplicator: applicator,
    executionId: "sf-exec",
    maxTicks: 3,
    stream: true,
  };
  return loop.runExecution(input);
}

describe("a stage failure is a failed tick with its cause on the terminal", () => {
  it("project", async () => {
    const terminal = await runWith(
      await executorFailingAt(
        "project",
        new ProjectionFailed({ reason: "projection threw: Error: bad tool schema" }),
      ),
    );
    expect(terminal.outcome).toBe("succeeded");
    expect(terminal.result!.stopReason).toBe("executor_failed");
    const cause = terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error._tag).toBe("ProjectionFailed");
    expect(cause.error.message).toContain("bad tool schema");
  });

  it("normalize", async () => {
    const terminal = await runWith(
      await executorFailingAt(
        "normalize",
        new NormalizationFailed({ cause: new Error("unexpected response shape") }),
      ),
    );
    expect(terminal.result!.stopReason).toBe("executor_failed");
    const cause = terminal.result!.stopCause;
    if (cause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(cause.error._tag).toBe("NormalizationFailed");
    expect(cause.error.message).toContain("unexpected response shape");
  });
});
