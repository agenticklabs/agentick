/**
 * trail-response-format-send — the per-tick config overlay in the loop.
 *
 * `RunExecutionInput.responseFormat` (the send-level structured directive)
 * overlays each tick's compiled `config.responseFormat`, spread LAST so it
 * wins over BOTH the tree-level `<config responseFormat>` AND a per-tick
 * `<Model>`-declared `parameters.responseFormat` (explicit send-level beats
 * ambient tree/model). Absent, today's precedence (model-decl over tree) is
 * untouched.
 *
 * Observes via `FakeLanguageModelExecutor.seenRuns` — the canonical ledger,
 * recorded at the `project` command so it fills on the streaming path the loop
 * actually takes. A bespoke recording executor here used to capture from `run()`
 * only, which meant this suite silently asserted against a non-streaming path.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import type {
  CompilerProtocol,
  RenderedTree,
  ResponseFormat,
  StateApplicator,
  ModelDeclaration,
  SpecConfig,
  ToolExecutorProtocol,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { LoopExecutorHarness } from "../harness.js";

function mkSubstrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

function mkCompiler(config?: SpecConfig, model?: ModelDeclaration): CompilerProtocol {
  const mkTree = (): RenderedTree => ({
    specVersion: SPEC_VERSION,
    context: { entries: [] },
    ...(config !== undefined ? { config } : {}),
    ...(model !== undefined ? { declarations: { model } } : {}),
  });
  const render = () => ({ tree: mkTree(), diagnostics: [], iterations: 1 });
  return {
    fx: { use: () => () => {}, renderTree: () => Effect.succeed(render()) },
    mount: async () => ({ mountId: "rf-mount", restoredFromSnapshot: false }),
    rerender: async () => undefined,
    renderTree: async () => render(),
    renderToString: async () => ({
      payload: { text: "", mimeType: "text/plain" },
      diagnostics: [],
      iterations: 1,
    }),
    unmount: async () => undefined,
    snapshot: async () => ({
      specVersion: SPEC_VERSION,
      mountId: "rf-mount",
      dataCache: [],
      bridges: {},
      subscriptions: [],
    }),
    restore: async () => undefined,
  };
}

function noopApplicator(): StateApplicator {
  return {
    fx: { applyExecutorResult: () => Effect.void, applyToolResults: () => Effect.void },
    applyExecutorResult: async () => undefined,
    applyToolResults: async () => undefined,
    appendEntry: async () => undefined,
  };
}

const rf = (name: string): ResponseFormat => ({
  type: "json_schema",
  name,
  schema: { title: name },
});

/** The compiled trees this executor projected, in tick order. */
const seen = (executor: FakeLanguageModelExecutor): RenderedTree[] =>
  executor.seenRuns.map((r) => r.compiled);

function seenName(tree: RenderedTree): string | undefined {
  const format = tree.config?.responseFormat;
  return format?.type === "json_schema" ? format.name : undefined;
}

describe("LoopExecutorHarness — responseFormat overlay (trail-response-format-send)", () => {
  it("send-level responseFormat wins over BOTH tree config and model-decl parameters", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("rf_1", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const compiler = mkCompiler(
      { responseFormat: rf("from-tree") },
      { modelRef: "m", parameters: { responseFormat: rf("from-model") } },
    );
    const executor = new FakeLanguageModelExecutor("rf_exec", sub.journal, sub.bus, sub.inbox);

    await loop.runExecution({
      sessionId: "s_1",
      mountId: "rf-mount",
      compiler,
      modelExecutor: executor,
      toolExecutor: mkFakeToolExecutor(),
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec_1",
      maxTicks: 1,
      responseFormat: rf("from-send"),
    });

    expect(seen(executor)).toHaveLength(1);
    expect(seenName(seen(executor)[0]!)).toBe("from-send");
  });

  it("without a send-level responseFormat, model-decl parameters win over tree config (unchanged)", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("rf_2", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const compiler = mkCompiler(
      { responseFormat: rf("from-tree") },
      { modelRef: "m", parameters: { responseFormat: rf("from-model") } },
    );
    const executor = new FakeLanguageModelExecutor("rf_exec", sub.journal, sub.bus, sub.inbox);

    await loop.runExecution({
      sessionId: "s_2",
      mountId: "rf-mount",
      compiler,
      modelExecutor: executor,
      toolExecutor: mkFakeToolExecutor(),
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec_2",
      maxTicks: 1,
    });

    expect(seenName(seen(executor)[0]!)).toBe("from-model");
  });

  it("with neither model-decl nor send-level, the tree config responseFormat is preserved", async () => {
    const sub = mkSubstrate();
    const loop = new LoopExecutorHarness("rf_3", sub.journal, sub.bus, sub.inbox);
    await loop.ready;

    const compiler = mkCompiler({ responseFormat: rf("from-tree") });
    const executor = new FakeLanguageModelExecutor("rf_exec", sub.journal, sub.bus, sub.inbox);

    await loop.runExecution({
      sessionId: "s_3",
      mountId: "rf-mount",
      compiler,
      modelExecutor: executor,
      toolExecutor: mkFakeToolExecutor(),
      target: executor.target,
      stateApplicator: noopApplicator(),
      executionId: "exec_3",
      maxTicks: 1,
    });

    expect(seenName(seen(executor)[0]!)).toBe("from-tree");
  });
});

// A tool executor that renders/dispatches nothing — the loop only needs
// `compileForTick` to return an empty model-tool set here.
function mkFakeToolExecutor(): ToolExecutorProtocol {
  return {
    fx: {
      use: () => () => {},
      replaceCompilerTools: () => Effect.void,
      compileForTick: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ toolCallId: "x", name: "x", content: [], durationMs: 0 }),
    },
    replaceCompilerTools: async () => undefined,
    compileForTick: async () => [],
    dispatch: async () => ({ toolCallId: "x", name: "x", content: [], durationMs: 0 }),
  } as unknown as ToolExecutorProtocol;
}
