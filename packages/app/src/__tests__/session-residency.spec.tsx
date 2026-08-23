/**
 * Session residency — what happens to a session between "live" and "gone".
 *
 * The reaper (`sessions: { maxActive, idleTimeout }`) evicts sessions to bound
 * memory. That is only safe if the three facts below hold, and none of them did:
 *
 *   1. An evicted session can be brought BACK by id (`resumeSession`) — from
 *      the durable record plus the per-harness stores, which is the only
 *      source there is.
 *   2. An eviction is recorded as `hibernated`, not `closed`. The durable record
 *      is the truth a thread list renders and the store's prune sweep reads; a
 *      dormant session must not look ended, and must not be garbage-collected.
 *   3. Ending a session through the app door (`closeSession`) actually removes
 *      it, so reopening the id yields a LIVE session rather than the corpse.
 *   4. Process shutdown is a page-out, not an ending: `closeApp` hibernates
 *      what it was hosting, so the next process resumes it. `closed` is
 *      terminal for the resume door, so only explicit intent may stamp it —
 *      otherwise every deploy silently ends whatever was mounted.
 *
 * Real app / session / compiler throughout — only the model executor is a fake.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { createKnobStore } from "@agentick/knobs";
import { InMemorySessionStore } from "@agentick/session";
import { MemoryTimelineStore } from "@agentick/timeline";
import type { CreateSessionInput, ExecutionTarget } from "@agentick/spec";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

function plainScript(text = "ok") {
  return [
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "text" as const, text }],
        stopReason: "end" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  ];
}

function PlainAgent(): React.ReactElement {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

async function mkSubstrate(name: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(name, journal, bus, inbox, {
    scripted: plainScript(),
  });
  await executor.ready;
  return { journal, bus, inbox, executor };
}

/** The durable half of a session — shared between apps to model a restart. */
interface Stores {
  readonly sessionStore?: InMemorySessionStore;
  readonly timelineStore?: MemoryTimelineStore;
  readonly knobStore?: ReturnType<typeof createKnobStore>;
}

/** An app with a one-session live cap and its own durable stores. */
async function mkApp(name: string, stores: Stores = {}) {
  const sessionStore = stores.sessionStore ?? new InMemorySessionStore();
  const { journal, bus, inbox, executor } = await mkSubstrate(name);
  const app = await createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    journal,
    bus,
    inbox,
    sessions: { maxActive: 1, store: sessionStore },
    timeline: { store: stores.timelineStore ?? new MemoryTimelineStore() },
    knobs: { store: stores.knobStore ?? createKnobStore() },
  });
  return { app, sessionStore };
}

const say = (text: string) => ({ messages: [{ role: "user" as const, content: text }] });

// ===========================================================================
// Page-out is recorded as hibernation
// ===========================================================================

describe("an evicted session is hibernated, not closed", () => {
  it("stamps `hibernated` on eviction and `closed` on a genuine close", async () => {
    const { app } = await mkApp("residency-status");

    await app.createSession({ sessionId: "evicted", eager: true });
    // Over the cap → the LRU victim is evicted.
    await app.createSession({ sessionId: "closed", eager: true });
    expect(app.getSession("evicted")).toBeUndefined();

    expect((await app.getSessionRecord("evicted"))?.status).toBe("hibernated");

    await app.closeSession("closed");
    expect((await app.getSessionRecord("closed"))?.status).toBe("closed");

    await app.closeApp();
    // Shutdown does not revise a session somebody actually ended.
    expect((await app.getSessionRecord("closed"))?.status).toBe("closed");
  });

  it("keeps a hibernated record out of the store's prune sweep", async () => {
    const store = new InMemorySessionStore();
    const { app } = await mkApp("residency-prune", { sessionStore: store });

    await app.createSession({ sessionId: "dormant", eager: true });
    await app.createSession({ sessionId: "ended", eager: true }); // evicts `dormant`
    await app.closeSession("ended");

    // A cutoff in the future makes every record old enough — so what survives
    // is decided by status alone.
    await store.prune(Date.now() + 60_000, {});

    expect((await store.get("dormant", {}))?.status).toBe("hibernated");
    expect(await store.get("ended", {})).toBeUndefined();

    await app.closeApp();
  });
});

// ===========================================================================
// Resume
// ===========================================================================

