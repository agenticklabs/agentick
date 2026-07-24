/**
 * Structured final turns at the session tier (trail-response-format-send).
 * Declarative form only: `SendInput.responseFormat` is overlaid onto every
 * tick's compiled config (explicit-beats-ambient over the tree-level
 * `<model responseFormat>` and a per-tick `<Model>` `parameters`), threaded
 * `SendInput → loop → project`.
 *
 * A steer (the default delivery, which joins an in-flight turn) that carries
 * `responseFormat` is rejected with the typed `SteerCannotCarryStructuredOutput`
 * — a delivery conflict, not a validation error — while the same request as
 * `followUp` runs as a fresh execution.
 *
 * The live-schema sugar (`SendInput.output`) + validated `SendResult.data` —
 * the terminal-tool strategy — are covered in `structured-output.spec.ts`
 * (§B2). This file stays scoped to the declarative `responseFormat` directive.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as React from "react";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import type {
  ExecutorFx,
  ExecutorTerminal,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  RenderedTree,
  ResponseFormat,
  RunInput,
  ToolDeclaration,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const rf = (name: string): ResponseFormat => ({
  type: "json_schema",
  name,
  schema: { title: name },
});

/**
 * Hand-rolled executor that records the `compiled` tree of every `run()`.
 * OMITS a top-level `executeStream` method so the loop takes the
 * non-streaming `run` path (the capability default gates streaming on the
 * method's presence) — that is the path whose `compiled` we observe.
 */
function mkRecordingExecutor(scripts: readonly LanguageModelExecutionResult[]): {
  readonly executor: LanguageModelExecutor;
  readonly captured: { compiled: RenderedTree[] };
} {
  const captured = { compiled: [] as RenderedTree[] };
  let i = 0;
  const nextResult = (): LanguageModelExecutionResult =>
    scripts[Math.min(i++, scripts.length - 1)]!;
  const runFx = (input: RunInput): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.sync(() => {
      captured.compiled.push(input.compiled);
      return { outcome: "succeeded", result: nextResult() };
    });
  const fx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    use: () => () => {},
    run: runFx,
    project: () => Effect.succeed({ messages: [] }),
    normalize: () => Effect.succeed(scripts[0]!),
    executeStream: () => Effect.succeed(scripts[0]!),
  };
  const executor = {
    family: "language-model" as const,
    target,
    ready: Promise.resolve(),
    fx,
    async project(): Promise<LanguageModelInput> {
      return { messages: [] };
    },
    async execute(): Promise<unknown> {
      return scripts[0]!;
    },
    async normalize(): Promise<LanguageModelExecutionResult> {
      return scripts[0]!;
    },
    run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
      return Effect.runPromise(runFx(input));
    },
    async abort(): Promise<void> {},
  } as unknown as LanguageModelExecutor;
  return { executor, captured };
}

interface Built {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  readonly resolver: InMemoryHandlerResolver;
  dispose(): Promise<void>;
}

async function mkSession(
  executor: LanguageModelExecutor,
  agent: React.ReactElement | null = null,
): Promise<Built> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("ss-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("ss-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("ss-t:elic", journal, bus, inbox);
  const tools = new ToolExecutorHarness("ss-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  return {
    session,
    tools,
    resolver,
    dispose: async () => {
      await session.close();
      await tools.close();
    },
  };
}

const okResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "ok" }],
  stopReason: "end",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};

function seenName(tree: RenderedTree): string | undefined {
  const format = tree.config?.responseFormat;
  return format?.type === "json_schema" ? format.name : undefined;
}

