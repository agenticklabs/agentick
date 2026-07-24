/**
 * `session.skills!.run` — end-to-end through `createApp` (three-audiences-plan
 * §C, C-core).
 *
 * The REAL path: this proves the app's C-core injection site — the
 * session-construction fold feature-detects `RunnerBindable` and late-binds the
 * session's `send` into the skills harness — AND the structured-output path
 * (§B2) end-to-end. The skills harness has NO session access of its own; if the
 * injection did not fire, `run` would throw `SkillRunnerUnbound`.
 *
 * Scripted through a recording executor (deterministic — model behavior is the
 * eval tier, never asserted here). An app-level `echo` tool makes the run's
 * send "tools-mounted", so the auto strategy resolves to the terminal tool.
 *
 * Covers:
 *   - run WITH output → typed `data` + `text` + `stopReason "output_delivered"`
 *   - run WITHOUT output → `text` only, no `data`
 *   - run carrying `output` that RACES an in-flight execution →
 *     `SteerCannotCarryStructuredOutput` (the existing steer guard, surfaced)
 *
 * @see docs/proposals/v2/three-audiences-plan.md §C
 * @see ../../session/src/__tests__/structured-output.spec.ts (the mechanism tier)
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { createApp } from "../react.js";
import { withSkills } from "@agentick/skills-next";
import type {
  ExecutorFx,
  ExecutorTerminal,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  RunInput,
  StandardSchemaV1,
  ToolDeclaration,
  ToolHandler,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/** `{ answer: string }` — a schema that actually validates. */
const answerSchema: StandardSchemaV1<unknown, { answer: string }> = jsonSchema<{ answer: string }>(
  { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  {
    validator: (v) =>
      typeof (v as { answer?: unknown })?.answer === "string"
        ? { value: v as { answer: string } }
        : { issues: [{ message: "answer must be a string" }] },
  },
);

const terminalCall = (input: Record<string, unknown>): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [
    { type: "text", text: "here is your result" },
    { type: "tool_use", toolUseId: "tc-term", name: "submit_result", input },
  ],
  stopReason: "tool_use",
  usage,
  toolCalls: [{ id: "tc-term", name: "submit_result", input }],
});

const textResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage,
});

/** A scripted executor. `gateFirst` holds the FIRST `run()` on a gate so a
 *  concurrent send lands mid-execution (for the steer test). */
function mkExecutor(
  scripts: readonly LanguageModelExecutionResult[],
  gateFirst = false,
): { readonly executor: LanguageModelExecutor; release: () => void } {
  let releaseFn: () => void = () => {};
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
      if (gateFirst && calls === 1) yield* Effect.promise(() => gate);
      return { outcome: "succeeded", result: nextResult() };
    });
  const fx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    use: () => () => {},
    run: runFx as (i: RunInput) => Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>>,
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

const echoTool: ToolDeclaration = {
  id: "t.echo",
  name: "echo",
  description: "echo",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: "h.echo",
};
const echoHandler: ToolHandler = async () => [{ type: "text", text: "echoed" }];

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "You are a skill runner.");

const reviewSkill = {
  name: "review",
  description: "Review a change and decide.",
  content: "You are a code reviewer. Read the change and produce a verdict.",
};

describe("session.skills!.run — e2e through createApp (C-core injection + §B2)", () => {
  it("run WITH output: the injected runner delivers typed data + text + output_delivered", async () => {
    const { executor } = mkExecutor([terminalCall({ answer: "approved" })]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      tools: [echoTool],
      toolHandlers: new Map([["h.echo", echoHandler]]),
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-1" });

    const r = await session.skills!.run("review", {
      args: { diff: "a-change" },
      output: answerSchema,
      maxTicks: 5,
    });

    expect(r.data).toEqual({ answer: "approved" });
    expect(r.text).toBe("here is your result");
    expect(r.stopReason).toBe("output_delivered");
    expect(typeof r.executionId).toBe("string");
    await session.close();
    await app.close();
  });

  it("run WITHOUT output: text only, no data", async () => {
    const { executor } = mkExecutor([textResult("a plain answer")]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-2" });

    const r = await session.skills!.run("review", { args: { diff: "x" } });

    expect(r.text).toBe("a plain answer");
    expect("data" in r).toBe(false);
    await session.close();
    await app.close();
  });

  it("missing skill → SkillNotFound", async () => {
    const { executor } = mkExecutor([textResult("noop")]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-3" });

    await expect(session.skills!.run("nonexistent")).rejects.toMatchObject({
      _tag: "SkillNotFound",
    });
    await session.close();
    await app.close();
  });

  it("run carrying output that RACES an in-flight execution → SteerCannotCarryStructuredOutput", async () => {
    // First send is gated (in-flight); the skill run with `output` joins it as a
    // steer and is rejected — the existing guard, surfaced honestly.
    const { executor, release } = mkExecutor(
      [textResult("in-flight turn"), textResult("would-be skill turn")],
      true,
    );
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      tools: [echoTool],
      toolHandlers: new Map([["h.echo", echoHandler]]),
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-4" });

    // Start the gated (in-flight) execution.
    const inflight = await session.send({ messages: [{ role: "user", content: "hold" }] });

    // The skill run joins the in-flight turn (default steer delivery); its
    // `output` makes the steer illegal.
    await expect(session.skills!.run("review", { output: answerSchema })).rejects.toMatchObject({
      _tag: "SteerCannotCarryStructuredOutput",
    });

    release();
    await inflight.result;
    await session.close();
    await app.close();
  });
});
