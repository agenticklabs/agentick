/**
 * `session.fork()` — the CONVERSATION verb (ADR 100): a new direction from an
 * entry, standing beside its source rather than under it.
 *
 * The new session inherits the source's durable scopes: the flush barrier lands
 * the source's writes, every BranchCapable bridge copies its scope at the store
 * layer, and genesis opens the fork over that copy. It gets its OWN sessionId,
 * is ALWAYS returned unbound (never auto-sends), and — being a conversation —
 * earns its durable row by speaking. Post-fork the two diverge: a mutation on
 * one is invisible to the other.
 *
 * End-to-end through `createApp` (the app owns the create door the verb lowers
 * to). Scripted through the canonical {@link FakeLanguageModelExecutor}.
 *
 * @see docs/proposals/v2/blueprint/100-conversation-branches.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ExecutionTarget, LanguageModelExecutionResult, TimelineEntry } from "@agentick/spec";
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
    `fake-${generateId()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: scripts.map((result) => ({ result })),
      target,
    },
  );
}

const messageIdsOf = (entries: readonly TimelineEntry[]): readonly (string | undefined)[] =>
  entries.flatMap((entry) => (entry.kind === "message" ? [entry.message.id] : []));

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "You are an agent.");

describe("session.fork() — inherited state, own lineage, divergence (ADR 100)", () => {
  it("forks an unbound conversation that copies source state and then diverges", async () => {
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

    // A fork is a CONVERSATION (ADR 100 law 3): it earns its durable record by
    // speaking, like any other. Until then there is nothing to read.
    expect(await app.getSessionRecord(child.id)).toBeUndefined();

    // Inherited state: the knob value, and every message through the anchor.
    // The source's trailing turn BOUNDARY stays behind — a branch anchors on a
    // message and the inherit bound is inclusive of it (ADR 100 law 1).
    expect(child.knob("mood").get()).toBe("decisive");
    expect(messageIdsOf(child.timeline.read().entries)).toEqual(
      messageIdsOf(parent.timeline.read().entries),
    );

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

    // …and having spoken, it has a record — carrying the branch edge back to
    // its source (SP5 lineage rides the same write).
    const childRec = await app.getSessionRecord(child.id);
    expect(childRec?.from?.sessionId).toBe("parent");
    expect(childRec?.spawnPath).toEqual(["parent"]);

    await app.closeApp();
  });
});
