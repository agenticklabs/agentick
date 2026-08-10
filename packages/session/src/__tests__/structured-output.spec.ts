/**
 * Structured execution results — the terminal-tool strategy (§B2) + the B3
 * completion pass (capability-aware strategy auto, loop-side validation
 * authority, tree-tier `data`).
 *
 * A structured result is a synthetic TERMINAL TOOL whose `inputSchema` IS the
 * output schema; the model calls it to deliver the final answer and the call
 * is the completion event. Mechanism-tier, all scripted through the canonical
 * {@link FakeLanguageModelExecutor} (deterministic — no model behavior
 * asserted; compliance is the eval tier). Every session is built with
 * `defaultStreaming: false` so the loop takes the non-streaming `fx.run` path,
 * whose inputs the fake records on `seenRuns` (the model-facing `tools` list +
 * the `compiled` tree carrying `config.responseFormat` / `config.toolChoice`).
 *
 * Covers:
 *   - injection (tool strategy → terminal LAST; bare → responseFormat overlay)
 *   - capability-aware auto (§B3 fix #1: no native json_schema → terminal tool;
 *     the text-only double-gap → responseFormat fallback)
 *   - detection + stop + validated `SendResult.data`
 *   - sibling-calls-first (real tools dispatch, terminal captured last)
 *   - timeline pairing (a second send on the same session succeeds)
 *   - steer-proof stop (a captured terminal ends the turn despite a steer)
 *   - the forced wrap-up tick (`toolChoice: { tool }`) + `ticks + 1`
 *   - loop-side validation authority (§B3 fix #3): tool + responseFormat
 *     strategies, send-tier AND tree-only `<Output>` → typed `data`
 *   - the typed miss / validation / collision / precedence errors
 *
 * @see docs/proposals/v2/three-audiences-plan.md §B2 + §B3
 */

import { describe, expect, it } from "vitest";
import * as React from "react";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  RenderedTree,
  StandardSchemaV1,
  ToolChoice,
  ToolDeclaration,
} from "@agentick/spec";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

/** OpenAI-like: native tools AND native json_schema (structured decoding). */
const openaiTarget: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true, supportsJsonSchema: true },
};

/** Anthropic-like: native tools, NO native json_schema (adapter drops it). */
const noJsonSchemaTarget: ExecutionTarget = {
  kind: "language-model",
  provider: "mock-anthropic",
  modelId: "mock-claude",
  capabilities: { supportsTools: true, supportsStreaming: true, supportsJsonSchema: false },
};

/** Text-only: NEITHER native tools NOR json_schema — the double-gap. */
const textOnlyTarget: ExecutionTarget = {
  kind: "language-model",
  provider: "mock-text",
  modelId: "mock-text",
  capabilities: { supportsTools: false, supportsStreaming: false, supportsJsonSchema: false },
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

interface Built {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  readonly resolver: InMemoryHandlerResolver;
  readonly executor: FakeLanguageModelExecutor;
  dispose(): Promise<void>;
}

/**
 * Build a session driven by the canonical {@link FakeLanguageModelExecutor}.
 * `defaultStreaming: false` forces the non-streaming `fx.run` path so the
 * fake's `seenRuns` ledger records each tick's projection input. The SAME
 * `target` is threaded to the fake AND the SessionHarness (the loop reads the
 * session-threaded one for strategy resolution — they must agree). A
 * `holdUntil` gate blocks the FIRST scripted run (for steer-race tests).
 */
async function mkSession(opts: {
  readonly scripts: readonly LanguageModelExecutionResult[];
  readonly agent?: React.ReactElement | null;
  readonly target?: ExecutionTarget;
  readonly holdUntil?: Promise<void>;
}): Promise<Built> {
  const target = opts.target ?? openaiTarget;
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
  const executor = new FakeLanguageModelExecutor("so-exec", journal, bus, inbox, {
    target,
    scripted: opts.scripts.map((result, i) => ({
      result,
      ...(i === 0 && opts.holdUntil !== undefined ? { holdUntil: opts.holdUntil } : {}),
    })),
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: opts.agent ?? null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    // Force the non-streaming `fx.run` path so `seenRuns` records inputs AND
    // the scripted `holdUntil` (a `runBody` knob) gates the run.
    defaultStreaming: false,
  });
  await session.ready;
  await session.mountReady;
  return {
    session,
    tools,
    resolver,
    executor,
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

const toolNames = (tools: readonly ToolDeclaration[] | undefined): string[] =>
  (tools ?? []).map((t) => t.name);

const seenToolChoice = (tree: RenderedTree): ToolChoice | undefined => tree.config?.toolChoice;

const seenResponseFormatName = (tree: RenderedTree): string | undefined => {
  const format = tree.config?.responseFormat;
  return format?.type === "json_schema" ? format.name : undefined;
};

describe("structured output — injection", () => {
  it("tool strategy: the terminal tool is appended LAST to the model-facing tools", async () => {
    const { session, resolver, executor, dispose } = await mkSession({
      scripts: [terminalCallResult({ answer: "hi" })],
    });
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        tools: [realTool],
        output: answerSchema,
      })
    ).result;

    const names = toolNames(executor.seenRuns[0]!.tools);
    expect(names).toContain("echo");
    expect(names).toContain("submit_result");
    // Terminal is LAST (after the cache-stable prefix).
    expect(names[names.length - 1]).toBe("submit_result");
    // Narration off: `_summary` would be projected into the terminal tool's
    // arguments, and those arguments ARE the answer.
    expect(executor.seenRuns[0]!.tools.at(-1)!.annotations?.narrate).toBe(false);
    await dispose();
  });

  it("responseFormat strategy: a bare send injects the responseFormat overlay, no terminal tool", async () => {
    const { session, executor, dispose } = await mkSession({
      scripts: [textResult('{"answer":"bare"}')],
    });

    const r = await (
      await session.send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
    ).result;

    expect(toolNames(executor.seenRuns[0]!.tools)).not.toContain("submit_result");
    expect(seenResponseFormatName(executor.seenRuns[0]!.compiled)).toBeDefined();
    // Final text is parsed + validated into `data` (loop-side).
    expect(r.data).toEqual({ answer: "bare" });
    // The responseFormat strategy keeps the provider stop reason (no terminal
    // tool involved) — NOT "output_delivered".
    expect(r.stopReason).toBe("end");
    await dispose();
  });
});

