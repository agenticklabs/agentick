/**
 * The reflection pass, and compaction riding it.
 *
 * `reflect()` is the session's answer to "ask this conversation's own model one
 * more question": project the context the next tick would send, append the
 * question, send it. Compaction is its first caller, and this asserts the pair
 * end to end through a REAL session — the config an adopter writes
 * (`timeline: { compact: rollingSummary(…) }`), not a hand-bound `generate`.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System } from "@agentick/compiler-react";
import { rollingSummary } from "@agentick/timeline/strategies";
import {
  ResponseValidationError,
  SPEC_VERSION,
  StructuredOutputIncomplete,
  jsonSchema,
  progressEventName,
  type AdapterDelta,
  type ExecutionTarget,
  type LanguageModelExecutionResult,
  type ProtocolEvent,
  type StandardSchemaV1,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { SessionHarness } from "../harness.js";
import { reflectionRequest, withInstruction } from "../reflect.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "reflect-test",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const SUMMARY = "the whole conversation, folded";
const USAGE = {
  inputTokens: 40_000,
  outputTokens: 900,
  totalTokens: 40_900,
  cachedInputTokens: 34_000,
};

/** Streams the summary in three chunks, then reports what it cost. */
const DELTAS: readonly AdapterDelta[] = [
  { type: "message-start", role: "assistant" },
  { type: "content-start", blockIndex: 0, blockType: "text" },
  { type: "content-delta", blockIndex: 0, delta: "the whole " },
  { type: "content-delta", blockIndex: 0, delta: "conversation, " },
  { type: "content-delta", blockIndex: 0, delta: "folded" },
  { type: "content-end", blockIndex: 0 },
  { type: "message-end", stopReason: "end", usage: USAGE },
];

function summarizingExecutor() {
  return new FakeLanguageModelExecutor(
    `reflect-exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      target,
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: SUMMARY }],
          stopReason: "end",
          usage: USAGE,
        },
        deltas: DELTAS,
      },
    },
  );
}

async function makeSession(
  keepVerbatim: number,
  over: {
    readonly executor?: FakeLanguageModelExecutor;
    readonly target?: ExecutionTarget;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`rf-c-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`rf-l-${Math.random()}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`rf-e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`rf-t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = over.executor ?? summarizingExecutor();
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `rf-${Math.random()}`,
    agent: React.createElement(System, null, "you are helpful"),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target: over.target ?? target,
    timeline: { compact: rollingSummary({ keepVerbatim }) },
  });
  await session.ready;
  await session.mountReady;

  for (let i = 0; i < 10; i++) {
    await session.timeline.append({
      kind: "message",
      message: {
        id: `m${i}`,
        ts: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${i}` }],
      },
    });
  }

  return {
    session,
    bus,
    executor,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
}

const summaryEvent = (entries: readonly unknown[]) =>
  entries
    .map(
      (e) =>
        (
          e as {
            message?: {
              content?: readonly {
                data?: Record<string, unknown>;
                metadata?: Record<string, unknown>;
              }[];
            };
          }
        ).message?.content?.[0],
    )
    .find((b) => b?.data?.["summary"] !== undefined);

describe("compaction through a real session", () => {
  it("folds with the session's own model — nothing binds a summarizer", async () => {
    const rig = await makeSession(2);

    await rig.session.timeline.compact();

    const entries = rig.session.timeline.read().entries;
    expect(summaryEvent(entries)?.data?.["summary"]).toBe(SUMMARY);
    await rig.close();
  });

  it("records what the fold cost, cache reads included", async () => {
    const rig = await makeSession(2);

    await rig.session.timeline.compact();

    // On `metadata`, not `data` — `data` is rendered into the model's context.
    expect(summaryEvent(rig.session.timeline.read().entries)?.metadata?.["usage"]).toEqual(USAGE);
    await rig.close();
  });

  it("reports progress as the summary streams", async () => {
    const rig = await makeSession(2);
    const seen: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(rig.bus.subscribe({}), (e) =>
        Effect.sync(() => {
          if (e.name === progressEventName("timeline")) seen.push(e);
        }),
      ),
    );
    await waitFor(() =>
      rig.bus.hasSubscriberFor({ surface: "timeline", name: "x", phase: "terminal" }),
    );

    await rig.session.timeline.compact();

    // The harness opens with an UNMEASURED frame — it knows the fold started,
    // not how long it runs; `total` is the strategy's token cap, a denominator
    // in a unit the harness does not hold. So wait on MEASURED frames: waiting
    // on the raw count could yield the opener plus one measured frame, and
    // whether the opener is caught at all is a race against subscriber attach.
    // Asserting every frame carries a total passed only by LOSING that race.
    const measured = (): { progress: number; total?: number }[] =>
      seen
        .map((e) => e.payload as { progress: number; total?: number })
        .filter((u) => u.total !== undefined);
    await waitFor(() => measured().length > 1);

    const updates = measured();
    // The cap is the denominator, so the bar is determinate once measured — and
    // the counts rise, which is the thing a spinner cannot say.
    expect(updates.every((u) => u.total === 8192)).toBe(true);
    expect(updates.at(-1)!.progress).toBeGreaterThan(updates[0]!.progress);
    // One token for the whole fold — a bar, not a series of unrelated ticks.
    expect(new Set(seen.map((e) => (e.payload as { token: string }).token)).size).toBe(1);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await rig.close();
  });
});

