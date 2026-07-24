/**
 * Structured execution results — the terminal-tool strategy (§B2).
 *
 * A structured result is a synthetic TERMINAL TOOL whose `inputSchema` IS the
 * output schema; the model calls it to deliver the final answer and the call
 * is the completion event. Mechanism-tier, all scripted through a recording
 * executor (deterministic — no model behavior asserted; compliance is the
 * eval tier). Covers:
 *
 *   - injection (tool strategy → terminal LAST; bare → responseFormat overlay)
 *   - detection + stop + validated `SendResult.data`
 *   - sibling-calls-first (real tools dispatch, terminal captured last)
 *   - timeline pairing (a second send on the same session succeeds)
 *   - steer-proof stop (a captured terminal ends the turn despite a steer)
 *   - the forced wrap-up tick (`toolChoice: { tool }`) + `ticks + 1`
 *   - the typed miss / validation / collision / precedence errors
 *
 * @see docs/proposals/v2/three-audiences-plan.md §B2
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as React from "react";

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
  RunInput,
  StandardSchemaV1,
  ToolChoice,
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

/** `{ answer: string }` — a schema that actually validates (custom validator). */
const answerSchema: StandardSchemaV1<unknown, { answer: string }> = jsonSchema<{ answer: string }>(
  { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  {
    validator: (v) =>
      typeof (v as { answer?: unknown })?.answer === "string"
        ? { value: v as { answer: string } }
        : { issues: [{ message: "answer must be a string" }] },
  },
);

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/** Scripted terminal-tool call — a `tool_use` block + the matching toolCall. */
const terminalCallResult = (
  input: Record<string, unknown>,
  name = "submit_result",
  id = "tc-term",
): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "tool_use", toolUseId: id, name, input }],
  stopReason: "tool_use",
  usage,
  toolCalls: [{ id, name, input }],
});

const textResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage,
});

/**
 * A recording executor that captures the `compiled` tree AND the model-facing
 * `tools` of every `run()`. OMITS a top-level `executeStream` so the loop takes
 * the non-streaming `run` path (the path whose inputs we observe).
 */
