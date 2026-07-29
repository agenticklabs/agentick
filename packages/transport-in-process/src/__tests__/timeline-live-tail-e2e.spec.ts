/**
 * The client's LIVE timeline tail, end to end — the half of the timeline handle
 * that scroll-back does not cover.
 *
 * `timelineView` folds every `timeline:command:append` requested-phase envelope
 * onto the window's tail. It is implemented, documented (`timeline-handle.ts`
 * §"the live tail folds bus-Cursor-ordered append events"), unit-tested against a
 * stub client — and it was dead over a real wire, for a reason no unit test on
 * either side could see:
 *
 *   - The gateway narrows a `{ kind: "session", id }` subscription to
 *     `query.scope.sessionId === id` (`gateway/src/wire/subscriptions-extension.ts`).
 *   - `TimelineHarness` stamped its own `scopeId` on every envelope's scope, and a
 *     session's timeline is constructed `<sessionId>:timeline`.
 *
 * So an envelope announcing itself from session `"s1:timeline"` never satisfied a
 * subscription to session `"s1"`, and a client window only ever grew from its own
 * optimistic appends and from explicit `loadOlder` paging. Every fact the server
 * committed — the canonical copy of the user's message, each tick's assistant
 * entry, the turn boundary that says whether the turn SUCCEEDED — arrived nowhere
 * until something paged for it.
 *
 * The consequence that surfaced it: a turn whose execution failed writes no
 * assistant entry (no generation completed), so its `failed` turn boundary is the
 * only evidence the turn happened. With the tail dead, a UI showed the user's
 * message and then silence — indistinguishable from a message never sent.
 *
 * Two tests, because the bug had two halves worth pinning separately: what the
 * server PUTS on the envelope, and whether the client's window actually grows.
 */

import "@agentick/timeline";
import "@agentick/timeline/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { TIMELINE_APPEND_EVENT_NAME, type TimelineEntry } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

async function mkSession(sessionId: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("live-tail-exec", journal, bus, inbox, {
    scripted: [{ result: { specVersion: "2026-05-08", output: [], stopReason: "end" } }],
  });
  await executor.ready;
  const gateway = await createGateway({});
  await gateway.listen();
  const app = await gateway.createApp({
    appId: `live-tail-app-${Math.random().toString(36).slice(2)}`,
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  const session = await app.createSession({ sessionId });
  return { gateway, session };
}

describe("client timeline — the live tail over a real wire", () => {
  it("a window grows from SERVER appends, boundary entries included", async () => {
    const { gateway, session } = await mkSession("live-tail-session");
    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();
    const timeline = client.session("live-tail-session").timeline;

    // The window opens on the live tail — empty until either the tail delivers or
    // scroll-back fills it.
    expect(timeline.list()).toEqual([]);

    // `sub/subscribe` is a real round trip. An append that races it measures the
    // race, not the fold — which is precisely how the first probe of this bug read
    // as a false negative even after the scope was correct.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await session.timeline.append(entry("m1"));
    // The entry kind that has no message twin. A failed turn appends ONLY this,
    // so a tail that dropped boundaries would still look healthy on every
    // successful turn and go blank on exactly the turns that need explaining.
    await session.timeline.endTurn({
      executionId: "x1",
      outcome: "failed",
      stopCause: { kind: "failed", error: { _tag: "ProviderRejected", message: "no key" } },
    });

    await waitFor(() => timeline.list().length === 2, { timeoutMs: 3000 });
    const [message, boundary] = timeline.list();
    expect(message?.kind).toBe("message");
    if (boundary?.kind !== "boundary") throw new Error("expected the boundary to arrive");
    expect(boundary.boundary.outcome).toBe("failed");
    // The cause rode the wire too — the whole point of recording it.
    if (boundary.boundary.stopCause?.kind !== "failed") throw new Error("expected a failure cause");
    expect(boundary.boundary.stopCause.error.message).toBe("no key");

    await gateway.close?.();
  });

  it("the append envelope announces the SESSION, not the timeline harness", async () => {
    // The mechanism, asserted directly, so a refactor that reverts the scope fails
    // here with the reason rather than as a mystery blank window one layer up.
    const { gateway, session } = await mkSession("scope-session");
    const scopes: Array<string | undefined> = [];
    void (async () => {
      for await (const env of gateway.events({
        surface: "timeline",
        name: { exact: TIMELINE_APPEND_EVENT_NAME },
        phase: "requested",
      })) {
        scopes.push(env.scope?.sessionId);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await session.timeline.append(entry("m1"));
    await waitFor(() => scopes.length > 0, { timeoutMs: 3000 });

    // NOT "scope-session:timeline" — that is the harness's work-axis scope key,
    // and no session-scoped subscription can match it.
    expect(scopes).toEqual(["scope-session"]);

    await gateway.close?.();
  });
});
