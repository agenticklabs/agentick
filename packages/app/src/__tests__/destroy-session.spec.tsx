/**
 * `app.destroySession` — the strongest-form, TRANSITIVE session removal, and
 * the deliberate contrast with `close()`.
 *
 * `close()` is the gentle verb: the thread ends, its durable `SessionRecord`
 * survives as history, and its DETACHED tasks keep running (ADR 68). Destroy is
 * the other end of the pair, and each half of that is pinned here:
 *
 *   1. in-flight executions abort TRANSITIVELY — a grandchild blocked mid-tool
 *      is torn down, which `session.abort()` alone cannot do (it reaches only
 *      the session's own current handle);
 *   2. the live spawn subtree leaves the registry;
 *   3. detached tasks are CANCELLED — and the same setup under plain `close()`
 *      leaves them running, so the two verbs are pinned against each other;
 *   4. the durable record is deleted, exactly once, by id;
 *   5. a second destroy of the same id is a success reporting `found: false` —
 *      silence, not a fault.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { InMemorySessionStore } from "@agentick/session";
import { MemoryTimelineStore } from "@agentick/timeline";
import { createKnobStore } from "@agentick/knobs";
import { createStateStore } from "@agentick/state";
import { stubStoreCtx } from "@agentick/store";
import type {
  ExecutionTarget,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionStore,
  StoreCtx,
  ToolHandler,
} from "@agentick/spec";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function PlainAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "Be helpful."),
  );
}

function GatedAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "Be helpful."),
    React.createElement("tool" as never, {
      id: "t.gate",
      name: "gate",
      description: "Blocks until the dispatch is aborted",
      inputSchema: { type: "object", properties: {} },
      exposure: ["model"],
      handlerRef: "handlers/gate",
    }),
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

const gateScript = [
  {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "tool_use" as const, toolUseId: "tc-1", name: "gate", input: {} }],
      stopReason: "tool_use" as const,
      toolCalls: [{ id: "tc-1", name: "gate", input: {} }],
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    },
  },
  {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "text" as const, text: "GATE-DONE" }],
      stopReason: "end" as const,
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    },
  },
];

/**
 * A tool that parks until its dispatch signal aborts. Abort-driven rather than
 * released by the test, so the mid-flight window is deterministic: the session
 * is provably in-flight right up to the moment destroy's abort lands.
 */
function gateHandlers(entered: () => void): Map<string, ToolHandler> {
  return new Map<string, ToolHandler>([
    [
      "handlers/gate",
      async (_input, { ctx }) => {
        entered();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [{ type: "text", text: "gate released" }];
      },
    ],
  ]);
}

/** The bundled store, recording every `delete` call in order. */
class DeleteRecordingSessionStore extends InMemorySessionStore {
  readonly deletes: string[] = [];
  override delete(id: string, ctx: StoreCtx): Promise<void> {
    this.deletes.push(id);
    return super.delete(id, ctx);
  }
}