describe("structured output — capability-aware strategy auto (§B3 fix #1)", () => {
  it("no native json_schema: a bare send auto-resolves to the terminal tool", async () => {
    // Anthropic-like target (drops responseFormat). Pre-B3 this resolved to
    // responseFormat and reliably failed; now auto → tool strategy.
    const { session, executor, dispose } = await mkSession({
      target: noJsonSchemaTarget,
      scripts: [terminalCallResult({ answer: "viatool" })],
    });

    const r = await (
      await session.send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
    ).result;

    // The terminal tool was injected (even with zero real tools mounted).
    expect(toolNames(executor.seenRuns[0]!.tools)).toContain("submit_result");
    expect(r.data).toEqual({ answer: "viatool" });
    expect(r.stopReason).toBe("output_delivered");
    await dispose();
  });

  it("double-gap (no json_schema AND no tools): a bare send keeps responseFormat", async () => {
    // A text-only target cannot honor a tool strategy, so the fallback keeps
    // responseFormat (validation still catches non-adherence downstream).
    const { session, executor, dispose } = await mkSession({
      target: textOnlyTarget,
      scripts: [textResult('{"answer":"text"}')],
    });

    const r = await (
      await session.send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
    ).result;

    expect(toolNames(executor.seenRuns[0]!.tools)).not.toContain("submit_result");
    expect(seenResponseFormatName(executor.seenRuns[0]!.compiled)).toBeDefined();
    expect(r.data).toEqual({ answer: "text" });
    expect(r.stopReason).toBe("end");
    await dispose();
  });
});

