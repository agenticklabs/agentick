/**
 * Sending into a session the reaper paged out — end to end.
 *
 * `sessions: { maxActive, idleTimeout }` bounds how many sessions stay mounted.
 * Every client that holds a thread id therefore eventually addresses a session
 * that is not live, and the wire used to answer `SessionNotFoundError`: the
 * memory bound was visible to users as data loss. A `session/send` now REMOUNTS
 * the conversation and runs the turn.
 *
 * The line drawn here — and the reason this file also tests what does NOT
 * happen — is that only the verbs which DO work on a session's behalf may
 * remount one. Observation (`sub/subscribe`) must not, or a reconnecting UI
 * would page every thread it renders back in and there would be no bound left.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  SESSION_STATUS_CHANNEL,
  SessionNotFoundError,
  channelEventQuery,
  type ContentBlock,
  type SessionStatusFrame,
  type SubscriptionScope,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

const APP_ID = "resume-app";

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("resume-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "still here" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: APP_ID,
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      // One live session at a time: opening a second pages the first out.
      sessions: { maxActive: 1 },
    },
  });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    app,
    client,
    gateway,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

const say = (text: string) => ({ messages: [{ role: "user" as const, content: text }] });

/** Open `keep`, then page it out by opening a second session. */
async function pageOut(
  app: Awaited<ReturnType<typeof makeStack>>["app"],
  keep: string,
  filler: string,
): Promise<void> {
  await app.createSession({ sessionId: keep, eager: true });
  await app.createSession({ sessionId: filler });
  expect(app.getSession(keep)).toBeUndefined();
}

describe("session/send remounts a paged-out session", () => {
  it("runs the turn instead of answering SessionNotFound", async () => {
    const { app, client, cleanup } = await makeStack();
    await pageOut(app, "alpha", "beta");

    const result = await client.session("alpha").send(say("are you there?")).result;

    expect(result.output[0]).toMatchObject({ type: "text", text: "still here" });
    expect(app.getSession("alpha")).toBeDefined();

    await cleanup();
  });

  it("collapses two concurrent sends onto ONE remount", async () => {
    const { app, client, cleanup } = await makeStack();

    let constructions = 0;
    app.onSessionCreate(async (input) => {
      if (input.sessionId === "alpha") constructions++;
    });

    await pageOut(app, "alpha", "beta");
    expect(constructions).toBe(1);

    const both = await Promise.all([
      client.session("alpha").send(say("one")).result,
      client.session("alpha").send(say("two")).result,
    ]);

    expect(both).toHaveLength(2);
    expect(constructions).toBe(2); // the pair remounted once between them

    await cleanup();
  });

  it("still refuses an id that was never a session", async () => {
    const { client, cleanup } = await makeStack();

    await expect(
      client.request("session/send", { sessionId: "ghost", ...say("hello") }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    await cleanup();
  });
});

describe("the status channel narrates the page-out", () => {
  it("reports hibernated on the way down and running again on the way back", async () => {
    const { app, gateway, cleanup } = await makeStack();

    const transport = inProcessTransport({ gateway });
    await transport.connect();

    await app.createSession({ sessionId: "alpha", eager: true });
    const scope: SubscriptionScope = { kind: "session", id: "alpha" };
    const stream = transport.subscribe(scope, channelEventQuery(SESSION_STATUS_CHANNEL));

    const seen: SessionStatusFrame[] = [];
    void (async () => {
      for await (const event of stream) seen.push(event.envelope.payload as SessionStatusFrame);
    })();
    await waitFor(() => seen.length > 0, { description: "the opening frame" });

    await app.createSession({ sessionId: "beta" }); // pages alpha out
    await waitFor(() => seen.some((f) => f.status === "hibernated"), {
      description: "the page-out frame",
    });

    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();
    await client.session("alpha").send(say("wake up")).result;
    await client.close();

    // Hibernated, then alive again — the durable record agrees.
    expect(seen.map((f) => f.status)).toContain("hibernated");
    expect(seen.filter((f) => f.status === "running")).not.toHaveLength(0);
    expect((await app.getSessionRecord("alpha"))?.status).toBe("idle");

    await transport.close();
    await cleanup();
  });
});

describe("observation does NOT remount", () => {
  it("refuses a subscription to a paged-out session and leaves it paged out", async () => {
    const { app, gateway, cleanup } = await makeStack();
    await pageOut(app, "alpha", "beta");

    const transport = inProcessTransport({ gateway });
    await transport.connect();

    await expect(
      transport.request("sub/subscribe", {
        subscriptionId: "sub-1",
        scope: { kind: "session", id: "alpha" },
      }),
    ).rejects.toThrow(/session alpha not found/);
    expect(app.getSession("alpha")).toBeUndefined();

    await transport.close();
    await cleanup();
  });
});

describe("session/close goes through the owning app", () => {
  it("leaves no registry entry, so reopening the id yields a LIVE session", async () => {
    const { app, client, cleanup } = await makeStack();
    const dead = await app.createSession({ sessionId: "alpha" });

    await client.request("session/close", { sessionId: "alpha" });

    // POSITIVE CONTROL: the wire used to call `sess.close()` directly, which
    // left the app holding the closed harness — `createSession` with the same
    // id handed that corpse back and every verb on it threw.
    expect(app.getSession("alpha")).toBeUndefined();
    const fresh = await app.createSession({ sessionId: "alpha" });
    expect(fresh === dead).toBe(false);
    expect(fresh.status).toBe("idle");

    const result = await client.session("alpha").send(say("hello again")).result;
    expect(result.output[0]).toMatchObject({ type: "text", text: "still here" });

    await cleanup();
  });
});
