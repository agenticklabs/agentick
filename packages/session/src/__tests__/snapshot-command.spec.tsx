/**
 * Recovery pass #1 — the checkpoint/rehydrate cluster.
 *
 * `session.snapshot()` and `session.restore()` are COMMANDS (ADR 80/83), so
 * the hook quartet falls out of the CommandRegistry derivation:
 *
 *   - `onBeforeSessionSnapshot` (the veto a pin rides) +
 *     `onAfterSessionSnapshot`.
 *   - `onBeforeSessionRestore` + `onAfterSessionRestore`.
 *
 * The hooks survive the checkpointing sweep; the payloads do not. Neither verb
 * carries data — each harness flushes to and reads from its OWN store — so the
 * after-hook's transform arm has nothing to transform, and what these pin is
 * that the seams still FIRE, in order, around a void operation.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, deriveHookNames } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import type { ExecutionTarget } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = (text: string) =>
  new FakeLanguageModelExecutor(
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
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

async function mkSession(id: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`c-${id}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`l-${id}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`e-${id}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`t-${id}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = replyExec("ok");
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: id,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

describe("SessionHarness — snapshot/restore commands (recovery pass #1)", () => {
  it("deriveHookNames agrees for session:command:snapshot + restore", () => {
    expect(deriveHookNames("session:command:snapshot")).toEqual([
      "onBeforeSessionSnapshot",
      "onAfterSessionSnapshot",
    ]);
    expect(deriveHookNames("session:command:restore")).toEqual([
      "onBeforeSessionRestore",
      "onAfterSessionRestore",
    ]);
  });

  it("onBefore/AfterSessionSnapshot fire around the flush barrier", async () => {
    const { session, tools } = await mkSession("snap-hooks");
    const seen: string[] = [];
    session.hooks.onBeforeSessionSnapshot(() => {
      seen.push("before");
    });
    session.hooks.onAfterSessionSnapshot(() => {
      seen.push("after");
    });

    await expect(session.snapshot()).resolves.toBeUndefined();
    expect(seen).toEqual(["before", "after"]);

    await session.close();
    await tools.close();
  });

  it("onBeforeSessionSnapshot can veto (throw) the capture", async () => {
    const { session, tools } = await mkSession("snap-veto");
    session.hooks.onBeforeSessionSnapshot(() => {
      throw new Error("no snapshots allowed");
    });
    await expect(session.snapshot()).rejects.toThrow(/no snapshots allowed/);
    await session.close();
    await tools.close();
  });

  it("onBefore/AfterSessionRestore fire around restore()", async () => {
    const { session, tools } = await mkSession("restore-hooks");
    let before = 0;
    let after = 0;
    session_hookCounts(
      session,
      () => (before += 1),
      () => (after += 1),
    );
    await expect(session.restore()).resolves.toBeUndefined();
    expect(before).toBe(1);
    expect(after).toBe(1);
    await session.close();
    await tools.close();
  });
});

/** Register restore before/after hook counters (kept out of the test body for readability). */
function session_hookCounts(
  session: SessionHarness,
  onBefore: () => void,
  onAfter: () => void,
): void {
  session.hooks.onBeforeSessionRestore(() => {
    onBefore();
  });
  session.hooks.onAfterSessionRestore(() => {
    onAfter();
  });
}
