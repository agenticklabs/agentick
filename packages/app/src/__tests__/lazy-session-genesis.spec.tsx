/**
 * Lazy durable genesis — the durable {@link SessionRecord} is written on the
 * first MUTATION, not on `createSession`.
 *
 * `createSession` used to persist a blank record unconditionally, so a client
 * that opens a session per "new chat" left a trail of empty "Untitled" rows in
 * the durable "list my sessions" registry before the user ever spoke. Genesis
 * is now lazy: creating a session seeds the cache only; the first status
 * transition / `setSessionMeta` performs the first durable `put`. `{ eager }`
 * is the opt-out for "I want the empty session in the list NOW".
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

describe("lazy durable genesis (E11)", () => {
  it("createSession WITHOUT a send does NOT persist a record", async () => {
    // RED before the fix: genesis persisted a blank record unconditionally.
    const store = new InMemorySessionStore();
    const app = await mkApp(store);

    await app.createSession({ sessionId: "blank" });

    expect(await app.getSessionRecord("blank")).toBeUndefined();
    expect((await app.listSessions()).map((r) => r.id)).not.toContain("blank");

    await app.closeApp();
  });

  it("the FIRST send persists the record", async () => {
    const store = new InMemorySessionStore();
    const app = await mkApp(store);

    const session = await app.createSession({ sessionId: "spoken" });
    expect(await app.getSessionRecord("spoken")).toBeUndefined();

    await (
      await session.send({ messages: [{ role: "user", content: "hello" }] })
    ).result;

    expect(await app.getSessionRecord("spoken")).toBeDefined();
    expect((await app.listSessions()).map((r) => r.id)).toContain("spoken");

    await app.closeApp();
  });

  it("createSession({ eager: true }) persists immediately, with no send", async () => {
    const store = new InMemorySessionStore();
    const app = await mkApp(store);

    await app.createSession({ sessionId: "eager", eager: true });

    expect(await app.getSessionRecord("eager")).toBeDefined();
    expect((await app.listSessions()).map((r) => r.id)).toContain("eager");

    await app.closeApp();
  });
});
