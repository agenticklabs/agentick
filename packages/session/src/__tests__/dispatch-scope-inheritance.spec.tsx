/**
 * **A child operation must inherit the scope of the operation that caused it.**
 *
 * `tool:command:dispatch` runs inside a tick and carries `executionId` +
 * `tickId`. A tool handler reaching `ctx.elicit` / `ctx.tasks` causes further
 * work, and that work is attributable to the same dispatch, the same tick, the
 * same execution — or the journal cannot answer "what did this tool call do".
 *
 * It does not inherit any of it today. Measured:
 *
 *     tool:command:dispatch              exec=Y tick=Y   ← the parent
 *     elicitation:command:elicit         exec=- tick=-   ← its child: NEITHER
 *     session:channel:task-status        exec=- tick=-   ← NEITHER
 *
 * This is a DIFFERENT defect from the gates one (fixed in 934b8204), and worse.
 * Gates lost only `tickId`, because `GatesController` reached knobs through the
 * Promise facade while `executionId` was still ambient. Here the loss is total,
 * for two compounding structural reasons:
 *
 *   1. `ElicitationHarness.elicitOp` (`elicitation/src/harness.ts:238`) builds
 *      its `Operation` literal with `scope: this.parentScope ?? {}` — the
 *      CONSTRUCTION-BOUND scope. A per-session harness therefore stamps every
 *      elicit with the same scope no matter which execution or tick called it.
 *   2. It runs that op through `runHarnessProtocol`, which starts a root fiber
 *      that inherits no FiberRef — so there is no ambient scope to gap-fill
 *      from either.
 *
 * `HarnessEdge` does NOT fix this. These harnesses declare no commands
 * (`this.command(...)` count: elicitation 1 hand-built op, tasks 0), so there
 * is nothing for `BaseHarness.fxProxy()` to derive an `fx` twin from. The fix
 * is `runHarnessProtocolOn(capturedRuntime, …)` — the existing primitive whose
 * docblock names this exact symptom ("an orphaned root: no `parentOpId`, no
 * ambient `RuntimeContext`") — with the runtime captured in-fiber during
 * dispatch, the way `ctx.run` already does it. See task #7.
 *
 * The first test below is the ARRANGE, asserted separately and expected to
 * PASS: the handler runs and the elicit op actually fires. The second is the
 * invariant, marked `it.fails` so it self-clears the moment the fix lands —
 * splitting them is deliberate, so a broken arrange can never make the marker
 * "pass" for the wrong reason.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { TasksHarness } from "@agentick/tasks";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System } from "@agentick/compiler-react";
import { jsonSchema } from "@agentick/spec";
import type { ExecutionTarget, ProtocolEvent } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

/** Records every published envelope; see `gates-integration.spec.tsx`. */
class RecordingBus extends LocalEventBus {
  readonly seen: ProtocolEvent[] = [];
  /** Fires synchronously on every publish — used to auto-answer the elicit. */
  onEvent?: (e: ProtocolEvent) => void;
  override hasSubscriberFor(): boolean {
    return true;
  }
  override append(event: ProtocolEvent) {
    this.seen.push(event);
    this.onEvent?.(event);
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

interface Run {
  readonly seen: readonly ProtocolEvent[];
  readonly handlerRan: boolean;
}

/**
 * One real execution: the model calls a tool, and that tool's handler reaches
 * `ctx.elicit` — the production path where a raw-Operation harness is invoked
 * from inside a tick.
 */
async function runWithElicitingTool(): Promise<Run> {
  const journal = new MemoryJournal();
  const bus = new RecordingBus();
  const inbox = new LocalInbox();

  const compiler = new CompilerHarness("dsi-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("dsi-l", journal, bus, inbox);
  const elicitation = new ElicitationHarness("dsi:elicitation", journal, bus, inbox);
  const tasks = new TasksHarness("dsi:tasks", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const tools = new ToolExecutorHarness("dsi-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
    tasks,
    initialTools: [
      {
        declaration: {
          id: "probe",
          name: "probe",
          description: "reaches ctx.elicit from inside the tick",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model", "dispatch"],
        },
        handlerRef: "h.probe",
        binding: { scope: "runtime" },
      },
    ],
  });

  // Answer the elicit as soon as it is published, so the handler completes and
  // the execution can finish. The outcome is irrelevant — only the op's SCOPE
  // is under measurement.
  bus.onEvent = (e) => {
    // `metadata` is present only on some `ProtocolEvent` members, so narrow
    // rather than assume — the channel delta carries it, operation envelopes
    // do not.
    const meta = (e as { metadata?: Record<string, unknown> }).metadata;
    const cid = meta?.correlationId;
    if (meta?.requestType === "request" && typeof cid === "string") {
      void elicitation.respond({ correlationId: cid, outcome: "declined" });
    }
  };

  let handlerRan = false;
  resolver.register("h.probe", async (_input, deps) => {
    handlerRan = true;
    const ctx = (deps as { ctx?: { elicit?: { text: (m: string) => Promise<unknown> } } })?.ctx;
    await ctx?.elicit?.text("ok?").catch(() => undefined);
    return [{ type: "text", text: "ok" }];
  });

  const executor = new FakeLanguageModelExecutor("dsi-e", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "calling" }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: [{ id: "c1", name: "probe", input: {} }],
        },
      },
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "done" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ],
  });

  await Promise.all([
    compiler.ready,
    loop.ready,
    tools.ready,
    elicitation.ready,
    tasks.ready,
    executor.ready,
  ]);

  const Agent = () => React.createElement(System, null, "hi");
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: "dsi-s",
    agent: React.createElement(Agent),
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;

  const handle = await session.send({ messages: [{ role: "user", content: "hi" }], maxTicks: 3 });
  await handle.result;

  await session.close();
  await tools.close();
  await tasks.close();
  return { seen: bus.seen, handlerRan };
}

describe("a child operation inherits its causing operation's scope", () => {
  it("ARRANGE: the tool handler runs and its elicit really fires inside a scoped dispatch", async () => {
    const { seen, handlerRan } = await runWithElicitingTool();

    expect(handlerRan ? "ok" : "ARRANGE: handler never ran — tool did not resolve").toBe("ok");

    // The PARENT must carry the scope, or the invariant below is vacuous:
    // there would be nothing for the child to inherit.
    const dispatch = seen.find((e) => e.name === "tool:command:dispatch");
    expect(dispatch ? "ok" : "ARRANGE: no tool:command:dispatch envelope").toBe("ok");
    expect(dispatch?.scope?.executionId).toBeTruthy();
    expect(dispatch?.scope?.tickId).toBeTruthy();

    const elicits = seen.filter((e) => e.name === "elicitation:command:elicit");
    expect(
      elicits.length > 0 ? "ok" : "ARRANGE: no elicitation op — ctx.elicit was never hit",
    ).toBe("ok");
  });

  // KNOWN GAP — task #7. Delete the `.fails` when the fix lands; this
  // self-clears by failing once the child inherits the dispatch scope.
  it.fails("elicitation's op inherits the dispatching tick + execution", async () => {
    const { seen } = await runWithElicitingTool();
    const elicit = seen.find((e) => e.name === "elicitation:command:elicit");

    // Reported as an object so the failure names WHICH dimension was lost
    // rather than just "expected undefined to be truthy".
    expect({
      executionId: elicit?.scope?.executionId === undefined ? "MISSING" : "present",
      tickId: elicit?.scope?.tickId === undefined ? "MISSING" : "present",
    }).toEqual({ executionId: "present", tickId: "present" });
  });
});