function mkRecordingExecutor(scripts: readonly LanguageModelExecutionResult[]): {
  readonly executor: LanguageModelExecutor;
  readonly captured: {
    readonly compiled: RenderedTree[];
    readonly tools: (readonly ToolDeclaration[])[];
  };
} {
  const captured = { compiled: [] as RenderedTree[], tools: [] as (readonly ToolDeclaration[])[] };
  let i = 0;
  const nextResult = (): LanguageModelExecutionResult =>
    scripts[Math.min(i++, scripts.length - 1)]!;
  const runFx = (input: RunInput): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.sync(() => {
      captured.compiled.push(input.compiled);
      captured.tools.push(input.tools ?? []);
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
  const compiler = new CompilerHarness("so-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("so-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("so-t:elic", journal, bus, inbox);
  const tools = new ToolExecutorHarness("so-t", journal, bus, inbox, {
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

const realTool: ToolDeclaration = {
  id: "t.echo",
  name: "echo",
  description: "echo",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.echo",
};

function seenToolNames(tools: readonly ToolDeclaration[]): string[] {
  return tools.map((t) => t.name);
}

function seenToolChoice(tree: RenderedTree): ToolChoice | undefined {
  return tree.config?.toolChoice;
}

describe("structured output — injection", () => {
  it("tool strategy: the terminal tool is appended LAST to the model-facing tools", async () => {
    const { executor, captured } = mkRecordingExecutor([terminalCallResult({ answer: "hi" })]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
      })
    ).result;

    const names = seenToolNames(captured.tools[0]!);
    expect(names).toContain("echo");
    expect(names).toContain("submit_result");
    // Terminal is LAST (after the cache-stable prefix).
    expect(names[names.length - 1]).toBe("submit_result");
    await dispose();
  });

  it("responseFormat strategy: a bare send injects the responseFormat overlay, no terminal tool", async () => {
    const { executor, captured } = mkRecordingExecutor([textResult('{"answer":"bare"}')]);
    const { session, dispose } = await mkSession(executor);

    const r = await (
      await session.send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
    ).result;

    expect(seenToolNames(captured.tools[0]!)).not.toContain("submit_result");
    const rf = captured.compiled[0]!.config?.responseFormat;
    expect(rf?.type).toBe("json_schema");
    // Final text is parsed + validated into `data`.
    expect(r.data).toEqual({ answer: "bare" });
    // The responseFormat strategy keeps the provider stop reason (no terminal
    // tool involved) — NOT "output_delivered".
    expect(r.stopReason).toBe("end");
    await dispose();
  });
});

describe("structured output — detection, stop, capture", () => {
  it("a scripted terminal call stops the execution and yields typed, validated data", async () => {
    const { executor } = mkRecordingExecutor([terminalCallResult({ answer: "done" })]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
        maxTicks: 5,
      })
    ).result;

    expect(r.ticks).toBe(1);
    expect(r.data).toEqual({ answer: "done" });
    // The loop stopped on the delivery, not on a pending tool call.
    expect(r.stopReason).toBe("output_delivered");
    await dispose();
  });

  it("same-tick closing text: prose rides in `response`, the validated answer in `data`, one tick", async () => {
    // Providers may emit text alongside a tool call in one assistant turn. The
    // terminal call delivers `data`; the sibling text lands in `response` — a
    // human summary AND a typed result, zero extra ticks.
    const withText: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [
        { type: "text", text: "Here is a short summary for you." },
        { type: "tool_use", toolUseId: "tc-term", name: "submit_result", input: { answer: "hi" } },
      ],
      stopReason: "tool_use",
      usage,
      toolCalls: [{ id: "tc-term", name: "submit_result", input: { answer: "hi" } }],
    };
    const { executor } = mkRecordingExecutor([withText]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
        maxTicks: 5,
      })
    ).result;

    expect(r.response).toBe("Here is a short summary for you.");
    expect(r.data).toEqual({ answer: "hi" });
    expect(r.stopReason).toBe("output_delivered");
    expect(r.ticks).toBe(1);
    await dispose();
  });

  it("sibling-calls-first: real tools dispatch, the terminal is captured last, both results pair", async () => {
    let echoCalls = 0;
    const mixed: LanguageModelExecutionResult = {
      specVersion: SPEC_VERSION,
      output: [
        { type: "tool_use", toolUseId: "c-echo", name: "echo", input: { x: 1 } },
        { type: "tool_use", toolUseId: "c-term", name: "submit_result", input: { answer: "z" } },
      ],
      stopReason: "tool_use",
      usage,
      toolCalls: [
        { id: "c-echo", name: "echo", input: { x: 1 } },
        { id: "c-term", name: "submit_result", input: { answer: "z" } },
      ],
    };
    const { executor } = mkRecordingExecutor([mixed]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => {
      echoCalls += 1;
      return [{ type: "text", text: "echoed" }];
    });

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
        maxTicks: 5,
      })
    ).result;

    expect(echoCalls).toBe(1); // real tool dispatched
    expect(r.ticks).toBe(1); // terminal capture stops the turn
    expect(r.data).toEqual({ answer: "z" });
    // The synthesized terminal result pairs the terminal tool_use alongside the
    // real tool_result.
    const resultNames = r.toolResults.map((t) => t.toolName).sort();
    expect(resultNames).toEqual(["echo", "submit_result"]);
    await dispose();
  });

  it("timeline pairing: a second send on the same session succeeds (no dangling tool_use)", async () => {
    const { executor } = mkRecordingExecutor([
      terminalCallResult({ answer: "first" }),
      textResult("second"),
    ]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r1 = await (
      await session.send({
        messages: [{ role: "user", content: "one" }],
        tools: [realTool],
        output: answerSchema,
      })
    ).result;
    expect(r1.data).toEqual({ answer: "first" });

    // Second send: the terminal tool_use from turn 1 is paired in the timeline,
    // so a fresh turn assembles + runs without error.
    const r2 = await (await session.send({ messages: [{ role: "user", content: "two" }] })).result;
    expect(r2.response).toBe("second");
    await dispose();
  });
});

describe("structured output — wrap-up + steer-proof stop", () => {
  it("forced wrap-up tick: a natural stop without the terminal reruns with toolChoice { tool }", async () => {
    const { executor, captured } = mkRecordingExecutor([
      textResult("here is my prose answer"), // tick 1 — no terminal call
      terminalCallResult({ answer: "forced" }), // wrap-up tick — forced call
    ]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
        maxTicks: 5,
      })
    ).result;

    expect(r.ticks).toBe(2); // exactly ticks + 1
    expect(r.data).toEqual({ answer: "forced" });
    expect(r.stopReason).toBe("output_delivered"); // forced path reports delivery too
    // The wrap-up tick forced the terminal tool.
    expect(seenToolChoice(captured.compiled[1]!)).toEqual({ tool: "submit_result" });
    // Tick 1 did NOT force it.
    expect(seenToolChoice(captured.compiled[0]!)).toBeUndefined();
    await dispose();
  });

  it("steer-proof stop: a captured terminal ends the turn even with a queued steer", async () => {
    const { executor, release } = gatedExecutor([
      terminalCallResult({ answer: "delivered" }),
      textResult("follow-up turn"),
    ]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const h1 = await session.send({
      messages: [{ role: "user", content: "ask" }],
      tools: [realTool],
      output: answerSchema,
      maxTicks: 5,
    });
    // A steer lands mid-execution (default delivery joins the in-flight turn).
    await session.send({ messages: [{ role: "user", content: "keep going" }] });
    release();

    const r1 = await h1.result;
    // The terminal capture stopped THIS execution at tick 1 — the steer did not
    // reopen it (it re-dispatches as a fresh follow-up per existing semantics).
    expect(r1.ticks).toBe(1);
    expect(r1.data).toEqual({ answer: "delivered" });
    await dispose();
  });
});

