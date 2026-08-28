/**
 * What a client can learn about an app, and about a thread.
 *
 * Both projections were truncating. `gateway/list_apps` returned `{ id }` alone —
 * its own comment said why ("Metadata isn't part of AppHarnessProtocol yet") — so a
 * client could enumerate apps and had nothing to label one with. `toSessionEntry`
 * dropped the thread's `title` / `description`, so a session list had no label per
 * row either.
 *
 * The pair is what answers "who said this": a session record carries `appId`, the
 * client reached the sessions through that app, and the app's `title` is the name.
 * A LIVE JOIN, deliberately — renaming an app relabels its existing threads, where
 * a name copied onto each record would freeze them under the old one. That is the
 * opposite handling from `boundary.target`, which is evidence about a past turn and
 * must not move; a display label is not evidence.
 *
 * Driven through `fakeWireCaller` so these are the real handlers, not assertions
 * about the helpers they happen to call today.
 */

import { describe, expect, it } from "vitest";
import type { AppInfo, ContentBlock, SessionEntry } from "@agentick/spec";
import { relation, SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { createGateway } from "../index.js";
import { fakeWireCaller } from "../testing/index.js";

const NULL_ROOT = null as unknown;

function mkAppOptions(identity: { title?: string; description?: string } = {}) {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    ...identity,
    executor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    compiler: new CompilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
  };
}

describe("AppInfo projection — a client can name the app it is talking to", () => {
  it("carries title and description through gateway/list_apps", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions({ title: "Ernesto", description: "Knowify's assistant" }),
    });

    const result = await fakeWireCaller({ apps: [app] }).call<{ apps: readonly AppInfo[] }>(
      "gateway/list_apps",
    );

    expect(result.apps).toEqual([
      { id: app.id, title: "Ernesto", description: "Knowify's assistant" },
    ]);

    await gateway.close();
  });

  it("carries them through gateway/get_app too", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions({ title: "Ernesto" }),
    });

    const info = await fakeWireCaller({ apps: [app] }).call<AppInfo>("gateway/get_app", {
      appId: app.id,
    });

    expect(info.id).toBe(app.id);
    expect(info.title).toBe("Ernesto");

    await gateway.close();
  });

  it("omits the keys when the app declares no display identity", async () => {
    // Absent, not `null`: a client falls back to `id` on presence rather than on a
    // sentinel, and an app that never faces a person needs no title at all.
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    const info = await fakeWireCaller({ apps: [app] }).call<AppInfo>("gateway/get_app", {
      appId: app.id,
    });

    expect(info).toEqual({ id: app.id });

    await gateway.close();
  });
});

describe("SessionEntry projection — a thread list can label its rows", () => {
  it("carries the thread's title and description through both session methods", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions({ title: "Ernesto" }),
    });
    const session = await app.createSession({
      title: "Kitchen reno costs",
      description: "Job 4471 overrun",
      // `eager` so the durable record exists to project (lazy genesis otherwise
      // defers the write to the first mutation).
      eager: true,
    });
    const wire = fakeWireCaller({ apps: [app] });

    const entry = await wire.call<SessionEntry>("app/get_session", {
      appId: app.id,
      sessionId: session.id,
    });
    expect(entry.title).toBe("Kitchen reno costs");
    expect(entry.description).toBe("Job 4471 overrun");
    // The pre-existing fields survive the widening.
    expect(entry.id).toBe(session.id);
    expect(entry.status).toBeDefined();

    const list = await wire.call<{ sessions: readonly SessionEntry[] }>("app/list_sessions", {
      appId: app.id,
    });
    expect(list.sessions.map((s) => s.title)).toEqual(["Kitchen reno costs"]);

    await gateway.close();
  });

  it("lists the conversations — a fork is one, a thread and a worker are not", async () => {
    // ADR 100 law 2, and what the deleted `root: true` filter got wrong: it read
    // "has no parent", so a FORK of a conversation — which has a `from` and is
    // every bit a conversation — fell out of the list beside the sub-agent
    // working sessions it was meant to hide.
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions({ title: "Ernesto" }),
    });
    const source = await app.createSession({ title: "a real conversation", eager: true });
    const at = (entryId: string) => ({ sessionId: source.id, entryId, inherited: true });
    await app.createSession({
      title: "the same conversation, a new direction",
      from: { ...at("e1"), anchored: false },
      eager: true,
    });
    await app.createSession({
      title: "a side-thread on an entry",
      from: { ...at("e1"), anchored: true },
      eager: true,
    });
    await app.createSession({
      title: "the analyst's own work",
      from: { sessionId: source.id, entryId: "e1", inherited: false, anchored: false },
      internal: true,
      eager: true,
    });
    const wire = fakeWireCaller({ apps: [app] });

    const conversations = await wire.call<{ sessions: readonly SessionEntry[] }>(
      "app/list_sessions",
      { appId: app.id, filter: { internal: false, anchored: false } },
    );
    expect(conversations.sessions.map((session) => session.title).sort()).toEqual([
      "a real conversation",
      "the same conversation, a new direction",
    ]);

    // Unfiltered, a client can still tell every row apart — the projection
    // carries the whole bag plus the disposition, which is exactly what the
    // vocabulary folds from.
    const all = await wire.call<{ sessions: readonly SessionEntry[] }>("app/list_sessions", {
      appId: app.id,
    });
    expect(new Map(all.sessions.map((session) => [session.title, relation(session)]))).toEqual(
      new Map([
        ["a real conversation", "conversation"],
        ["the same conversation, a new direction", "fork"],
        ["a side-thread on an entry", "reply"],
        ["the analyst's own work", "worker"],
      ]),
    );

    // The other half of the graph: everything branched from one session, which is
    // what a thread view asks for once a conversation is open.
    const branches = await wire.call<{ sessions: readonly SessionEntry[] }>("app/list_sessions", {
      appId: app.id,
      filter: { fromSessionId: source.id },
    });
    expect(branches.sessions).toHaveLength(3);
    expect(branches.sessions.every((session) => session.from?.sessionId === source.id)).toBe(true);

    await gateway.close();
  });

  it("omits them for a thread that has none", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const session = await app.createSession({ eager: true });

    const entry = await fakeWireCaller({ apps: [app] }).call<SessionEntry>("app/get_session", {
      appId: app.id,
      sessionId: session.id,
    });

    expect("title" in entry).toBe(false);
    expect("description" in entry).toBe(false);

    await gateway.close();
  });
});