async function mkApp(
  opts: {
    agent?: React.ReactElement;
    toolHandlers?: Map<string, ToolHandler>;
    sessionStore?: SessionStore;
    stores?: DurableStores;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("destroy-exec", journal, bus, inbox, {
    scripted: gateScript,
  });
  await executor.ready;
  return createApp(opts.agent ?? React.createElement(PlainAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    ...(opts.toolHandlers !== undefined ? { toolHandlers: opts.toolHandlers } : {}),
    ...(opts.sessionStore !== undefined ? { sessions: { store: opts.sessionStore } } : {}),
    ...(opts.stores !== undefined
      ? {
          timeline: { store: opts.stores.timeline },
          knobs: { store: opts.stores.knobs },
          state: { store: opts.stores.state },
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Durable scopes — the stores destroy has to free (checkpointing §6)
// ---------------------------------------------------------------------------

interface DurableStores {
  readonly timeline: MemoryTimelineStore;
  readonly knobs: ReturnType<typeof createKnobStore>;
  readonly state: ReturnType<typeof createStateStore>;
}

/**
 * The stores injected into the app under test. Injected rather than reached for
 * through the app, because the pins below read them DIRECTLY: a scope is freed
 * only if the store that holds it says so.
 */
function mkStores(): DurableStores {
  return {
    timeline: new MemoryTimelineStore(),
    knobs: createKnobStore(),
    state: createStateStore(),
  };
}

/** Everything the three stores hold for one session id, across all its scopes. */
async function residueFor(stores: DurableStores, sessionId: string) {
  const ctx = stubStoreCtx();
  return {
    timeline: await stores.timeline.read(`${sessionId}:timeline`, ctx),
    knobs: await stores.knobs.query({ scope: `${sessionId}:knobs` }, ctx),
    state: await stores.state.query({ scope: `${sessionId}:state` }, ctx),
  };
}

/** Write one entry into every durable scope a session owns, then flush. */
async function fillScopes(session: SessionHarnessProtocol, marker: string): Promise<void> {
  await session.timeline.append({
    kind: "message",
    message: { id: `${marker}-m`, role: "user", content: [{ type: "text", text: marker }], ts: 0 },
  } as never);
  await session.knobs.set({ id: "secret", value: marker });
  await session.state.set({ key: "secret", value: marker });
  await session.snapshot();
}

/** Narrow the spawn() union: no `send` supplied → a `SessionHarnessProtocol`. */
function asSession(x: SessionExecutionHandle | SessionHarnessProtocol): SessionHarnessProtocol {
  return x as SessionHarnessProtocol;
}
/** Narrow the spawn() union: `send` supplied → a `SessionExecutionHandle`. */
function asHandle(x: SessionExecutionHandle | SessionHarnessProtocol): SessionExecutionHandle {
  return x as SessionExecutionHandle;
}

// ---------------------------------------------------------------------------
// 1 + 2 — transitive abort and subtree disposal
// ---------------------------------------------------------------------------

describe("app.destroySession — the live plane", () => {
  it("aborts a held mid-flight execution two levels deep and disposes the subtree", async () => {
    let entered!: () => void;
    const started = new Promise<void>((res) => {
      entered = res;
    });
    const app = await mkApp({
      agent: React.createElement(GatedAgent),
      toolHandlers: gateHandlers(() => entered()),
    });

    const root = asSession(await app.createSession({ sessionId: "root" }));
    const child = asSession(
      await root.spawn({ agent: React.createElement(GatedAgent), sessionId: "child" }),
    );
    // The grandchild — TWO levels below the destroy target — is the one holding
    // live work. Nothing the parent does to its own handle reaches it.
    const handle = asHandle(
      await child.spawn({
        agent: React.createElement(GatedAgent),
        sessionId: "grand",
        send: { messages: [{ role: "user", content: "go" }] },
      }),
    );
    await started; // grandchild is parked inside the gate tool

    const result = await app.destroySession("root", { reason: "destroyed by test" });

    // The grandchild's execution was aborted, not left to finish: the second
    // scripted tick (GATE-DONE) never ran.
    const exec = await handle.result;
    expect(exec.stopReason).toBe("aborted");
    expect(exec.response ?? "").not.toContain("GATE-DONE");

    expect(result.sessionId).toBe("root");
    expect(result.live.found).toBe(true);
    expect(result.live.abortedExecutions).toBe(1);
    expect(result.live.disposedDescendants).toBe(2);

    // Whole subtree is out of the live registry.
    expect(app.getSession("root")).toBeUndefined();
    expect(app.getSession("child")).toBeUndefined();
    expect(app.getSession("grand")).toBeUndefined();

    await app.closeApp();
  });

  it("is idempotent — a second destroy reports found:false / existed:false", async () => {
    const app = await mkApp();
    // `eager` earns the record at creation — persistence is otherwise
    // execution's to trigger, and this test is about the record plane.
    await app.createSession({ sessionId: "solo", eager: true });

    const first = await app.destroySession("solo");
    expect(first.live.found).toBe(true);
    expect(first.record.existed).toBe(true);

    const second = await app.destroySession("solo");
    expect(second).toEqual({
      sessionId: "solo",
      live: {
        found: false,
        abortedExecutions: 0,
        disposedDescendants: 0,
        cancelledDetachedTasks: 0,
      },
      record: { existed: false },
    });

    // An id that never existed behaves identically — silence, not a fault.
    const never = await app.destroySession("never-was");
    expect(never.live.found).toBe(false);
    expect(never.record.existed).toBe(false);

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// 4 — the durable record
// ---------------------------------------------------------------------------

describe("app.destroySession — the durable record", () => {
  it("calls SessionStore.delete exactly once, with the destroyed id", async () => {
    const store = new DeleteRecordingSessionStore();
    const app = await mkApp({ sessionStore: store });
    // `eager` so the durable rows exist before destroy (lazy genesis would
    // otherwise leave an unsent session unpersisted) — this test is the delete verb.
    await app.createSession({ sessionId: "doomed", eager: true });
    await app.createSession({ sessionId: "bystander", eager: true });

    expect((await app.getSessionRecord("doomed"))?.id).toBe("doomed");

    const result = await app.destroySession("doomed");
    expect(result.record.existed).toBe(true);
    expect(store.deletes).toEqual(["doomed"]);

    // Gone from the durable store; the bystander is untouched.
    expect(await app.getSessionRecord("doomed")).toBeUndefined();
    expect((await app.getSessionRecord("bystander"))?.id).toBe("bystander");

    await app.closeApp();
  });

  it("close() leaves the record behind — destroy is the verb that deletes it", async () => {
    const app = await mkApp();
    const session = await app.createSession({ sessionId: "closed-not-gone", eager: true });
    await session.close();

    // The gentle verb: history survives on a terminal status.
    expect((await app.getSessionRecord("closed-not-gone"))?.status).toBe("closed");

    // Destroy still reaches the DURABLE record, which is the half `close()`
    // deliberately leaves standing. (`live.found` is not asserted here: a
    // directly-closed session keeps its live registry entry — only
    // `disposeSession` removes it — see the TODO on `AppHarness.getSession`.)
    const result = await app.destroySession("closed-not-gone");
    expect(result.record.existed).toBe(true);
    expect(await app.getSessionRecord("closed-not-gone")).toBeUndefined();

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// 6 — the durable SCOPES (checkpointing §6)
// ---------------------------------------------------------------------------

describe("app.destroySession — the durable scopes", () => {
  it("frees every harness scope: the stores hold nothing for the destroyed id", async () => {
    const stores = mkStores();
    const app = await mkApp({ stores });
    const doomed = await app.createSession({ sessionId: "doomed", eager: true });
    const bystander = await app.createSession({ sessionId: "bystander", eager: true });
    await fillScopes(doomed, "CLASSIFIED");
    await fillScopes(bystander, "KEPT");

    // Precondition: the data destroy is supposed to free is actually there.
    const before = await residueFor(stores, "doomed");
    expect(before.timeline.length).toBe(1);
    expect(before.knobs.length).toBe(1);
    expect(before.state.length).toBe(1);

    await app.destroySession("doomed");

    expect(await residueFor(stores, "doomed")).toEqual({ timeline: [], knobs: [], state: [] });
    // Partitioned, not wholesale: the bystander's scopes are untouched.
    const survivor = await residueFor(stores, "bystander");
    expect(survivor.timeline.length).toBe(1);
    expect(survivor.knobs.length).toBe(1);
    expect(survivor.state.length).toBe(1);

    await app.closeApp();
  });

  it("id reuse does NOT resurrect: a new session on a destroyed id opens EMPTY", async () => {
    // The privacy pin. The stores outlive the session by design, so a scope
    // left behind is a conversation the next holder of that id hydrates back.
    const stores = mkStores();
    const app = await mkApp({ stores });
    const first = await app.createSession({ sessionId: "reused", eager: true });
    await fillScopes(first, "CLASSIFIED");

    await app.destroySession("reused");

    const second = await app.createSession({ sessionId: "reused", eager: true });
    expect(second.timeline.read().entries).toEqual([]);
    expect(second.knobs.get("secret")).toBeUndefined();
    expect(second.state.get("secret")).toBeUndefined();

    await app.closeApp();
  });

  it("frees the scopes of an EVICTED session, which has no live bridges", async () => {
    // Destroy rebuilds through the same resume path a send would take — one
    // recovery path, teardown included (checkpointing §4).
    const stores = mkStores();
    const app = await mkApp({ sessionStore: new InMemorySessionStore(), stores });
    const session = await app.createSession({ sessionId: "checked-out", eager: true });
    await fillScopes(session, "CLASSIFIED");

    await app.evictSession("checked-out");
    expect(app.getSession("checked-out")).toBeUndefined();

    const result = await app.destroySession("checked-out");
    expect(result.live.found).toBe(false); // it really was out of memory
    expect(result.record.existed).toBe(true);
    expect(await residueFor(stores, "checked-out")).toEqual({
      timeline: [],
      knobs: [],
      state: [],
    });

    await app.closeApp();
  });

  it("frees a live DESCENDANT's scopes and deletes its record too", async () => {
    const stores = mkStores();
    const app = await mkApp({ sessionStore: new InMemorySessionStore(), stores });
    const root = await app.createSession({ sessionId: "sub-root", eager: true });
    const child = asSession(
      await root.spawn({ agent: React.createElement(PlainAgent), sessionId: "sub-child" }),
    );
    await fillScopes(root, "ROOT");
    await fillScopes(child, "CHILD");
    expect((await residueFor(stores, "sub-child")).timeline.length).toBe(1);
    expect(await app.getSessionRecord("sub-child")).toBeDefined();

    const result = await app.destroySession("sub-root");
    expect(result.live.disposedDescendants).toBe(1);

    expect(await residueFor(stores, "sub-child")).toEqual({ timeline: [], knobs: [], state: [] });
    expect(await app.getSessionRecord("sub-child")).toBeUndefined();

    await app.closeApp();
  });

  it("frees the scopes of a CLOSED session — the terminal record is rebuilt to be destroyed", async () => {
    // The divergence from resume, pinned: resumeSessionBody refuses terminal
    // records; destroySessionBody deliberately does not, because
    // close-then-destroy must not leak the conversation. A refactor that
    // "unifies" the two rebuild paths by adding the terminal filter here
    // reintroduces the leak with a green suite — except for this test.
    const stores = mkStores();
    const app = await mkApp({ sessionStore: new InMemorySessionStore(), stores });
    const session = await app.createSession({ sessionId: "hung-up", eager: true });
    await fillScopes(session, "TERMINAL");
    await session.close();
    expect((await residueFor(stores, "hung-up")).timeline.length).toBe(1);

    await app.destroySession("hung-up");

    expect(await residueFor(stores, "hung-up")).toEqual({ timeline: [], knobs: [], state: [] });
    await app.closeApp();
  });

  it("a failed drop fails the destroy — no deletion is reported that did not happen", async () => {
    class FailingDeleteTimelineStore extends MemoryTimelineStore {
      override delete(): Promise<never> {
        return Promise.reject(new Error("drop boom"));
      }
    }
    const stores = { ...mkStores(), timeline: new FailingDeleteTimelineStore() };
    const app = await mkApp({ sessionStore: new InMemorySessionStore(), stores });
    const session = await app.createSession({ sessionId: "undroppable", eager: true });
    await fillScopes(session, "STUCK");

    await expect(app.destroySession("undroppable")).rejects.toThrow("drop boom");

    // Record-deleted-LAST failure posture: the session is still findable and
    // re-destroyable, never an orphan scope with no record pointing at it.
    expect(app.getSession("undroppable")).toBeDefined();
    expect(await app.getSessionRecord("undroppable")).toBeDefined();
    expect((await residueFor(stores, "undroppable")).timeline.length).toBe(1);
    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// 3 — detached tasks: the close/destroy contrast
// ---------------------------------------------------------------------------

describe("app.destroySession — detached tasks (ADR 68 contrast)", () => {
  it("cancels a detached task that plain close() abandons", async () => {
    const app = await mkApp();

    // Same setup, two sessions: one closed, one destroyed. A detached task that
    // parks forever unless something cancels it.
    const abandoned = await app.createSession({ sessionId: "to-close" });
    const reaped = await app.createSession({ sessionId: "to-destroy" });

    const abandonedTask = abandoned.tasks.submit(() => new Promise<string>(() => {}), {
      detached: true,
    });
    const reapedTask = reaped.tasks.submit(() => new Promise<string>(() => {}), {
      detached: true,
    });
    // The rejection is asserted below; pre-attach so it is never unhandled.
    const reapedOutcome = reapedTask.result.then(
      () => "resolved",
      (e: { status?: string }) => e.status,
    );

    // CLOSE: the detached task is deliberately left running (ADR 68).
    await abandoned.close();
    expect(abandoned.tasks.status(abandonedTask.taskId)).toBe("working");

    // DESTROY: the same task shape is cancelled.
    const result = await app.destroySession("to-destroy", { reason: "destroyed by test" });
    expect(result.live.cancelledDetachedTasks).toBe(1);
    expect(await reapedOutcome).toBe("cancelled");
    expect(reaped.tasks.status(reapedTask.taskId)).toBe("cancelled");

    await app.closeApp();
  });
});