describe("withInstruction", () => {
  const input = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    tools: [{ name: "search", description: "", inputSchema: { type: "object" as const } }],
  };

  it("appends the instruction as the last user turn, so the prefix is a cache read", () => {
    const out = withInstruction(input as never, "summarize");
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBe(input.messages[0]);
    expect(out.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "summarize" }],
    });
  });

  it("leaves the projected tools alone — the pass decided them before projecting", () => {
    expect(withInstruction(input as never, "summarize").tools).toBe(input.tools);
  });

  it("overlays only the parameters it was given", () => {
    expect(
      withInstruction(input as never, "s", { maxOutputTokens: 500 }).parameters?.maxOutputTokens,
    ).toBe(500);
    expect(withInstruction(input as never, "s").parameters).toBeUndefined();
    expect(withInstruction(input as never, "s", {}).parameters).toBeUndefined();
  });
});

// ============================================================================
// W41 — a reflection can be asked for a SHAPE
// ============================================================================

/** `{ summary, questions }` — the fold `parseQuestions` used to regex out. */
const foldSchema: StandardSchemaV1<unknown, { summary: string; questions: string[] }> = jsonSchema<{
  summary: string;
  questions: string[];
}>(
  {
    type: "object",
    properties: { summary: { type: "string" }, questions: { type: "array" } },
    required: ["summary", "questions"],
  },
  {
    validator: (v) => {
      const c = v as { summary?: unknown; questions?: unknown };
      return typeof c?.summary === "string" && Array.isArray(c?.questions)
        ? { value: c as { summary: string; questions: string[] } }
        : { issues: [{ message: "summary must be a string and questions an array" }] };
    },
  },
);

const FOLD = { summary: SUMMARY, questions: ["what changed?"] };

/** Native structured decoding — the responseFormat strategy's home. */
const jsonSchemaTarget: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "reflect-json",
  capabilities: { supportsTools: true, supportsStreaming: true, supportsJsonSchema: true },
};

function scriptedExecutor(result: LanguageModelExecutionResult, on = target) {
  return new FakeLanguageModelExecutor(
    `reflect-struct-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { target: on, scripted: { result } },
  );
}

const terminalCall = (input: Record<string, unknown>): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "tool_use", toolUseId: "tc-1", name: "submit_result", input }],
  stopReason: "tool_use",
  usage: USAGE,
  toolCalls: [{ id: "tc-1", name: "submit_result", input }],
});

const textReply = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage: USAGE,
});

describe("a reflection asked for a shape", () => {
  it("returns the validated object, so nothing downstream parses prose", async () => {
    const rig = await makeSession(2, { executor: scriptedExecutor(terminalCall(FOLD)) });

    const result = await rig.session.reflect({ instructions: "fold it", output: foldSchema });

    expect(result.data).toEqual(FOLD);
    await rig.close();
  });

  it("advertises the terminal tool — `tools: []` would foreclose the one cross-provider path", async () => {
    const rig = await makeSession(2, { executor: scriptedExecutor(terminalCall(FOLD)) });

    await rig.session.reflect({ instructions: "fold it", output: foldSchema });

    expect(rig.executor.seenRuns.at(-1)!.tools.map((t) => t.name)).toEqual(["submit_result"]);
    await rig.close();
  });

  it("forces the choice — one shot is the whole budget, so there is no wrap-up tick to spend", () => {
    const { spec, parameters } = reflectionRequest({ output: foldSchema }, target);

    expect(spec?.strategy).toBe("tool");
    expect(parameters.toolChoice).toEqual({ tool: "submit_result" });
  });

  it("takes the native directive when the target decodes a schema itself", async () => {
    const rig = await makeSession(2, {
      target: jsonSchemaTarget,
      executor: scriptedExecutor(textReply(JSON.stringify(FOLD)), jsonSchemaTarget),
    });

    const result = await rig.session.reflect({ instructions: "fold it", output: foldSchema });

    expect(result.data).toEqual(FOLD);
    expect(rig.executor.seenRuns.at(-1)!.tools).toEqual([]);
    await rig.close();
  });

  it("raises the error a structured send raises when the reply violates the schema", async () => {
    const rig = await makeSession(2, { executor: scriptedExecutor(terminalCall({ summary: 7 })) });

    await expect(
      rig.session.reflect({ instructions: "fold it", output: foldSchema }),
    ).rejects.toBeInstanceOf(ResponseValidationError);
    await rig.close();
  });

  it("reports a reply that never called the terminal tool rather than answering empty", async () => {
    const rig = await makeSession(2, { executor: scriptedExecutor(textReply("I'd rather not")) });

    await expect(
      rig.session.reflect({ instructions: "fold it", output: foldSchema }),
    ).rejects.toBeInstanceOf(StructuredOutputIncomplete);
    await rig.close();
  });

  it("leaves a text-mode reflection with no tools and no directive", async () => {
    const rig = await makeSession(2);

    const result = await rig.session.reflect({ instructions: "summarize" });

    expect(result.data).toBeUndefined();
    expect(result.text).toBe(SUMMARY);
    expect(rig.executor.seenRuns.at(-1)!.tools).toEqual([]);
    expect(reflectionRequest({}, target).parameters).toEqual({});
    await rig.close();
  });
});