describe("structured send — responseFormat threading + precedence", () => {
  it("send-level responseFormat is threaded to the executor, overriding tree <model responseFormat>", async () => {
    const { executor, captured } = mkRecordingExecutor([okResult]);
    // Tree declares a config-level responseFormat via <model responseFormat>.
    const Agent = () => React.createElement("model", { responseFormat: rf("from-tree") });
    const { session, dispose } = await mkSession(executor, React.createElement(Agent));

    await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: rf("from-send"),
      })
    ).result;

    expect(captured.compiled).toHaveLength(1);
    expect(seenName(captured.compiled[0]!)).toBe("from-send");
    await dispose();
  });

  it("no send-level responseFormat leaves the tree <model responseFormat> in place", async () => {
    const { executor, captured } = mkRecordingExecutor([okResult]);
    const Agent = () => React.createElement("model", { responseFormat: rf("from-tree") });
    const { session, dispose } = await mkSession(executor, React.createElement(Agent));

    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    expect(seenName(captured.compiled[0]!)).toBe("from-tree");
    await dispose();
  });

  it("multi-tick: responseFormat is applied on EVERY tick", async () => {
    // The tool_use tick emits no text (just the call); the final tick ends.
    const toolUse: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [{ id: "c1", name: "noop", input: {} }],
    };
    const final: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [{ type: "text", text: "done" }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const { executor, captured } = mkRecordingExecutor([toolUse, final]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.noop", async () => [{ type: "text", text: "ok" }]);

    const noopTool: ToolDeclaration = {
      id: "t.noop",
      name: "noop",
      description: "noop",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      handlerRef: "h.noop",
    };

    await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: rf("every-tick"),
        tools: [noopTool],
        maxTicks: 5,
      })
    ).result;

    expect(captured.compiled).toHaveLength(2);
    expect(seenName(captured.compiled[0]!)).toBe("every-tick");
    expect(seenName(captured.compiled[1]!)).toBe("every-tick");
    await dispose();
  });
});

describe("structured send — steer delivery conflict", () => {
  it("a steer carrying responseFormat is rejected; the same request as followUp works", async () => {
    const { exec, release } = gatedExec(["first answer", "second answer"]);
    const { session, dispose } = await mkSession(exec);

    // Start the in-flight (gated) execution.
    const h1 = await session.send({ messages: [{ role: "user", content: "ask" }] });

    // A steer (default delivery) that carries `responseFormat` is rejected loud.
    const steerErr = await session
      .send({ messages: [{ role: "user", content: "steer" }], responseFormat: rf("x") })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((steerErr as { _tag?: string })._tag).toBe("SteerCannotCarryStructuredOutput");

    // The same request as `followUp` is accepted — it queues until the
    // session quiesces, then runs as a fresh execution.
    const h2p = session.send({
      messages: [{ role: "user", content: "followup" }],
      responseFormat: rf("x"),
      delivery: "followUp",
    });

    release();
    await h1.result;
    const r2 = await (await h2p).result;
    expect(r2.response).toBe("second answer");
    await dispose();
  });
});

/**
 * A FakeLanguageModelExecutor whose FIRST generation is held on a gate, so
 * a concurrent send lands mid-execution (pattern from extended-surface).
 */
function gatedExec(replies: readonly string[]): {
  readonly exec: FakeLanguageModelExecutor;
  release: () => void;
} {
  const exec = new FakeLanguageModelExecutor(
    `exec-gate-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: replies.map((text) => ({
        result: {
          specVersion: SPEC_VERSION,
          output: [{ type: "text", text }],
          stopReason: "end" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      })),
    },
  );
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => {
    releaseFn = r;
  });
  let calls = 0;
  const baseFx = exec.fx;
  const patchedFx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    ...baseFx,
    run: (i) => {
      calls += 1;
      const inner = baseFx.run(i);
      return calls === 1
        ? Effect.zipRight(
            Effect.promise(() => gate),
            inner,
          )
        : inner;
    },
    executeStream: (i, sink) => {
      calls += 1;
      const inner = baseFx.executeStream(i, sink);
      return calls === 1
        ? Effect.zipRight(
            Effect.promise(() => gate),
            inner,
          )
        : inner;
    },
  };
  Object.defineProperty(exec, "fx", { configurable: true, get: () => patchedFx });
  return { exec, release: () => releaseFn() };
}
