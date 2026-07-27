/**
 * Client scroll-back, end to end — the ADR 93 §"client read doors" proof.
 *
 * A standard read is a grant-gated wire COMMAND with a typed client face, and the
 * only way to believe that is to page a real log over a real wire. This drives the
 * REAL `GatewayHarness` + `inProcessTransport` + the registered
 * `client.session(id).timeline` handle:
 *
 *   1. SCROLL-BACK — a 25-entry server log, a live client window, two batches
 *      paged backward: page contents, `seq` continuity across the pages (no gap,
 *      no overlap), the head splices, and the tail latch on the short page.
 *   2. THE PAGE FACE — `history({ fromSeq, limit })` returns seq-tagged rows plus
 *      the cursor to continue with, and splices nothing (the adopter-owns-the-cache
 *      posture).
 *   3. DENY BY DEFAULT — the timeline's WRITE verbs are not wire-exposed, so
 *      `timeline/append` is MethodNotFound, not Forbidden. Exposure is curation:
 *      an unexposed verb does not exist as far as the wire is concerned.
 *   4. THE GRANT — with an authorizer configured, an ungranted principal is
 *      Forbidden on `timeline:history`; the granted one reads.
 *   5. TENANCY — caller A cannot page caller B's history. Both hold `*`, so the
 *      ONLY thing that can deny is the ADR-48 same-principal target rule reading
 *      the session's STAMPED principal. Structural: no timeline-specific guard.
 *
 * Identity rides `dispatchRequest`'s 4th arg exactly as a live transport supplies
 * it post-ingress-authn, which is why (4) and (5) use the transport's `handler`
 * escape hatch rather than the `gateway` shorthand.
 *
 * Side-effect imports register the server-side timeline surface AND the client
 * `/client` sub-handle.
 */

import "@agentick/timeline";
import "@agentick/timeline/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway, staticAuthorizer } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { dispatchRequest, type DispatchHost, type DispatchSink } from "@agentick/transport";
import {
  ErrorCode,
  type ContentBlock,
  type IngressIdentity,
  type TimelineEntry,
  type WireMethod,
} from "@agentick/spec";

import { inProcessTransport } from "../index.js";

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

const idOf = (e: TimelineEntry): string => (e.kind === "message" ? e.message.id : "boundary");

/** `m0 … m{n-1}` — a log long enough that one page is never the whole thing. */
const logOf = (n: number): TimelineEntry[] => Array.from({ length: n }, (_, i) => entry(`m${i}`));

