/**
 * Structured final turns at the session tier (trail-response-format-send).
 * Declarative form only: `SendInput.responseFormat` is overlaid onto every
 * tick's compiled config (explicit-beats-ambient over the tree-level
 * `<model responseFormat>` and a per-tick `<Model>` `parameters`), threaded
 * `SendInput → loop → project`.
 *
 * An EXPLICIT `onBusy: "steer"` that joins an in-flight turn while carrying
 * `responseFormat` is rejected with the typed `SteerCannotCarryStructuredOutput`
 * — a join-point fact, not a validation error. The same request with an unset
 * `onBusy` resolves to `"queue"` under the smart default (a structured send has
 * no steer turn to shape) and runs as a fresh execution — never reaching the
 * guard.
 *
 * The live-schema sugar (`SendInput.output`) + validated `SendResult.data` —
 * the terminal-tool strategy — are covered in `structured-output.spec.ts`
 * (§B2/§B3). This file stays scoped to the declarative `responseFormat`
 * directive. Both suites drive the canonical {@link FakeLanguageModelExecutor}
 * on the non-streaming `fx.run` path (`defaultStreaming: false`), reading the
 * fake's `seenRuns` ledger for the projected `compiled` config; the gated
 * variant rides the fake's scripted `holdUntil` knob — no bespoke executors.
 */

import { describe, expect, it } from "vitest";
import * as React from "react";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  RenderedTree,
  ResponseFormat,
  ToolDeclaration,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true, supportsJsonSchema: true },
};

const rf = (name: string): ResponseFormat => ({
  type: "json_schema",
  name,
  schema: { title: name },
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
 * fake records each tick's projected `compiled` on `seenRuns` and the scripted
 * `holdUntil` gate applies. A `holdUntil` blocks the FIRST run (steer race).
 */
async function mkSession(opts: {
  readonly scripts: readonly LanguageModelExecutionResult[];
  readonly agent?: React.ReactElement | null;
  readonly holdUntil?: Promise<void>;
}): Promise<Built> {
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
  const executor = new FakeLanguageModelExecutor("ss-exec", journal, bus, inbox, {
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

const okResult: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "ok" }],
  stopReason: "end",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};

const textReply = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function seenName(tree: RenderedTree): string | undefined {
  const format = tree.config?.responseFormat;
  return format?.type === "json_schema" ? format.name : undefined;
}

describe("structured send — responseFormat threading + precedence", () => {
  it("send-level responseFormat is threaded to the executor, overriding tree <model responseFormat>", async () => {
    // Tree declares a config-level responseFormat via <model responseFormat>.
    const Agent = () => React.createElement("model", { responseFormat: rf("from-tree") });
    const { session, executor, dispose } = await mkSession({
      scripts: [okResult],
      agent: React.createElement(Agent),
    });

    await (
      await session.send({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: rf("from-send"),
      })
    ).result;

    expect(executor.seenRuns).toHaveLength(1);
    expect(seenName(executor.seenRuns[0]!.compiled)).toBe("from-send");
    await dispose();
  });

  it("no send-level responseFormat leaves the tree <model responseFormat> in place", async () => {
    const Agent = () => React.createElement("model", { responseFormat: rf("from-tree") });
    const { session, executor, dispose } = await mkSession({
      scripts: [okResult],
      agent: React.createElement(Agent),
    });

    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    expect(seenName(executor.seenRuns[0]!.compiled)).toBe("from-tree");
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
    const { session, resolver, executor, dispose } = await mkSession({ scripts: [toolUse, final] });
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

    expect(executor.seenRuns).toHaveLength(2);
    expect(seenName(executor.seenRuns[0]!.compiled)).toBe("every-tick");
    expect(seenName(executor.seenRuns[1]!.compiled)).toBe("every-tick");
    await dispose();
  });
});

describe("structured send — onBusy conflict", () => {
  it("an EXPLICIT onBusy:steer carrying responseFormat while racing is rejected; the same request as onBusy:queue works", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, dispose } = await mkSession({
      scripts: [textReply("first answer"), textReply("second answer")],
      holdUntil: gate,
    });

    // Start the in-flight (gated) execution.
    const h1 = await session.send({ messages: [{ role: "user", content: "ask" }] });

    // An EXPLICIT `onBusy: "steer"` carrying `responseFormat` that joins the
    // in-flight turn is rejected loud (a join has no final turn to shape).
    const steerErr = await session
      .send({
        messages: [{ role: "user", content: "steer" }],
        responseFormat: rf("x"),
        onBusy: "steer",
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((steerErr as { _tag?: string })._tag).toBe("SteerCannotCarryStructuredOutput");

    // The same request as `onBusy: "queue"` is accepted — it queues until the
    // session quiesces, then runs as a fresh execution.
    const h2p = session.send({
      messages: [{ role: "user", content: "queued" }],
      responseFormat: rf("x"),
      onBusy: "queue",
    });

    release();
    await h1.result;
    const r2 = await (await h2p).result;
    expect(r2.response).toBe("second answer");
    await dispose();
  });

  it("an IMPLICIT structured send (unset onBusy) racing an in-flight execution QUEUES — no throw, fresh execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, executor, dispose } = await mkSession({
      scripts: [textReply("first answer"), textReply("second answer")],
      holdUntil: gate,
    });

    // Start the in-flight (gated) execution.
    const h1 = await session.send({ messages: [{ role: "user", content: "ask" }] });

    // A structured send with UNSET onBusy resolves to "queue" under the smart
    // default — no throw. It waits for quiescence, then runs fresh with its
    // responseFormat applied.
    const h2p = session.send({
      messages: [{ role: "user", content: "structured" }],
      responseFormat: rf("implicit"),
    });

    // It must NOT have joined h1 (that would resolve immediately with h1's
    // handle); it is blocked on quiescence.
    let resolvedEarly = false;
    void h2p.then(() => {
      resolvedEarly = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(resolvedEarly).toBe(false);

    release();
    await h1.result;
    const h2 = await h2p;
    expect(h2).not.toBe(h1); // fresh execution, not a join
    const r2 = await h2.result;
    expect(r2.response).toBe("second answer");

    // The queued send ran as its OWN tick with its responseFormat applied.
    expect(seenName(executor.seenRuns[executor.seenRuns.length - 1]!.compiled)).toBe("implicit");
    await dispose();
  });
});
