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
import { SPEC_VERSION } from "@agentick/spec";
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

  it("lists ROOT sessions only when asked, and says which is which", async () => {
    // The failure this closes: a spawned child is a real session with a real durable
    // record, so a conversation list showed a sub-agent's working session beside
    // conversations the user actually had.
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions({ title: "Ernesto" }),
    });
    const parent = await app.createSession({ title: "a real conversation" });
    await app.createSession({ title: "the analyst's own work", parentSessionId: parent.id });
    const wire = fakeWireCaller({ apps: [app] });

    const all = await wire.call<{ sessions: readonly SessionEntry[] }>("app/list_sessions", {
      appId: app.id,
    });
    expect(all.sessions).toHaveLength(2);
    // Unfiltered, a client can still tell them apart — that is what nests a
    // sub-session under the turn that opened it.
    expect(all.sessions.filter((session) => session.parentSessionId !== undefined)).toHaveLength(1);

    const roots = await wire.call<{ sessions: readonly SessionEntry[] }>("app/list_sessions", {
      appId: app.id,
      filter: { root: true },
    });
    expect(roots.sessions.map((session) => session.title)).toEqual(["a real conversation"]);
    expect(roots.sessions[0]?.parentSessionId).toBeUndefined();

    await gateway.close();
  });

  it("omits them for a thread that has none", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const session = await app.createSession();

    const entry = await fakeWireCaller({ apps: [app] }).call<SessionEntry>("app/get_session", {
      appId: app.id,
      sessionId: session.id,
    });

    expect("title" in entry).toBe(false);
    expect("description" in entry).toBe(false);

    await gateway.close();
  });
});