describe("resumeSession brings an evicted session back", () => {
  it("remounts it live, idle, and able to run another turn", async () => {
    const { app } = await mkApp("residency-resume");

    const first = await app.createSession({ sessionId: "A" });
    await (
      await first.send(say("hi"))
    ).result;
    await app.createSession({ sessionId: "B" }); // evicts A
    expect(app.getSession("A")).toBeUndefined();

    const resumed = await app.resumeSession("A");
    expect(resumed).toBeDefined();
    expect(app.getSession("A") === resumed).toBe(true);
    expect(resumed!.status).toBe("idle");

    const res = await (await resumed!.send(say("again"))).result;
    expect(res.response).toContain("ok");

    // The durable record is the SAME session's, carried across the eviction:
    // two turns, not a fresh conversation.
    expect((await app.getSessionRecord("A"))?.executionCount).toBe(2);

    await app.closeApp();
  });

  it("reads identity back off the RECORD; the scope ceiling does not survive", async () => {
    const { app } = await mkApp("residency-identity");

    await app.createSession({
      sessionId: "owned",
      principal: "user-1",
      requiredScopes: ["tenant:acme"],
      metadata: { thread: "t-9" },
    });
    await app.createSession({ sessionId: "other" }); // evicts `owned`

    const resumed = await app.resumeSession("owned");
    expect(resumed).toBeDefined();
    // Build-call durability (checkpointing §4): the serializable half of the
    // create call — id, principal, metadata — persists on the record and is
    // read back; everything else re-derives from the app recipe.
    expect(resumed!.principal).toBe("user-1");
    expect((await app.getSessionRecord("owned"))?.metadata).toMatchObject({ thread: "t-9" });
    expect((await app.getSessionRecord("owned"))?.principal).toBe("user-1");
    // The scope ceiling is construction-bound and nothing persists it, so a
    // rebuilt session does NOT carry it. The wire dispatch gate authorizes off
    // the record's principal (`findRecordPrincipal`), not this field.
    expect((resumed as { requiredScopes?: readonly string[] }).requiredScopes).toBeUndefined();

    await app.closeApp();
  });

  it("single-flights concurrent resumes of one id onto ONE construction AND one op", async () => {
    const { app } = await mkApp("residency-single-flight");

    let constructions = 0;
    app.onSessionCreate(async (input: CreateSessionInput) => {
      if (input.sessionId === "A") constructions++;
    });
    // The around-form is the truthy resume signal (README gotcha), so a reader
    // fan-out joining one op must fire it ONCE — hook firings ≡ rebuilds, and a
    // dashboard counting resumes is not inflated by how many verbs asked.
    let resumes = 0;
    app.hook({
      onAppResumeSession: async (
        input: { sessionId: string },
        next: (i: { sessionId: string }) => Promise<unknown>,
      ) => {
        const session = await next(input);
        if (session !== undefined) resumes++;
        return session;
      },
    });

    await app.createSession({ sessionId: "A" });
    expect(constructions).toBe(1);
    await app.createSession({ sessionId: "B" }); // evicts A

    const [one, two, three] = await Promise.all([
      app.resumeSession("A"),
      app.resumeSession("A"),
      app.resumeSession("A"),
    ]);
    expect(one === two && two === three).toBe(true);
    expect(constructions).toBe(2); // the resume built once, not thrice
    expect(resumes).toBe(1); // ...and ran ONE op: joiners share it

    await app.closeApp();
  });

  it("resumes from a record written by a PREVIOUS process", async () => {
    // The cross-restart shape — and, since the paged tier is gone, structurally
    // the same path an evict→resume takes: the store is the resume index, and
    // the app rebuilds from its own recipe.
    const store = new InMemorySessionStore();
    const now = Date.now();
    await store.put(
      {
        id: "from-record",
        createdAt: now,
        updatedAt: now,
        status: "hibernated",
        executionCount: 3,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        principal: "user-7",
      },
      {},
    );
    const { app } = await mkApp("residency-record", { sessionStore: store });

    const resumed = await app.resumeSession("from-record");
    expect(resumed).toBeDefined();
    expect(resumed!.status).toBe("idle");
    // Hydration adopted the record rather than overwriting it with a blank one.
    const record = await app.getSessionRecord("from-record");
    expect(record?.executionCount).toBe(3);
    expect(record?.principal).toBe("user-7");

    await app.closeApp();
  });

  it("refuses to resume an id it has never seen, or one that is over", async () => {
    const { app } = await mkApp("residency-refuse");

    expect(await app.resumeSession("never-existed")).toBeUndefined();

    const s = await app.createSession({ sessionId: "ended", eager: true });
    void s;
    await app.closeSession("ended");
    expect(await app.resumeSession("ended")).toBeUndefined();

    await app.closeApp();
  });

  it("does not resurrect a session the reaper merely collected", async () => {
    // The LRU sweep can reach a session whose harness was closed directly — a
    // corpse still holding a registry slot. Paging that out must not record it
    // as resumable, or the reaper hands back a session somebody ended.
    const { app } = await mkApp("residency-corpse");

    const dead = await app.createSession({ sessionId: "gone" });
    await dead.close();
    await app.createSession({ sessionId: "live" }); // the sweep collects `gone`

    expect(app.getSession("gone")).toBeUndefined();
    expect(await app.resumeSession("gone")).toBeUndefined();

    await app.closeApp();
  });

  it("does not resurrect a destroyed session", async () => {
    const { app } = await mkApp("residency-destroy");

    await app.createSession({ sessionId: "doomed", eager: true });
    await app.createSession({ sessionId: "keeper" }); // evicts `doomed`
    await app.destroySession("doomed");

    expect(await app.resumeSession("doomed")).toBeUndefined();

    await app.closeApp();
  });
});

