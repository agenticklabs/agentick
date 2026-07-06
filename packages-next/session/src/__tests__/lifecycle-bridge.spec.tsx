/**
 * THE integration gate (#206): the loop → reconciler → lifecycle-hook
 * chain, end to end, through a REAL stack. Its absence is why the dead
 * bridge shipped green across five packages — every prior lifecycle
 * test injected at the store/harness boundary by hand. This one runs a
 * real execution and asserts the hooks actually fire.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import {
  ReconcilerHarness,
  useContextInfo,
  useOnTickEnd,
  type ContextInfo,
} from "@agentick/reconciler-react-next";
import { System } from "@agentick/reconciler-react-next";
import type { ExecutionTarget } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  // Self-described window — effectiveModelInfo folds it (no seed row for "mock").
  capabilities: { supportsTools: false, supportsStreaming: false, contextWindow: 1000 },
};

function replyExec(text: string) {
  return new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 },
        },
      },
    },
  );
}

describe("lifecycle bridge — real loop drives the hooks (#206)", () => {
  it("useOnTickEnd fires and useContextInfo yields a live window + utilization", async () => {
    const tickEnds: number[] = [];
    const contextSamples: ContextInfo[] = [];

    function Agent() {
      useOnTickEnd(() => {
        tickEnds.push(Date.now());
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
    const elicitation = new ElicitationHarness("lc-t:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("lc-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = replyExec("done");
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
      executor,
      toolExecutor: tools,
      target,
      // No `models` injection needed — the window rides target.capabilities.
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    // The async bridge fired: a real tick-end reached the hook store.
    expect(tickEnds.length).toBeGreaterThan(0);

    // WINDOW is SYNCHRONOUS render-context (ADR 54 (b)): it appears in a
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
