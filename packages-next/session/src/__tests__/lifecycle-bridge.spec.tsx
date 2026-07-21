/**
 * THE integration gate (#206 / ADR 55): the loop → reconciler →
 * lifecycle-hook chain, end to end, through a REAL stack. Its absence is
 * why the dead bridge shipped green across five packages — every prior
 * lifecycle test injected at the store/harness boundary by hand. This one
 * runs a real execution (with a scripted tool call) and asserts the WHOLE
 * useOn* family fires — tick-end, execution-start/end, tool-start/end —
 * plus useContextInfo's live window.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import {
  ReconcilerHarness,
  useContextInfo,
  useOnTickEnd,
  useOnExecutionStart,
  useOnExecutionEnd,
  useOnToolStart,
  useOnToolEnd,
  useOnError,
  type ContextInfo,
} from "@agentick/reconciler-react-next";
import { System } from "@agentick/reconciler-react-next";
import type {
  ExecutionTarget,
  LifecycleExecutionEnd,
  LifecycleExecutionStart,
  LifecycleToolEnd,
  LifecycleToolStart,
} from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  // Self-described window — effectiveModelInfo folds it (no seed row for "mock").
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1000 },
};

/**
 * Two-tick scripted executor: tick 1 emits a `tool_use` with one tool
 * call (loop dispatches it → tool-start/tool-end fire), tick 2 ends the
 * run. Both ticks report 250 input tokens so useContextInfo's final
 * utilization stays 0.25 (250 / 1000).
 */
function toolThenReplyExec() {
  return new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "calling echo" }],
            toolCalls: [{ id: "tc1", name: "echo", input: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
            usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 },
          },
        },
      ],
    },
  );
}

describe("lifecycle bridge — real loop drives the WHOLE hook family (#206 / ADR 55)", () => {
  it("tick-end, execution-start/end, tool-start/end all fire; useContextInfo yields a live window + utilization", async () => {
    const tickEnds: number[] = [];
    const executionStarts: LifecycleExecutionStart[] = [];
    const executionEnds: LifecycleExecutionEnd[] = [];
    const toolStarts: LifecycleToolStart[] = [];
    const toolEnds: LifecycleToolEnd[] = [];
    const errors: unknown[] = [];
    const contextSamples: ContextInfo[] = [];

    function Agent() {
      useOnTickEnd(() => {
        tickEnds.push(Date.now());
      });
      useOnExecutionStart((e) => {
        executionStarts.push(e);
      });
      useOnExecutionEnd((e) => {
        executionEnds.push(e);
      });
      useOnToolStart((e) => {
        toolStarts.push(e);
      });
      useOnToolEnd((e) => {
        toolEnds.push(e);
      });
      useOnError((e) => {
        errors.push(e);
      });
      contextSamples.push(useContextInfo());
      return React.createElement(System, null, "you are helpful");
    }

    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const reconciler = new ReconcilerHarness("lc-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("lc-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    resolver.register("h.echo", async () => [{ type: "text", text: "ok" }]);
    const elicitation = new ElicitationHarness("lc-t:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("lc-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = toolThenReplyExec();
    await Promise.all([
      reconciler.ready,
      loop.ready,
      tools.ready,
      elicitation.ready,
      executor.ready,
    ]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `lc-${Math.random()}`,
      agent: React.createElement(Agent),
      reconciler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
      // No `models` injection needed — the window rides target.capabilities.
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          id: "t.echo",
          name: "echo",
          description: "echo tool",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.echo",
        },
      ],
    });
    await handle.result;

    // The async bridge fired: real tick-ends reached the hook store.
    expect(tickEnds.length).toBeGreaterThan(0);

    // The COMPLETED bridge (ADR 55): the rest of the family is now live
    // from a real run — not just tick-end.
    expect(executionStarts.length).toBeGreaterThan(0);
    expect(executionEnds.length).toBeGreaterThan(0);
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolEnds.length).toBeGreaterThan(0);
    // The scripted tool succeeds (handler registered) — end carries it.
    expect(toolStarts[0]!.name).toBe("echo");
    expect(toolEnds[0]!.outcome).toBe("succeeded");
    // Happy path — no error bridged.
    expect(errors).toHaveLength(0);

    // WINDOW is SYNCHRONOUS render-context (ADR 54 / 55): it appears in a
    // render sample immediately — no flush needed, no async race.
    expect(contextSamples.some((c) => c.contextWindow === 1000)).toBe(true);

    // usedTokens is the ASYNC bridge half (historical) — flush React's
    // Scheduler, then the latest render reflects it + utilization.
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(() => setImmediate(r), 0));
    const last = contextSamples[contextSamples.length - 1]!;
    expect(last.contextWindow).toBe(1000);
    expect(last.usedTokens).toBe(250);
    expect(last.utilization).toBeCloseTo(0.25); // 250 / 1000

    await session.close();
    await tools.close();
  });
});
