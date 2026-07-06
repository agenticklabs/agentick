/**
 * ADR 56 — tree-declared per-tick model, END TO END through a REAL stack.
 *
 * Proves the crux with the production `FakeLanguageModelExecutor` double
 * (Meszaros fake, reused — NOT hand-rolled): a component calls
 * `useModelRegistration("m1", { executor: fakeM1, target })`; a real
 * loop run resolves `m1` off the mount's `ModelBridge` and runs the
 * fake M1 executor for the tick — NOT the session's default executor.
 *
 * Precedence: with an IR-declared model, tick-IR wins over the
 * send/session executor; with NO declaration, the loop falls back to the
 * session executor (today's behavior, untouched). Discriminated by the
 * distinct scripted response text each executor produces.
 *
 * Wiring mirrors `lifecycle-bridge.spec.tsx`.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness, System, useModelRegistration } from "@agentick/reconciler-react-next";
import type { ExecutionTarget, RegisteredModel } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "session-default",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

const m1Target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "m1-model",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

/** Single-tick executor scripted to reply with a distinguishing text. */
function replyExec(text: string) {
  return new FakeLanguageModelExecutor(
    `exec-${text}-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        },
      },
    },
  );
}

interface Rig {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  close(): Promise<void>;
}

async function makeRig(agent: React.ReactElement, sessionExecutor: FakeLanguageModelExecutor) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness(`mb-r-${Math.random()}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`mb-l-${Math.random()}`, journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness(`mb-e-${Math.random()}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`mb-t-${Math.random()}`, journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  await Promise.all([
    reconciler.ready,
    loop.ready,
    tools.ready,
    elicitation.ready,
    sessionExecutor.ready,
  ]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `mb-${Math.random()}`,
    agent,
    reconciler,
    loop,
    executor: sessionExecutor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  const rig: Rig = {
    session,
    tools,
    close: async () => {
      await session.close();
      await tools.close();
    },
  };
  return rig;
}

describe("tree-declared per-tick model — real loop resolves the ModelBridge (ADR 56)", () => {
  it("tick-IR model wins: the declared fake M1 executor runs, NOT the session default", async () => {
    // Stable RegisteredModel identity — one registration across renders.
    const m1: RegisteredModel = { executor: replyExec("FROM-M1"), target: m1Target };
    await m1.executor.ready;

    function Agent() {
      const decl = useModelRegistration("m1", m1);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(System, null, "you are helpful"),
        decl,
      );
    }

    const rig = await makeRig(React.createElement(Agent), replyExec("SESSION-DEFAULT"));
    const handle = await rig.session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;

    // The tick-declared model produced the reply — resolution + precedence.
    expect(result.response).toBe("FROM-M1");
    expect(result.response).not.toContain("SESSION-DEFAULT");

    await rig.close();
  });

  it("no IR model: the loop falls back to the session/send executor", async () => {
    function Agent() {
      return React.createElement(System, null, "you are helpful");
    }

    const rig = await makeRig(React.createElement(Agent), replyExec("SESSION-DEFAULT"));
    const handle = await rig.session.send({ messages: [{ role: "user", content: "hi" }] });
    const result = await handle.result;

    expect(result.response).toBe("SESSION-DEFAULT");

    await rig.close();
  });
});
