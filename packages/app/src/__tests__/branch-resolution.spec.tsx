/**
 * ADR 100 — the create door resolves a branch anchor's POSITION.
 *
 * The verbs name the entry (they hold the source's timeline); the door answers
 * where that entry sits and writes the complete `from` bag, which is what
 * genesis bounds the inherited copy by and what the record stores. The two
 * absences differ by layer: absent `entryId` ARRIVING means "the tip as of
 * now", absent on the RECORD means the source had nothing to anchor on.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ExecutionTarget, TimelineEntry } from "@agentick/spec";

import { createApp } from "../react.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function Agent() {
  return React.createElement("section" as never, { id: "system" }, "You are an agent.");
}

async function mkApp() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(`fake-${generateId()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
    target,
  });
  await executor.ready;
  return createApp(React.createElement(Agent), {
    modelExecutor: executor,
    target,
    journal,
    bus,
    inbox,
  });
}

const messageIdsOf = (entries: readonly TimelineEntry[]): readonly (string | undefined)[] =>
  entries.flatMap((entry) => (entry.kind === "message" ? [entry.message.id] : []));

describe("branch anchor resolution (ADR 100)", () => {
  it("resolves a NAMED entry to its position in the source log", async () => {
    const app = await mkApp();
    const source = await app.createSession({ sessionId: "src" });
    await (
      await source.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    const [firstMessageId] = messageIdsOf(source.timeline.read().entries);

    await app.createSession({
      sessionId: "at-first",
      eager: true,
      from: {
        sessionId: "src",
        entryId: firstMessageId as string,
        inherited: true,
        anchored: true,
      },
    });

    const record = await app.getSessionRecord("at-first");
    expect(record?.from?.entryId).toBe(firstMessageId);
    // The user turn is the log's floor, and the bound is inclusive of it.
    expect(record?.from?.seq).toBe(0);

    await app.closeApp();
  });

  it("an ABSENT entryId at the door means the source's tip", async () => {
    const app = await mkApp();
    const source = await app.createSession({ sessionId: "src" });
    await (
      await source.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    const messageIds = messageIdsOf(source.timeline.read().entries);

    await app.createSession({
      sessionId: "at-tip",
      eager: true,
      from: { sessionId: "src", inherited: true, anchored: false },
    });

    const record = await app.getSessionRecord("at-tip");
    expect(record?.from?.entryId).toBe(messageIds[messageIds.length - 1]);
    // The assistant turn: seq 1, with the turn BOUNDARY at 2 left behind — a
    // branch anchors on a message, never on a boundary.
    expect(record?.from?.seq).toBe(1);

    await app.closeApp();
  });

  it("a MID-TIMELINE branch inherits source[..anchor] inclusive — and nothing after it", async () => {
    // The seam this whole resolution exists for. A `seq` that never reached the
    // fan-out leaves the bound undefined, the copy takes the source's ENTIRE
    // log, and every branch over-inherits with green types — so the assertion
    // is a COUNT against a source that kept talking past the anchor.
    const app = await mkApp();
    const source = await app.createSession({ sessionId: "src" });
    await (
      await source.send({ messages: [{ role: "user", content: "first" }] })
    ).result;
    const afterFirstTurn = messageIdsOf(source.timeline.read().entries);
    await (
      await source.send({ messages: [{ role: "user", content: "second" }] })
    ).result;
    const wholeLog = await source.timeline.history();
    expect(wholeLog.length).toBeGreaterThan(afterFirstTurn.length);

    // Anchor on the FIRST turn's assistant reply, two turns in.
    const anchorId = afterFirstTurn[afterFirstTurn.length - 1] as string;
    const branch = await app.createSession({
      sessionId: "mid",
      from: { sessionId: "src", entryId: anchorId, inherited: true, anchored: false },
    });

    // Exactly the entries through the anchor: the source's later turn — and
    // the turn boundary sitting between them — stayed behind.
    expect(messageIdsOf(branch.timeline.read().entries)).toEqual(afterFirstTurn);
    expect(branch.timeline.read().entries.length).toBe(afterFirstTurn.length);

    await app.closeApp();
  });

  it("an entry the source does not have is refused, not guessed", async () => {
    const app = await mkApp();
    await app.createSession({ sessionId: "src" });

    await expect(
      app.createSession({
        sessionId: "nowhere",
        from: { sessionId: "src", entryId: "m_not_here", inherited: true, anchored: false },
      }),
    ).rejects.toMatchObject({ _tag: "BranchSourceEntryNotFoundError" });

    await app.closeApp();
  });

  it("a source that is not live is refused — its position cannot be read", async () => {
    // TODO(adr100-cold-branch): see the throw site — this is the known gap, not
    // the intended end state.
    const app = await mkApp();

    await expect(
      app.createSession({
        sessionId: "orphan",
        from: { sessionId: "never-opened", inherited: true, anchored: false },
      }),
    ).rejects.toThrow(/not live/);

    await app.closeApp();
  });
});
