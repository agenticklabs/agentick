/**
 * "Which of my threads is running right now?" — end to end.
 *
 * Two consumers, one fact. A chat panel that RELOADS mid-turn holds a fresh
 * `SessionHandle` and must learn from it that the conversation is still
 * executing; a thread LIST holds no handles at all and must see every row go
 * busy and idle without polling. Both are served by the same
 * `session:channel:status` publish — the panel through a session-scoped
 * subscription (which the server opens with the current status), the list
 * through a gateway-scoped one seeded by `list_sessions`.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  sessionStatusEventQuery,
  type ClientProtocol,
  type ContentBlock,
  type SessionStatusFrame,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

async function makeStack(holdUntil: Promise<void>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("status-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "done" } satisfies ContentBlock],
          stopReason: "end",
        },
        holdUntil,
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "status-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  // `eager` so the durable record — and its `status` — is enumerable before the
  // first send: the thread list's SEED comes from `list_sessions`.
  const session = await app.createSession({ sessionId: "status-session", eager: true });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();
  return {
    client,
    session,
    cleanup: async () => (await client.close(), await gateway.close()),
  };
}

/**
 * Block until the durable record says the turn started — the ENUMERATE half of
 * the pair, used here as the barrier so the assertions below are unambiguously
 * about a session that is already running.
 */
async function untilRunning(client: ClientProtocol, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await client.app("status-app").getSession(sessionId)).status === "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${sessionId} never reached "running"`);
}

/** A held turn: resolve the returned `release` to let the model call finish. */
function heldTurn() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { held, release: () => release() };
}

describe("a client attaching MID-EXECUTION learns the session is running", () => {
  it("seeds from the subscription's opening frame, then sees running → idle", async () => {
    const { held, release } = heldTurn();
    const { client, session, cleanup } = await makeStack(held);

    // `stream: false` so the fake's scripted hold applies to the model call —
    // the turn cannot finish until `release()`, so everything below is
    // genuinely mid-execution.
    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await untilRunning(client, "status-session");

    // A FRESH handle, as a reloaded page would build. Before this change it had
    // no status surface at all and rendered a busy session as idle.
    const handle = client.session("status-session");
    const seen: SessionStatusFrame[] = [];
    handle.status.onChange((f) => seen.push(f));

    await waitFor(() => handle.status.get() !== undefined, { description: "the seed frame" });
    expect(handle.status.get()).toBe("running");
    // The seed names the turn already under way, so the panel can correlate.
    expect(seen[0]!.executionId).toMatch(/^exec:/);

    release();
    await turn;
    await waitFor(() => handle.status.get() === "idle", { description: "the turn to end" });
    expect(seen.map((f) => f.status)).toEqual(["running", "idle"]);

    await handle.close();
    await cleanup();
  });

  it("create_session is create-OR-RESUME, and says which state it resumed into", async () => {
    const { held, release } = heldTurn();
    const { client, session, cleanup } = await makeStack(held);

    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await untilRunning(client, "status-session");

    // Re-creating an id the app already holds RESUMES it. Answering with only
    // `{ sessionId }` told a reconnecting client nothing about the turn it was
    // walking back into.
    const resumed = await client.app("status-app").createSession({ sessionId: "status-session" });
    expect(resumed).toEqual({ sessionId: "status-session", status: "running" });

    release();
    await turn;
    await cleanup();
  });
});

describe("a thread list sees every session, including ones it holds no handle for", () => {
  it("seeds rows from list_sessions and updates them from a gateway-scoped subscription", async () => {
    const { held, release } = heldTurn();
    const { client, session, cleanup } = await makeStack(held);

    // SUBSCRIBE FIRST, then seed: the reverse order has a window in which a
    // transition lands between the list read and the first frame.
    const stream = client.gateway().events(sessionStatusEventQuery());
    const rows = new Map<string, string>();
    const frames: SessionStatusFrame[] = [];
    void (async () => {
      for await (const { envelope } of stream) {
        const frame = envelope.payload as SessionStatusFrame;
        frames.push(frame);
        rows.set(frame.sessionId, frame.status);
      }
    })();

    const listed = await client.gateway().listSessions();
    for (const entry of listed.sessions) rows.set(entry.id, entry.status);
    expect(rows.get("status-session")).toBe("idle");

    // No `client.session(...)` anywhere: the row updates without a handle.
    const turn = session.send({ messages: [{ role: "user", content: "hi" }], stream: false });
    await waitFor(() => rows.get("status-session") === "running", {
      description: "the row to go busy",
    });

    release();
    await turn;
    await waitFor(() => rows.get("status-session") === "idle", {
      description: "the row to go idle",
    });

    // Enumerate and notify agree — one fact, two doors.
    const after = await client.gateway().listSessions();
    expect(after.sessions.find((s) => s.id === "status-session")?.status).toBe("idle");

    // The same stream is enough to raise a toast: the ending rides the frame
    // that ends the run, and only that one.
    expect(frames.map((f) => [f.status, f.outcome])).toEqual([
      ["running", undefined],
      ["idle", "succeeded"],
    ]);

    await stream.close();
    await cleanup();
  });
});