async function mkGateway(authorizer?: ReturnType<typeof staticAuthorizer>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-history-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway(authorizer !== undefined ? { authorizer } : {});
  await gateway.listen();
  const app = await gateway.createApp({
    appId: `history-app-${Math.random().toString(36).slice(2)}`,
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  return { gateway, app };
}

/**
 * A client whose dispatches carry `identity` — the `handler` escape hatch over
 * `dispatchRequest`, which is where the ingress-authn identity enters.
 */
function identifiedClient(gateway: DispatchHost, identity: IngressIdentity) {
  const subscriptions = new Map<string, () => Promise<void>>();
  return inProcessTransport({
    handler: (request, sendNotification) => {
      const sink: DispatchSink = {
        sendNotification: (n) => sendNotification(n),
        registerSubscription: (id, unsubscribe) => subscriptions.set(id, unsubscribe),
        unregisterSubscription: (id) => subscriptions.delete(id),
        registerInFlight: () => {},
        unregisterInFlight: () => {},
      };
      return dispatchRequest(gateway, request, sink, identity);
    },
  });
}

/** The JSON-RPC error code a rejected `transport.request` surfaced. */
const codeOf = (err: unknown): number | undefined => {
  const e = err as { code?: number; error?: { code?: number }; cause?: { code?: number } };
  return e.error?.code ?? e.code ?? e.cause?.code;
};

// ============================================================================
// 1 + 2 — scroll-back over the live window
// ============================================================================

describe("client scroll-back — 25-entry log, paged backward over timeline/history", () => {
  it("pages two batches at the window HEAD with continuous seqs, then latches at the tail", async () => {
    const { gateway, app } = await mkGateway();
    const session = await app.createSession({ sessionId: "scrollback-session" });
    await session.timeline.append(...logOf(25));

    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();
    const timeline = client.session(session.id).timeline;

    // The window starts on the live tail — scroll-back is what fills it.
    expect(timeline.list()).toEqual([]);
    let changes = 0;
    const stop = timeline.subscribe(() => {
      changes += 1;
    });

    const first = await timeline.loadOlder(10);
    expect(first.entries.map(idOf)).toEqual(logOf(10).map(idOf));
    expect(first.done).toBe(false);
    expect(timeline.list().map(idOf)).toEqual(first.entries.map(idOf));

    const second = await timeline.loadOlder(10);
    expect(second.entries.map(idOf)).toEqual(
      ["m10", "m11", "m12", "m13", "m14"].concat(["m15", "m16", "m17", "m18", "m19"]),
    );
    expect(second.done).toBe(false);
    // Each page splices at the HEAD. The read is FORWARD-cursored by `seq` while
    // the window grows head-first, so page 2 lands ahead of page 1 — the
    // documented cursor-vs-seq honesty, not a bug: an app doing true
    // infinite-scroll-up owns the final ordering.
    expect(timeline.list().map(idOf)).toEqual([
      ...second.entries.map(idOf),
      ...first.entries.map(idOf),
    ]);

    // The short page is the tail, and `done` latches: no further wire calls.
    const third = await timeline.loadOlder(10);
    expect(third.entries.map(idOf)).toEqual(["m20", "m21", "m22", "m23", "m24"]);
    expect(third.done).toBe(true);
    const fourth = await timeline.loadOlder(10);
    expect(fourth).toEqual({ entries: [], done: true });

    // Every splice notified the store-contract subscriber (three pages).
    expect(changes).toBe(3);

    stop();
    timeline.close();
    await client.close();
    await gateway.close();
  });

  it("history() hands back seq-tagged rows + the next cursor, and splices nothing", async () => {
    const { gateway, app } = await mkGateway();
    const session = await app.createSession({ sessionId: "page-face-session" });
    await session.timeline.append(...logOf(25));

    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();
    const timeline = client.session(session.id).timeline;

    const page1 = await timeline.history({ limit: 10 });
    expect(page1.entries.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page1.nextFromSeq).toBe(10);

    const page2 = await timeline.history({ fromSeq: page1.nextFromSeq, limit: 10 });
    // Continuity: the second page starts exactly where the first stopped —
    // no gap, no overlap.
    expect(page2.entries.map((t) => t.seq)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(page2.entries.map((t) => idOf(t.entry))[0]).toBe("m10");
    expect(page2.nextFromSeq).toBe(20);

    const tail = await timeline.history({ fromSeq: page2.nextFromSeq, limit: 10 });
    expect(tail.entries.map((t) => t.seq)).toEqual([20, 21, 22, 23, 24]);
    // Uncapped page ⇒ the tail: no cursor to continue with.
    expect(tail.nextFromSeq).toBeUndefined();

    // View-neutral: the window is untouched (Posture B pages into its OWN store).
    expect(timeline.list()).toEqual([]);

    timeline.close();
    await client.close();
    await gateway.close();
  });
});

// ============================================================================
// 3 + 4 — exposure, then the grant
// ============================================================================

describe("the read is admitted twice — exposure, then grant", () => {
  it("a timeline WRITE verb is MethodNotFound over the wire (deny-by-default)", async () => {
    const { gateway, app } = await mkGateway();
    const session = await app.createSession({ sessionId: "exposure-session" });

    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();

    const err = await client.transport
      .request(
        "timeline/append" as WireMethod,
        {
          sessionId: session.id,
          entries: [entry("smuggled")],
        } as never,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(codeOf(err)).toBe(ErrorCode.MethodNotFound);
    // …and the log is untouched: an unexposed verb is not reachable, period.
    expect(session.timeline.readPersisted()).toEqual([]);

    await client.close();
    await gateway.close();
  });

  it("an ungranted principal is Forbidden on timeline:history; the granted one reads", async () => {
    const { gateway, app } = await mkGateway(
      staticAuthorizer({ grants: { reader: ["timeline:history"] } }),
    );
    // Deliberately UNOWNED: with no principal on the session the target rule is
    // inert, so the grant is the only thing that can decide. (Tenancy gets its
    // own test below, where the grants are identical on both sides.)
    const session = await app.createSession({ sessionId: "grant-session" });
    await session.timeline.append(...logOf(3));

    // Granted — the exact read scope is all it takes.
    const reader = await createClient({
      transport: identifiedClient(gateway, { principal: "reader", scopes: ["timeline:history"] }),
    });
    await reader.connect();
    const page = await reader.session(session.id).timeline.history({ limit: 2 });
    expect(page.entries.map((t) => idOf(t.entry))).toEqual(["m0", "m1"]);

    // Ungranted — same method, same session, no grant.
    const mallory = await createClient({
      transport: identifiedClient(gateway, { principal: "mallory", scopes: [] }),
    });
    await mallory.connect();
    const err = await mallory
      .session(session.id)
      .timeline.history({ limit: 2 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(codeOf(err)).toBe(ErrorCode.Forbidden);

    await reader.close();
    await mallory.close();
    await gateway.close();
  });
});

// ============================================================================
// 5 — tenancy: the ADR-48 target rule, already structural
// ============================================================================

describe("tenancy — caller A cannot page caller B's history", () => {
  it("denies the cross-principal read under `*` grants on BOTH sides", async () => {
    // Both principals hold `*`, so a grant can not be what denies this: the only
    // remaining gate is the same-principal target rule reading the session's
    // stamped principal.
    const { gateway, app } = await mkGateway(
      staticAuthorizer({ grants: { alice: ["*"], bob: ["*"] } }),
    );
    const alicesSession = await app.createSession({
      sessionId: "alice-session",
      principal: "alice",
    });
    const bobsSession = await app.createSession({ sessionId: "bob-session", principal: "bob" });
    await alicesSession.timeline.append(entry("alice-secret"));
    await bobsSession.timeline.append(entry("bob-secret"));

    const alice = await createClient({
      transport: identifiedClient(gateway, { principal: "alice", scopes: ["*"] }),
    });
    await alice.connect();

    // Her own log: readable.
    const own = await alice.session(alicesSession.id).timeline.history({});
    expect(own.entries.map((t) => idOf(t.entry))).toEqual(["alice-secret"]);

    // Bob's log: denied — and nothing of his content is in the failure.
    const err = await alice
      .session(bobsSession.id)
      .timeline.history({})
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(codeOf(err)).toBe(ErrorCode.Forbidden);
    expect(JSON.stringify(err ?? "")).not.toMatch(/bob-secret/);

    // Control — Bob reads his own.
    const bob = await createClient({
      transport: identifiedClient(gateway, { principal: "bob", scopes: ["*"] }),
    });
    await bob.connect();
    const bobsOwn = await bob.session(bobsSession.id).timeline.history({});
    expect(bobsOwn.entries.map((t) => idOf(t.entry))).toEqual(["bob-secret"]);

    await alice.close();
    await bob.close();
    await gateway.close();
  });
});