describe("structured output — typed failures", () => {
  it("miss at maxTicks: no terminal call and no room to wrap up → StructuredOutputIncomplete", async () => {
    const { executor } = mkRecordingExecutor([textResult("never calls the tool")]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const err = await session
      .send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
        maxTicks: 1,
      })
      .then((h) => h.result)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { _tag?: string })._tag).toBe("StructuredOutputIncomplete");
    await dispose();
  });

  it("validation failure: a nonconforming terminal input → ResponseValidationError (issues + raw)", async () => {
    const { executor } = mkRecordingExecutor([terminalCallResult({ answer: 42 })]);
    const { session, resolver, dispose } = await mkSession(executor);
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const err = await session
      .send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
      })
      .then((h) => h.result)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const e = err as { _tag?: string; raw?: unknown; issues?: readonly { message: string }[] };
    expect(e._tag).toBe("ResponseValidationError");
    expect(e.raw).toEqual({ answer: 42 });
    expect(e.issues?.[0]?.message).toContain("answer");
    await dispose();
  });

  it("collision: a tree tool named submit_result + an output spec → TerminalToolNameCollision", async () => {
    const { executor } = mkRecordingExecutor([textResult("noop")]);
    // The agent tree renders a <tool name="submit_result">.
    const Agent = () =>
      React.createElement("tool", {
        id: "t.clash",
        name: "submit_result",
        description: "a clashing tool",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.clash",
      });
    const { session, resolver, dispose } = await mkSession(executor, React.createElement(Agent));
    resolver.register("h.clash", async () => [{ type: "text", text: "ok" }]);

    const err = await session
      .send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
      .then((h) => h.result)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { _tag?: string })._tag).toBe("TerminalToolNameCollision");
    await dispose();
  });
});

describe("structured output — precedence + delivery", () => {
  it("send-level output overrides a tree-level <Output> (send wins)", async () => {
    const { executor, captured } = mkRecordingExecutor([
      terminalCallResult({ answer: "sent" }, "submit_result"),
    ]);
    // Tree declares an <Output> with a DIFFERENT terminal name.
    const Agent = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement("tool", {
          id: "t.echo",
          name: "echo",
          description: "echo",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.echo",
        }),
        React.createElement("output", { name: "from_tree", schema: answerSchema }),
      );
    const { session, resolver, dispose } = await mkSession(executor, React.createElement(Agent));
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        output: answerSchema, // send-level: default name submit_result
      })
    ).result;

    // The send-level terminal name (submit_result) is what got injected, not the
    // tree's `from_tree`.
    expect(seenToolNames(captured.tools[0]!)).toContain("submit_result");
    expect(seenToolNames(captured.tools[0]!)).not.toContain("from_tree");
    expect(r.data).toEqual({ answer: "sent" });
    await dispose();
  });

  it("a steer carrying output is rejected with SteerCannotCarryStructuredOutput", async () => {
    const { executor, release } = gatedExecutor([textResult("first"), textResult("second")]);
    const { session, dispose } = await mkSession(executor);

    const h1 = await session.send({ messages: [{ role: "user", content: "ask" }] });
    const err = await session
      .send({ messages: [{ role: "user", content: "steer" }], output: answerSchema })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { _tag?: string })._tag).toBe("SteerCannotCarryStructuredOutput");
    release();
    await h1.result;
    await dispose();
  });
});

/**
 * A recording-free gated executor: the FIRST `run()` is held on a gate so a
 * concurrent send lands mid-execution. Consumes scripts in order.
 */
function gatedExecutor(scripts: readonly LanguageModelExecutionResult[]): {
  readonly executor: LanguageModelExecutor;
  release: () => void;
} {
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => {
    releaseFn = r;
  });
  let i = 0;
  let calls = 0;
  const nextResult = (): LanguageModelExecutionResult =>
    scripts[Math.min(i++, scripts.length - 1)]!;
  const runFx = (): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.gen(function* () {
      calls += 1;
      if (calls === 1) yield* Effect.promise(() => gate);
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
    run(): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
      return Effect.runPromise(runFx());
    },
    async abort(): Promise<void> {},
  } as unknown as LanguageModelExecutor;
  return { executor, release: () => releaseFn() };
}
