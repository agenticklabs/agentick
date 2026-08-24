/**
 * Persistence is triggered by EXECUTION, not by creation — and not by
 * teardown. A session that never ran a turn dies recordless on evict,
 * shutdown, and close alike; the first `running` transition (or `eager`, or
 * adopting an existing record) is what earns the row. This is what lets a
 * host create a LIVE session for a brand-new chat — palette, prompts,
 * completions all real — and leave no trace if the user never says anything.
 */
import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app/react";
import { fakeCompiler } from "@agentick/compiler/testing";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemorySessionStore } from "@agentick/session";

const PlainAgent = () => null;

async function mk() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("virgin", journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
      },
    },
  });
  await executor.ready;
  const store = new InMemorySessionStore();
  const app = await createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    compiler: fakeCompiler() as never,
    journal,
    bus,
    inbox,
    sessions: { store },
  });
  return { app, store };
}

const ctx = { principal: undefined } as never;

describe("an unpersisted session dies recordless", () => {
  it("createSession alone writes no record", async () => {
    const { app, store } = await mk();
    await app.createSession({ sessionId: "v1" });
    expect(await store.get("v1", ctx)).toBeUndefined();
    await app.closeApp();
  });

  it("evict of a never-persisted session writes no record", async () => {
    const { app, store } = await mk();
    await app.createSession({ sessionId: "v2" });
    await app.evictSession("v2");
    expect(await store.get("v2", ctx)).toBeUndefined();
    await app.closeApp();
  });

  it("app shutdown with a never-persisted session writes no record", async () => {
    const { app, store } = await mk();
    await app.createSession({ sessionId: "v3" });
    await app.closeApp();
    expect(await store.get("v3", ctx)).toBeUndefined();
  });

  it("eager: true earns the record at creation (control)", async () => {
    const { app, store } = await mk();
    await app.createSession({ sessionId: "v5", eager: true });
    expect(await store.get("v5", ctx)).toBeDefined();
    await app.closeApp();
  });

  it("the same session WITH a turn writes exactly one record (control)", async () => {
    const { app, store } = await mk();
    const s = await app.createSession({ sessionId: "v4" });
    await (
      await s.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    expect(await store.get("v4", ctx)).toBeDefined();
    await app.closeApp();
  });
});
