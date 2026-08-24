/**
 * A send the door refuses must unwind the turn it opened (#313).
 *
 * `runExecutionCore` takes its reservation synchronously (ADR 53 — a
 * concurrent send must see busy during input processing), so a refusal in the
 * pre-loop stretch (an invalid media source rejected by the input append)
 * used to escape HOLDING it: `hasInFlightExecution` stayed true forever,
 * `whenQuiescent` never resolved, shutdown hung on the drain, and a queued
 * send joined a dead turn. One bad attachment bricked the conversation AND
 * the next rolling restart.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { fakeCompiler } from "@agentick/compiler/testing";
import { createGateway } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { inProcessTransport } from "../index.js";

const REFUSED_MEDIA = {
  role: "user" as const,
  content: [
    {
      type: "image",
      // `data:`-prefixed base64 — the exact shape appendInputMessageFx refuses.
      source: { type: "base64", mimeType: "image/png", data: "data:image/png;base64,iVBOR==" },
    },
  ],
};

const say = (text: string) => ({ messages: [{ role: "user" as const, content: text }] });

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("refused", journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
      },
    },
  });
  await executor.ready;

  const gateway = await createGateway({ journal, bus, inbox });
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "refused-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler(), journal, bus, inbox },
  });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return { gateway, app, client };
}

/** `promise`, or `"hung"` after `ms` — the shape every anti-hang pin races. */
const orHung = <T>(promise: Promise<T>, ms = 3000): Promise<T | "hung"> =>
  Promise.race([promise, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

describe("a door-refused send unwinds the turn it opened", () => {
  it("leaves the session quiescent — not in flight, whenQuiescent resolves", async () => {
    const { gateway, app, client } = await makeStack();
    await app.createSession({ sessionId: "s1" });

    await expect(
      client.request("session/send", { sessionId: "s1", messages: [REFUSED_MEDIA] } as never),
    ).rejects.toThrow(/media|source/i);

    // Concrete-class surface (flushRecordWrites precedent) — the protocol
    // deliberately does not carry residency internals.
    const session = app.getSession("s1")! as unknown as {
      hasInFlightExecution: boolean;
      whenQuiescent(): Promise<void>;
    };
    expect(session.hasInFlightExecution).toBe(false);
    expect(await orHung(session.whenQuiescent().then(() => "quiescent"))).toBe("quiescent");

    await client.close();
    await gateway.close();
  });

  it("a queued send behind the refusal runs as a fresh turn — the refusal is not its error", async () => {
    const { gateway, app, client } = await makeStack();
    const session = await app.createSession({ sessionId: "s2" });

    // Same tick: the bad send takes the reservation; the good one joins it.
    const refused = session
      .send({ messages: [REFUSED_MEDIA as never] })
      .then(() => "sent" as const)
      .catch(() => "refused" as const);
    const queued = session.send({ ...say("hello"), onBusy: "queue" });

    expect(await refused).toBe("refused");
    const result = await orHung(queued.then((h) => h.result));
    expect(result).not.toBe("hung");
    expect((result as { stopReason: string }).stopReason).toBe("end");

    await client.close();
    await gateway.close();
  });

  it("gateway.close() completes after a refused wire send", async () => {
    const { gateway, client } = await makeStack();

    await expect(
      client.request("session/send", { sessionId: "s3", messages: [REFUSED_MEDIA] } as never),
    ).rejects.toThrow(/media|source/i);
    await client.close();

    expect(await orHung(gateway.close().then(() => "closed"))).toBe("closed");
  });

  it("a clean send on the same stack is untouched (regression)", async () => {
    const { gateway, client } = await makeStack();

    const ack = (await client.request("session/send", {
      sessionId: "s4",
      ...say("hi"),
    } as never)) as {
      created: boolean;
    };
    expect(ack.created).toBe(true);

    await client.close();
    expect(await orHung(gateway.close().then(() => "closed"))).toBe("closed");
  });
});
