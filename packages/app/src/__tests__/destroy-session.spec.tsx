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
  });
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
    await app.createSession({ sessionId: "solo" });

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
    const session = await app.createSession({ sessionId: "closed-not-gone" });
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
