/**
 * The durable {@link SessionRecord} across an APP restart (E11 + ADR 49) — the
 * adopter's door, `app.createSession` over an injected `SessionStore`.
 *
 * A second app process opening a session id the store already holds is a
 * RESUME. The app-owned `title` an app-side titler wrote must come back with
 * it, and must still be there after the resumed session's next turn — a status
 * transition re-writes the whole record, so a resume that never read the
 * durable one silently blanks it (#290).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemorySessionStore } from "@agentick/session";
import type { ExecutionTarget, SessionStore } from "@agentick/spec";

import { createApp } from "../react.js";

function PlainAgent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** One app "process" over the shared durable session registry. */
async function mkApp(store: SessionStore) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(`rec-${Math.random()}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  });
  await executor.ready;
  return createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target,
    journal,
    bus,
    inbox,
    sessions: { store },
  });
}

describe("SessionRecord across an app restart (#290)", () => {
  it("a resumed session keeps the app-owned title and its accounting", async () => {
    const store = new InMemorySessionStore();

    const app1 = await mkApp(store);
    const session = await app1.createSession({ sessionId: "titled" });
    await app1.setSessionMeta("titled", { title: "Q3 numbers" });
    await (
      await session.send({ messages: [{ role: "user", content: "hello" }] })
    ).result;
    const before = await app1.getSessionRecord("titled");
    expect(before?.title).toBe("Q3 numbers");
    await app1.closeApp();

    // ── A new process over the same durable registry. ──
    const app2 = await mkApp(store);
    const resumed = await app2.createSession({ sessionId: "titled" });
    expect((await app2.getSessionRecord("titled"))?.title).toBe("Q3 numbers");

    // The turn that used to blank the record.
    await (
      await resumed.send({ messages: [{ role: "user", content: "again" }] })
    ).result;

    const after = await app2.getSessionRecord("titled");
    expect(after?.title).toBe("Q3 numbers");
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.executionCount).toBe(2);
    expect(after?.usage.totalTokens).toBe(4);

    await app2.closeApp();
  });
});
