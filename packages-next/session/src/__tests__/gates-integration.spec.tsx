/**
 * Gates ↔ session integration (cross-harness — lives here per ADR 27
 * because it wires the REAL SessionHarness + reconciler + loop + a
 * tree-declared `useGate`). Proves the two front-ends converge on ONE
 * controller:
 *
 *   - Single construction site + reference equality: the controller
 *     `useGate` registers into IS `session.gates` (same instance).
 *   - Unified registry: a tree-declared gate AND a programmatic
 *     `session.gates.register(...)` gate both appear in `session.gates.list()`.
 *   - Real tick: a real execution drives tick-end through the reconciler
 *     lifecycle store into the shared controller — both gates evaluate.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness, System } from "@agentick/reconciler-react-next";
import { useGate, useGates } from "@agentick/gates-next/react";
import type { GatesHandle } from "@agentick/gates-next";
import type { ExecutionTarget } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1000 },
};

function endExec() {
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
            output: [{ type: "text", text: "done" }],
            stopReason: "end",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        },
      ],
    },
  );
}

describe("gates ↔ session — one controller, two front-ends", () => {
  it("unified registry + reference equality + real-tick evaluation", async () => {
    const captured: { gates: GatesHandle | null } = { gates: null };

    function Agent() {
      captured.gates = useGates();
      const g = useGate("tree-inv", {
        description: "Tree invariant",
        instructions: "GATE: fix the invariant.",
        // Verified, armed from the first tick, never satisfied → engages
        // on the real tick.
        satisfied: () => false,
      });
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(System, null, "hi"),
        g.element,
      );
    }

    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const reconciler = new ReconcilerHarness("gi-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("gi-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    const elicitation = new ElicitationHarness("gi:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("gi-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = endExec();
    await Promise.all([
      reconciler.ready,
      loop.ready,
      tools.ready,
      elicitation.ready,
      executor.ready,
    ]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `gi-${Math.random()}`,
      agent: React.createElement(Agent),
      reconciler,
      loop,
      executor,
      toolExecutor: tools,
      target,
    });
    await session.ready;
    await session.mountReady;

    // Reference equality — the surface `useGates()` returns IS session.gates.
    expect(captured.gates).not.toBeNull();
    expect(captured.gates).toBe(session.gates);

    // Programmatic registration lands in the SAME registry.
    session.gates.register("prog-latch", {
      description: "Programmatic latch",
      instructions: "Await something.",
      activateWhen: () => true,
    });

    const names = session.gates
      .list()
      .map((g) => g.name)
      .sort();
    expect(names).toEqual(["prog-latch", "tree-inv"]);

    // Real tick drives tick-end through the shared controller — both
    // gates evaluate: the verified one engages (unsatisfied), the latch
    // one arms.
    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    await handle.result;

    expect(session.gate("tree-inv")?.value).toBe("active");
    expect(session.gate("prog-latch")?.value).toBe("active");

    await session.close();
    await tools.close();
  });
});
