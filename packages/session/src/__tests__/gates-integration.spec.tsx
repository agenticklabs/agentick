/**
 * Gates ↔ session integration (cross-harness — lives here per ADR 27
 * because it wires the REAL SessionHarness + compiler + loop + a
 * tree-declared `useGate`). Proves the two front-ends converge on ONE
 * controller:
 *
 *   - Single construction site + reference equality: the controller
 *     `useGate` registers into IS `session.gates` (same instance).
 *   - Unified registry: a tree-declared gate AND a programmatic
 *     `session.gates.register(...)` gate both appear in `session.gates.list()`.
 *   - Real tick (ADR 67): a real execution drives the continuation
 *     decision through `session.notifyLifecycle`, which evaluates the
 *     shared controller against the settled `TickResult`. Both gates
 *     engage AND — the load-bearing ADR 67 assertion — HOLD the loop open
 *     (continue-force) so the execution runs to `maxTicks` instead of
 *     stopping after the model's `end` on tick 1.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System, useLoopControl, useOnTickEnd } from "@agentick/compiler-react";
import { useGate, useGates } from "@agentick/gates/react";
import type { GatesHandle } from "@agentick/gates";
import type { ExecutionTarget } from "@agentick/spec";

import { SessionHarness } from "../harness.js";
import type { ProtocolEvent } from "@agentick/spec";

/**
 * A bus that keeps every published envelope, for assertions about op SCOPE.
 *
 * `hasSubscriberFor` is forced true because `publishLazy` short-circuits to
 * `Effect.void` when nothing is subscribed — it never reaches `append`, so a
 * recorder that only overrides `append` would observe an empty log and the
 * assertion would pass vacuously. Recording IS subscribing, as far as the
 * lazy-emission gate is concerned.
 */
