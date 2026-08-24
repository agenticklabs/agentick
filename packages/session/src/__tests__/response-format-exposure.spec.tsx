/**
 * `SendInput.responseFormat` as an EXPOSURE, end-to-end — the render-side
 * `useResponseFormat()` and its dispatch-side twin `ctx.responseFormat` read
 * the SAME shape during the SAME real send, and both fall back to `undefined`
 * on a send that carried none.
 *
 * Driven through the real stack (SessionHarness + CompilerHarness +
 * LoopExecutorHarness + ToolExecutorHarness + the canonical
 * {@link FakeLanguageModelExecutor}) with a tree that reads the hook and a
 * real handler the scripted model calls.
 */

import * as React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System, useResponseFormat } from "@agentick/compiler-react";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  ResponseFormat,
  ToolDeclaration,
} from "@agentick/spec";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false, supportsJsonSchema: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const format = (name: string): ResponseFormat => ({
  type: "json_schema",
  name,
  schema: { type: "object", properties: { verdict: { type: "string" } } },
});

/**
 * One turn: a `probe` call, then a plain answer. The call id is unique per
 * turn — dispatch is idempotent on `toolCallId`, so a repeated id replays the
 * journaled terminal instead of invoking the handler again.
 */
const probeThenEnd = (turn: number): readonly LanguageModelExecutionResult[] => [
  {
    specVersion: SPEC_VERSION,
    output: [],
    stopReason: "tool_use",
    usage,
    toolCalls: [{ id: `probe-${turn}`, name: "probe", input: {} }],
  },
  {
    specVersion: SPEC_VERSION,
    output: [{ type: "text", text: "done" }],
    stopReason: "end",
    usage,
  },
];

const probeTool: ToolDeclaration = {
  id: "t.probe",
  name: "probe",
  description: "reports the shape its dispatch was bound to",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.probe",
};

interface Built {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  /** What `useResponseFormat()` returned, one entry per render. */
  readonly treeSaw: (ResponseFormat | undefined)[];
  /** What `ctx.responseFormat` held, one entry per dispatch. */
  readonly handlerSaw: (ResponseFormat | undefined)[];
  dispose(): Promise<void>;
}

/** `sends` scripts the model for that many probe-then-end turns. */
async function mkSession(sends = 1): Promise<Built> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("rfx-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("rfx-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("rfx-t:elic", journal, bus, inbox);
  const tools = new ToolExecutorHarness("rfx-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor("rfx-exec", journal, bus, inbox, {
    target,
    scripted: Array.from({ length: sends }, (_, turn) => probeThenEnd(turn))
      .flat()
      .map((result) => ({ result })),
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const treeSaw: (ResponseFormat | undefined)[] = [];
  const handlerSaw: (ResponseFormat | undefined)[] = [];

  resolver.register("h.probe", async (_input, { ctx }) => {
    handlerSaw.push(ctx.responseFormat);
    return [{ type: "text", text: "probed" }];
  });

  function Agent() {
    treeSaw.push(useResponseFormat());
    return React.createElement(System, null, "hi");
  }

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `rfx-${Math.random().toString(36).slice(2)}`,
    agent: React.createElement(Agent),
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
    treeSaw,
    handlerSaw,
    dispose: async () => {
      await session.close();
      await tools.close();
    },
  };
}

/** The send under test, with the pre-send observations discarded. */
async function sendWith(built: Built, responseFormat?: ResponseFormat) {
  built.treeSaw.length = 0;
  built.handlerSaw.length = 0;
  const handle = await built.session.send({
    messages: [{ role: "user", content: "go" }],
    tools: [probeTool],
    maxTicks: 5,
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  });
  return handle.result;
}

/** Asserts at least one observation, and that every one of them matches. */
function everyObservationWas(
  observed: readonly (ResponseFormat | undefined)[],
  expected: ResponseFormat | undefined,
): void {
  expect(observed.length).toBeGreaterThan(0);
  expect(observed).toEqual(observed.map(() => expected));
}

describe("responseFormat exposure — tree and handler read the send's shape", () => {
  it("useResponseFormat() sees the shape the send carried", async () => {
    const built = await mkSession();
    const bound = format("answer");

    await sendWith(built, bound);

    everyObservationWas(built.treeSaw, bound);
    await built.dispose();
  });

  it("ctx.responseFormat sees the same shape at dispatch", async () => {
    const built = await mkSession();
    const bound = format("answer");

    await sendWith(built, bound);

    expect(built.handlerSaw).toEqual([bound]);
    await built.dispose();
  });

  it("a send carrying no responseFormat exposes neither", async () => {
    const built = await mkSession();

    await sendWith(built);

    everyObservationWas(built.treeSaw, undefined);
    expect(built.handlerSaw).toEqual([undefined]);
    await built.dispose();
  });

  it("the exposure is per-send, not cached on the mount", async () => {
    const built = await mkSession(2);
    const bound = format("first-send");

    await sendWith(built, bound);
    everyObservationWas(built.treeSaw, bound);
    expect(built.handlerSaw).toEqual([bound]);

    await sendWith(built);
    everyObservationWas(built.treeSaw, undefined);
    expect(built.handlerSaw).toEqual([undefined]);

    await built.dispose();
  });
});