describe("structured output — detection, stop, capture", () => {
  it("a scripted terminal call stops the execution and yields typed, validated data", async () => {
    const { session, resolver, dispose } = await mkSession({
      scripts: [terminalCallResult({ answer: "done" })],
    });
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
    const { session, resolver, dispose } = await mkSession({ scripts: [withText] });
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
    const { session, resolver, dispose } = await mkSession({ scripts: [mixed] });
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
    const { session, resolver, dispose } = await mkSession({
      scripts: [terminalCallResult({ answer: "first" }), textResult("second")],
    });
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

describe("structured output — tree-level <Output> (§B3 fix #3)", () => {
  it("tree-only <Output> produces validated data + output_delivered (no send-level output)", async () => {
    // The dedicated-extraction-agent story: the tree declares the shape, no
    // send-level `output`. No native json_schema → auto tool strategy; the
    // terminal name is the tree output's name. Before B3 this delivered but
    // `data` never materialized.
    const Agent = () => React.createElement("output", { name: "extracted", schema: answerSchema });
    const { session, dispose } = await mkSession({
      target: noJsonSchemaTarget,
      agent: React.createElement(Agent),
      scripts: [terminalCallResult({ answer: "tree" }, "extracted")],
    });

    const r = await (
      await session.send({ messages: [{ role: "user", content: "extract" }] })
    ).result;

    expect(r.data).toEqual({ answer: "tree" });
    expect(r.stopReason).toBe("output_delivered");
    await dispose();
  });

  it("tree-only <Output> validation failure → ResponseValidationError (loop-side authority)", async () => {
    const Agent = () => React.createElement("output", { name: "extracted", schema: answerSchema });
    const { session, dispose } = await mkSession({
      target: noJsonSchemaTarget,
      agent: React.createElement(Agent),
      scripts: [terminalCallResult({ answer: 42 }, "extracted")], // wrong shape
    });

    const err = await session
      .send({ messages: [{ role: "user", content: "extract" }] })
      .then((h) => h.result)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const e = err as { _tag?: string; raw?: unknown };
    expect(e._tag).toBe("ResponseValidationError");
    expect(e.raw).toEqual({ answer: 42 });
    await dispose();
  });
});

describe("structured output — wrap-up + steer-proof stop", () => {
  it("forced wrap-up tick: a natural stop without the terminal reruns with toolChoice { tool }", async () => {
    const { session, resolver, executor, dispose } = await mkSession({
      scripts: [
        textResult("here is my prose answer"), // tick 1 — no terminal call
        terminalCallResult({ answer: "forced" }), // wrap-up tick — forced call
      ],
    });
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
    expect(seenToolChoice(executor.seenRuns[1]!.compiled)).toEqual({ tool: "submit_result" });
    // Tick 1 did NOT force it.
    expect(seenToolChoice(executor.seenRuns[0]!.compiled)).toBeUndefined();
    await dispose();
  });

  it("steer-proof stop: a captured terminal ends the turn even with a queued steer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, resolver, dispose } = await mkSession({
      scripts: [terminalCallResult({ answer: "delivered" }), textResult("follow-up turn")],
      holdUntil: gate,
    });
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
    const { session, resolver, dispose } = await mkSession({
      scripts: [textResult("never calls the tool")],
    });
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
    const { session, resolver, dispose } = await mkSession({
      scripts: [terminalCallResult({ answer: 42 })],
    });
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

  it("responseFormat strategy validation failure: non-JSON final text → ResponseValidationError", async () => {
    // A bare send with `output` on an OpenAI-like target uses responseFormat;
    // the loop validates the final text and fails loud on non-JSON (same
    // observable rejection surface as before — on handle.result).
    const { session, dispose } = await mkSession({
      scripts: [textResult("I refuse to emit JSON")],
    });

    const err = await session
      .send({ messages: [{ role: "user", content: "hi" }], output: answerSchema })
      .then((h) => h.result)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { _tag?: string })._tag).toBe("ResponseValidationError");
    await dispose();
  });

  it("collision: a tree tool named submit_result + an output spec → TerminalToolNameCollision", async () => {
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
    const { session, resolver, dispose } = await mkSession({
      agent: React.createElement(Agent),
      scripts: [textResult("noop")],
    });
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

describe("structured output — precedence + onBusy", () => {
  it("send-level output overrides a tree-level <Output> (send wins)", async () => {
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
    const { session, resolver, executor, dispose } = await mkSession({
      agent: React.createElement(Agent),
      scripts: [terminalCallResult({ answer: "sent" }, "submit_result")],
    });
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        output: answerSchema, // send-level: default name submit_result
      })
    ).result;

    // The send-level terminal name (submit_result) is what got injected, not the
    // tree's `from_tree`.
    expect(toolNames(executor.seenRuns[0]!.tools)).toContain("submit_result");
    expect(toolNames(executor.seenRuns[0]!.tools)).not.toContain("from_tree");
    expect(r.data).toEqual({ answer: "sent" });
    await dispose();
  });

  it("an EXPLICIT onBusy:steer carrying output while racing is rejected with SteerCannotCarryStructuredOutput", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, dispose } = await mkSession({
      scripts: [textResult("first"), textResult("second")],
      holdUntil: gate,
    });

    const h1 = await session.send({ messages: [{ role: "user", content: "ask" }] });
    // Only an EXPLICIT `onBusy: "steer"` reaches the join-point guard; an
    // implicit structured send would queue instead (covered below).
    const err = await session
      .send({
        messages: [{ role: "user", content: "steer" }],
        output: answerSchema,
        onBusy: "steer",
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { _tag?: string })._tag).toBe("SteerCannotCarryStructuredOutput");
    release();
    await h1.result;
    await dispose();
  });

  it("an EXPLICIT onBusy:steer carrying output on an IDLE session runs fresh (guard is join-point-only)", async () => {
    const { session, resolver, executor, dispose } = await mkSession({
      agent: React.createElement(() =>
        React.createElement("tool", {
          id: "t.echo",
          name: "echo",
          description: "echo",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.echo",
        }),
      ),
      scripts: [terminalCallResult({ answer: "idle-steer" }, "submit_result")],
    });
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);

    // Explicit steer + output, but NO in-flight execution: the steer degrades
    // to a fresh send, where structured output is legal — no throw, data lands.
    const r = await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        output: answerSchema,
        onBusy: "steer",
      })
    ).result;

    expect(toolNames(executor.seenRuns[0]!.tools)).toContain("submit_result");
    expect(r.data).toEqual({ answer: "idle-steer" });
    await dispose();
  });
});