// ===========================================================================
// Close through the app door
// ===========================================================================

describe("closeSession leaves nothing behind", () => {
  it("drops the live registry entry, so reopening the id yields a LIVE session", async () => {
    const { app } = await mkApp("residency-close");

    const dead = await app.createSession({ sessionId: "reopened" });
    await app.closeSession("reopened");
    expect(app.getSession("reopened")).toBeUndefined();

    const fresh = await app.createSession({ sessionId: "reopened" });
    expect(fresh === dead).toBe(false);
    expect(fresh.status).toBe("idle");
    expect((await (await fresh.send(say("hi"))).result).response).toContain("ok");

    await app.closeApp();
  });

  it("recovers from a session closed BEHIND the app's back", async () => {
    // POSITIVE CONTROL for the registry leak: `session.close()` ends the
    // session without telling the app, which used to leave the entry in place —
    // `createSession` with that id then handed back the closed harness, whose
    // every verb throws. The reopen must produce a live replacement instead.
    const { app } = await mkApp("residency-direct-close");

    const dead = await app.createSession({ sessionId: "direct" });
    await dead.close();
    expect(dead.status).toBe("closed");

    const fresh = await app.createSession({ sessionId: "direct" });
    expect(fresh === dead).toBe(false);
    expect(fresh.status).toBe("idle");
    expect((await (await fresh.send(say("hi"))).result).response).toContain("ok");

    await app.closeApp();
  });

  it("survives the app shutdown that follows it", async () => {
    // Explicit intent is the ONLY thing that stamps `closed`, and shutdown must
    // not weaken it either: a session ended before the process went down is
    // still ended when it comes back up.
    const store = new InMemorySessionStore();
    const { app } = await mkApp("residency-close-then-shutdown", { sessionStore: store });

    await app.createSession({ sessionId: "hungup", eager: true });
    await app.closeSession("hungup");
    await app.closeApp();

    expect((await store.get("hungup", {}))?.status).toBe("closed");

    const { app: next } = await mkApp("residency-close-then-shutdown-2", { sessionStore: store });
    expect(await next.resumeSession("hungup")).toBeUndefined();
    await next.closeApp();
  });

  it("ends an evicted session without bringing it back", async () => {
    const { app } = await mkApp("residency-close-evicted");

    await app.createSession({ sessionId: "dormant", eager: true });
    await app.createSession({ sessionId: "other" }); // evicts `dormant`

    await app.closeSession("dormant");

    expect(app.getSession("dormant")).toBeUndefined(); // no remount happened
    expect((await app.getSessionRecord("dormant"))?.status).toBe("closed");
    expect(await app.resumeSession("dormant")).toBeUndefined();

    await app.closeApp();
  });
});

// ===========================================================================
// Process shutdown
// ===========================================================================

describe("app shutdown hibernates its live sessions", () => {
  it("stamps `hibernated`, and the next process resumes and runs a turn", async () => {
    // The production defect: `closeApp` drained its registry through the
    // genuine-close path, so every deploy stamped whatever was mounted
    // `closed` — terminal for the resume door — and the thread rendered empty
    // over intact timeline data.
    const stores = {
      sessionStore: new InMemorySessionStore(),
      timelineStore: new MemoryTimelineStore(),
      knobStore: createKnobStore(),
    };
    const { app } = await mkApp("shutdown-first", stores);

    const s = await app.createSession({ sessionId: "mounted" });
    await (
      await s.send(say("REMEMBER-4"))
    ).result;
    await s.knobs.set({ id: "verbose", value: true });

    await app.closeApp();
    expect((await stores.sessionStore.get("mounted", {}))?.status).toBe("hibernated");

    const { app: next } = await mkApp("shutdown-second", stores);
    const resumed = await next.resumeSession("mounted");
    expect(resumed).toBeDefined();
    expect(JSON.stringify(resumed!.timeline.read().entries)).toContain("REMEMBER-4");
    // Shutdown runs the same `session:snapshot` eviction does, so the
    // write-behind cells land too — not just the timeline flush close carries.
    expect(resumed!.knobs.get("verbose")).toBe(true);
    expect((await (await resumed!.send(say("again"))).result).response).toContain("ok");

    await next.closeApp();
  });

  it("still fires `onSessionClose` — the record hibernates, the handler runs", async () => {
    // The doctrine is about the DURABLE record, not the in-process
    // notification: the adopter asked for this teardown, and their handler is
    // the last moment they get before the process leaves.
    const store = new InMemorySessionStore();
    const { app } = await mkApp("shutdown-handlers", { sessionStore: store });
    const seen: string[] = [];
    app.onSessionClose(({ sessionId }: { sessionId: string }) => {
      seen.push(sessionId);
    });

    await app.createSession({ sessionId: "paged", eager: true });
    await app.closeApp();

    expect(seen).toEqual(["paged"]);
    expect((await store.get("paged", {}))?.status).toBe("hibernated");
  });
});