class RecordingBus extends LocalEventBus {
  readonly seen: ProtocolEvent[] = [];
  override hasSubscriberFor(): boolean {
    return true;
  }
  override append(event: ProtocolEvent) {
    this.seen.push(event);
    return super.append(event);
  }
  override appendBatch(events: ReadonlyArray<ProtocolEvent>) {
    this.seen.push(...events);
    return super.appendBatch(events);
  }
}

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
    const compiler = new CompilerHarness("gi-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("gi-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    const elicitation = new ElicitationHarness("gi:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("gi-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = endExec();
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `gi-${Math.random()}`,
      agent: React.createElement(Agent),
      compiler,
      loop,
      modelExecutor: executor,
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

    // Real execution drives the continuation decision through
    // session.notifyLifecycle → controller.handleTickEnd against the
    // settled TickResult. The model says "end" every tick (no tool_use →
    // provisional stop), so both gates engage AND hold the loop open
    // (continue-force). With maxTicks: 3 the execution runs the full three
    // ticks and terminates on the hard cap — proving the gate hold is now
    // load-bearing (pre-ADR-67 the loop stopped after tick 1).
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      maxTicks: 3,
    });
    const result = await handle.result;

    expect(session.gate("tree-inv")?.value).toBe("active");
    expect(session.gate("prog-latch")?.value).toBe("active");
    expect(result.ticks).toBe(3);
    expect(result.stopReason).toBe("max_ticks");

    await session.close();
    await tools.close();
  });

  // GG1 (V1-PARITY-TRACKER, Surface 3) — the ADR-67 tick-end arbitration
  // invariant moved out of the gate package into the session's
  // `TickEndForwardDecision` resolution (`harness.ts` drains `stop` BEFORE
  // `continue`). This asserts the invariant at its new home: when a gate
  // forces `continueAfterTick` AND trusted tree code forces `stopAfterTick`
  // in the SAME tick, the explicit stop wins. Without the stop the
  // never-satisfied gate holds the loop open to `maxTicks` (proven by the
  // sibling test above); with it the run halts after tick 1.
  it("stop-beats-continue: a tree stopAfterTick overrides a gate's continueAfterTick in the same tick", async () => {
    function Agent() {
      const loop = useLoopControl();
      // Never-satisfied verified gate → engages every tick and forces
      // continueAfterTick (would otherwise run to maxTicks: 3).
      useGate("hold-open", {
        description: "Never satisfied",
        instructions: "GATE: hold the loop open.",
        satisfied: () => false,
      });
      // Trusted tree code forces a stop at the same tick-end the gate holds.
      useOnTickEnd(() => {
        loop.stopAfterTick("tree-stop");
      });
      return React.createElement(System, null, "hi");
    }

    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("gi-sbc-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("gi-sbc-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    const elicitation = new ElicitationHarness("gi-sbc:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("gi-sbc-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = endExec();
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `gi-sbc-${Math.random()}`,
      agent: React.createElement(Agent),
      compiler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      maxTicks: 3,
    });
    const result = await handle.result;

    // The gate DID engage → it genuinely issued continueAfterTick this tick,
    // so the stop overrode a live continue (not merely a quiet loop).
    expect(session.gate("hold-open")?.value).toBe("active");
    // Stop wins: one tick, not the gate's maxTicks: 3.
    expect(result.ticks).toBe(1);

    await session.close();
    await tools.close();
  });

  /**
   * A gate transition WRITES — every engage/clear sets the gate's backing knob.
   * That write must land inside the tick that caused it.
   *
   * It did not. `GatesController.handleTickEnd` was Promise-shaped and the
   * session reached it through `Effect.promise`, and `transition` then fired
   * `void knobs.set(...)` — two severing points, either one enough to start a
   * root fiber. The ambient `RuntimeContext` carrying `tickId` lives on the
   * fiber, so the op still ran, still journaled, still published; it just
   * carried no tick. Measured before the fix, on all three phases:
   *
   *     knobs:command:set  phase=requested  tick=MISSING
   *     knobs:command:set  phase=before     tick=MISSING
   *     knobs:command:set  phase=terminal   tick=MISSING
   *
   * The root cause was in the TYPE: `KnobsHarnessProtocol` declared only
   * `PromiseView<KnobsFx>` and no `fx`, so `GatesController` — typed against a
   * `Pick` of it — had no reachable Effect twin to compose. `HarnessEdge<F>`
   * now derives both faces together (see `spec/protocol/promise-view.ts`).
   */
  it("a gate's tick-end knob write carries the tick's id", async () => {
    function Agent() {
      // Never satisfied → transitions to "active" on tick 1, so there is
      // guaranteed to be a knob write to inspect.
      useGate("scoped-inv", {
        description: "Never satisfied",
        instructions: "GATE: hold.",
        satisfied: () => false,
      });
      return React.createElement(System, null, "hi");
    }

    const journal = new MemoryJournal();
    const bus = new RecordingBus();
    const inbox = new LocalInbox();
    const compiler = new CompilerHarness("gi-ts-r", journal, bus, inbox);
    const loop = new LoopExecutorHarness("gi-ts-l", journal, bus, inbox);
    const resolver = new InMemoryHandlerResolver();
    const elicitation = new ElicitationHarness("gi-ts:elicitation", journal, bus, inbox);
    const tools = new ToolExecutorHarness("gi-ts-t", journal, bus, inbox, {
      handlerResolver: resolver,
      elicitation,
    });
    const executor = endExec();
    await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

    const session = new SessionHarness(journal, bus, inbox, {
      sessionId: `gi-ts-${Math.random()}`,
      agent: React.createElement(Agent),
      compiler,
      loop,
      modelExecutor: executor,
      toolExecutor: tools,
      target,
    });
    await session.ready;
    await session.mountReady;

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }], maxTicks: 1 });
    await handle.result;

    // ── ARRANGE GUARD, asserted separately and FIRST ──
    // An earlier attempt at this test failed with "expected 0 to be greater
    // than 0" because the gate scaffolding silently never landed — the report
    // pointed at the invariant while the real fault was the setup. Assert the
    // precondition on its own so a broken arrange says so in its own words.
    // Asserted through a labelled string so the failure output NAMES the
    // broken step; `expect(n).toBeGreaterThan(0)` reports "expected 0 to be
    // greater than 0", which is what sent the last attempt chasing the
    // invariant while the real fault was the setup.
    const knobSets = bus.seen.filter((e) => e.name === "knobs:command:set");
    expect(
      knobSets.length > 0 ? "ok" : "ARRANGE: gate never transitioned — no knob write to check",
    ).toBe("ok");
    expect(session.gate("scoped-inv")?.value).toBe("active");

    // ── THE INVARIANT ──
    // Report the PHASES that lost the tick, not a count — the phase list is
    // what distinguishes "the whole op is orphaned" from "one phase escaped".
    const tickless = knobSets.filter((e) => e.scope?.tickId === undefined).map((e) => e.phase);
    expect(tickless).toEqual([]);

    await session.close();
    await tools.close();
  });
});
