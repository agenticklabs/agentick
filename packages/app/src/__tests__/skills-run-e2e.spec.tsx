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
 * Scripted through the CANONICAL `FakeLanguageModelExecutor`
 * (`@agentick/model-executor`) — never a bespoke executor stub
 * (deterministic; model behavior is the eval tier, never asserted here).
 * The busy-send race rides the fake's scripted `holdUntil` knob. An app-level `echo` tool makes the run's
 * send "tools-mounted", so the auto strategy resolves to the terminal tool.
 *
 * Covers:
 *   - run WITH output → typed `data` + `text` + `stopReason "output_delivered"`
 *   - run WITHOUT output → `text` only, no `data`
 *   - run carrying `output` that RACES an in-flight execution → QUEUES under the
 *     smart default (unset `onBusy` → `"queue"` for structured sends), then
 *     delivers its structured result after quiescence
 *
 * @see docs/proposals/v2/three-audiences-plan.md §C
 * @see ../../session/src/__tests__/structured-output.spec.ts (the mechanism tier)
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { withSkills } from "@agentick/skills";
import {
  FakeLanguageModelExecutor,
  type FakeLanguageModelExecutorOptions,
} from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { waitFor } from "@agentick/utils/testing";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  StandardSchemaV1,
  ToolDeclaration,
  ToolHandler,
} from "@agentick/spec";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";

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

/** The canonical fake, on its own local substrate (it is a BaseHarness). */
function fakeExecutor(
  scripted: FakeLanguageModelExecutorOptions["scripted"],
): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `fake-${ulid()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted, target },
  );
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
    const executor = fakeExecutor({ result: terminalCall({ answer: "approved" }) });
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      tools: [echoTool],
      toolHandlers: new Map([["h.echo", echoHandler]]),
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-1" });

    const handle = await session.skills!.run("review", {
      args: { diff: "a-change" },
      output: answerSchema,
      maxTicks: 5,
    });
    // The send grammar, verbatim (C1.1): streaming/abort/status on the handle,
    // the typed outcome on `.result`.
    expect(typeof handle.events).toBe("function");
    const r = await handle.result;

    expect(r.data).toEqual({ answer: "approved" });
    expect(r.response).toBe("here is your result");
    expect(r.stopReason).toBe("output_delivered");
    expect(r.executionId).toBe(handle.executionId);
    await session.close();
    await app.close();
  });

  it("run WITHOUT output: text only, no data", async () => {
    const executor = fakeExecutor({ result: textResult("a plain answer") });
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-2" });

    const r = await (await session.skills!.run("review", { args: { diff: "x" } })).result;

    expect(r.response).toBe("a plain answer");
    expect("data" in r).toBe(false);
    await session.close();
    await app.close();
  });

  it("missing skill → SkillNotFound", async () => {
    const executor = fakeExecutor({ result: textResult("noop") });
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

  it("run carrying output that RACES an in-flight execution QUEUES, then delivers its structured result", async () => {
    // First send is gated (in-flight); the skill run carries `output` with an
    // unset `onBusy`, so the smart default resolves it to "queue" — it waits for
    // the in-flight execution to quiesce, then runs fresh and delivers its
    // structured result via the terminal tool.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const executor = fakeExecutor([
      { result: textResult("in-flight turn"), holdUntil: gate },
      { result: terminalCall({ answer: "queued-verdict" }) },
    ]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      tools: [echoTool],
      toolHandlers: new Map([["h.echo", echoHandler]]),
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-run-4" });

    // Start the gated (in-flight) execution. `stream: false` forces the
    // non-streaming `run` path, where the fake's `holdUntil` gate applies — so
    // the execution stays genuinely in-flight until `release()`.
    const inflight = await session.send({
      messages: [{ role: "user", content: "hold" }],
      stream: false,
    });

    // The skill run carries `output` — under the smart default it QUEUES rather
    // than steering. It must not resolve until the in-flight turn quiesces.
    const runPromise = session.skills!.run("review", { output: answerSchema, maxTicks: 5 });
    let runResolvedEarly = false;
    void runPromise.then(() => {
      runResolvedEarly = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(runResolvedEarly).toBe(false); // blocked on quiescence

    release();
    await inflight.result;

    const r = await (await runPromise).result;
    expect(r.data).toEqual({ answer: "queued-verdict" });
    expect(r.stopReason).toBe("output_delivered");
    await session.close();
    await app.close();
  });
});

describe("session.skills!.run — isolation (C2: routes through session.fork())", () => {
  it("runs on a forked child, leaves the PARENT timeline untouched, disposes the child after settle", async () => {
    // Two scripted turns: [0] the parent's own send, [1] the isolated run's turn
    // (executed on the forked child; the executor is shared/inherited).
    const executor = fakeExecutor([
      { result: textResult("parent turn") },
      { result: textResult("isolated reply") },
    ]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-iso" });

    // Give the parent a real timeline so the isolation invariant is observable.
    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    const parentEntriesBefore = session.timeline.read().entries.length;
    expect(parentEntriesBefore).toBeGreaterThan(0);

    // Isolated run — the composed send executes on a fresh fork, not the parent.
    const r = await (await session.skills!.run("review", { isolate: true, args: { x: 1 } })).result;
    expect(r.response).toBe("isolated reply");

    // ISOLATION INVARIANT — the parent's timeline gained NOTHING from the run.
    expect(session.timeline.read().entries.length).toBe(parentEntriesBefore);

    // The forked child was created (durable record with parent lineage) …
    const records = await app.listSessions();
    const childRec = records.find((rec) => rec.parentSessionId === "s-iso");
    expect(childRec).toBeDefined();
    // … and disposed from the LIVE registry after the handle settled.
    await waitFor(() => app.getSession(childRec!.id) === undefined, {
      description: "isolated fork disposed after settle",
    });

    await session.close();
    await app.close();
  });

  it("isolate: true with no isolation runner reachable still surfaces the skill result path", async () => {
    // Sanity: a normal (non-isolated) run and an isolated run of the SAME skill
    // both deliver the skill's result — isolation changes WHERE it runs, not WHAT.
    const executor = fakeExecutor([
      { result: textResult("normal") },
      { result: textResult("isolated") },
    ]);
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: executor,
      extensions: [withSkills({ initial: [reviewSkill] })],
    });
    const session = await app.createSession({ sessionId: "s-iso-2" });

    const normal = await (await session.skills!.run("review")).result;
    expect(normal.response).toBe("normal");
    const isolated = await (await session.skills!.run("review", { isolate: true })).result;
    expect(isolated.response).toBe("isolated");

    await session.close();
    await app.close();
  });
});
