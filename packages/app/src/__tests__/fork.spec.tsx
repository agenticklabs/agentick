/**
 * `session.fork()` — same-image, copied-state child (C2, three-audiences-plan
 * §C split, item 2).
 *
 * A fork is `spawn` (no send, parent's OWN agent root) + `restore` of the
 * parent's live snapshot. The child copies every SnapshotCapable bridge's state
 * (timeline, knobs, …) + tick/usage accounting, gets its OWN sessionId and spawn
 * lineage, and is ALWAYS returned unbound (never auto-sends). Post-fork the two
 * sessions diverge — a mutation on one is invisible to the other.
 *
 * End-to-end through `createApp` (the app is the `SpawnContext` that actually
 * constructs + restores the child). Scripted through the canonical
 * {@link FakeLanguageModelExecutor}.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §C
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ExecutionTarget, LanguageModelExecutionResult } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { createApp } from "../react.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const textResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage,
});

function fakeExecutor(scripts: readonly LanguageModelExecutionResult[]): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `fake-${ulid()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: scripts.map((result) => ({ result })),
      target,
    },
  );
}

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "You are an agent.");

describe("session.fork() — copied state, own lineage, divergence (C2)", () => {
  it("forks an unbound child that copies parent state and then diverges", async () => {
    const executor = fakeExecutor([textResult("parent turn"), textResult("child turn")]);
    const app = await createApp(React.createElement(Agent), { modelExecutor: executor, target });
    const parent = await app.createSession({ sessionId: "parent" });

    // Give the parent real state: a timeline (via a send) + a knob value.
    await (
      await parent.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    parent.knob("mood").set("decisive");
    await waitFor(() => parent.knob("mood").get() === "decisive");
    const parentEntryCount = parent.timeline.read().entries.length;
    expect(parentEntryCount).toBeGreaterThan(0);

    // ── Fork ──
    const child = await parent.fork();

    // Unbound child: a session (has `send`), NOT an execution handle, distinct id.
    expect(typeof child.send).toBe("function");
    expect(child.id).not.toBe("parent");

    // Lineage (SP5): the child's spawnPath is [parent]; parent edge is the parent.
    const childRec = await app.getSessionRecord(child.id);
    expect(childRec?.parentSessionId).toBe("parent");
    expect(childRec?.spawnPath).toEqual(["parent"]);

    // Copied bridge state: knob value + timeline entries carried across.
    expect(child.knob("mood").get()).toBe("decisive");
    expect(child.timeline.read().entries.length).toBe(parentEntryCount);

    // ── Divergence ── a knob change on the child does NOT reflect on the parent.
    child.knob("mood").set("hasty");
    await waitFor(() => child.knob("mood").get() === "hasty");
    expect(parent.knob("mood").get()).toBe("decisive");

    // A new send on the child grows ITS timeline; the parent's is untouched.
    await (
      await child.send({ messages: [{ role: "user", content: "again" }] })
    ).result;
    expect(child.timeline.read().entries.length).toBeGreaterThan(parentEntryCount);
    expect(parent.timeline.read().entries.length).toBe(parentEntryCount);

    await app.closeApp();
  });
});
