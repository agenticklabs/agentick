/**
 * `app/list_sessions` and `gateway/list_sessions` over the wire — the paged,
 * caller-scoped session enumeration and its cross-app twin.
 *
 * Four things here are not obvious from the handlers, and each has a test that
 * fails loudly if it regresses.
 *
 * **The cursor is not the framework's.** Whoever owns the ordering mints it —
 * the app's store when it implements the optional cursored read, a mounted
 * cross-app index at the gateway, and the framework only when neither pages and
 * it must impose an order to page at all. The tests pin passthrough by giving
 * the doubles cursor formats the framework could not have produced (`row#2`,
 * `idx#2`) and asserting those exact tokens come back.
 *
 * **A mounted index is not merely faster — it OWNS the order.** The index double
 * answers in reverse-alphabetical order, deliberately not the canonical recency
 * one, so a gateway that re-sorted its output would fail. Its rows also differ
 * from the apps' stores, which is how "one query answered this, not a merge"
 * becomes an assertion rather than a claim.
 *
 * **A list has no target for the dispatch gate to check.** The same-principal
 * rule (ADR 48 / ADR 51 §4.2) resolves a session from `params.sessionId`, and a
 * list names none — so the gate is silent and the query's own `principal`
 * dimension is the only thing standing between a caller and every principal's
 * threads. Scoped by ABSENCE, not by error: a 403 on someone else's session
 * would confirm the id exists.
 *
 * **Scoping and filtering happen before the page is cut.** After it, a page
 * comes back shortened by rows the caller may not see, with a `nextCursor`
 * promising rows already discarded. Pinned two ways: a caller whose sessions are
 * interleaved with another principal's, and a `metadata` filter — the one
 * dimension no store query expresses — forcing the snapshot path.
 *
 * Home note (dep graph): mirrors `destroy-session-wire.spec.ts` —
 * `@agentick/gateway` does not depend on transport, so this tier is the only one
 * that can wire a real gateway + authorizer against the real dispatch gate. The
 * store doubles are written standalone rather than extending
 * `InMemorySessionStore`, because transport does not depend on
 * `@agentick/session` and this is not worth a new edge in the graph.
 *
 * @verifiedBy this file
 * @see packages/spec/src/protocol/paging.ts — who owns a cursor
 * @see packages/spec/src/protocol/gateway-index.ts — the gateway-index pattern
 * @see packages/gateway/src/wire/app-extension.ts — the `app/list_sessions` handler
 * @see packages/gateway/src/wire/gateway-extension.ts — the `gateway/list_sessions` handler
 */

import { describe, expect, it } from "vitest";
import {
  type AppHarnessProtocol,
  type AppListSessionsResult,
  type CollectionMutation,
  type ContentBlock,
  type CursorPage,
  type GatewayListSessionsResult,
  type GatewaySessionRecord,
  type IngressIdentity,
  type JsonRpcResponse,
  type PageRequest,
  type SessionIndex,
  type SessionIndexQuery,
  type SessionRecord,
  type SessionStore,
  type SessionStoreQuery,
  type ToolHandler,
  SPEC_VERSION,
  sortSessionRecords,
} from "@agentick/spec";
import { createGateway, staticAuthorizer, permissiveAuthorizer } from "@agentick/gateway";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

const NULL_ROOT = null as unknown;

function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
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
            stopReason: "end" as const,
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
    toolHandlers: new Map<string, ToolHandler>(),
  };
}

function stubSink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function resultOf<T>(resp: JsonRpcResponse): T {
  if (!("result" in resp)) throw new Error(`expected a result frame, got ${JSON.stringify(resp)}`);
  return resp.result as T;
}

const IDENTITY_A: IngressIdentity = { principal: "userA", scopes: ["*"] };
const IDENTITY_B: IngressIdentity = { principal: "userB", scopes: ["*"] };

/**
 * The list is ordered by `updatedAt`, an ms-epoch stamp — so sessions created
 * inside one millisecond tie and fall back to the id tiebreak. Tests that assert
 * a RECENCY order need the stamps to actually differ, which a real 2ms gap is
 * the honest way to get (the alternative, faking `Date`, would also fake it for
 * the store and executor internals under test).
 */
const apart = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

/** Seed sessions oldest-first, each with a distinct `updatedAt`. */
async function seed(
  app: AppHarnessProtocol,
  ids: readonly string[],
  principal?: string,
): Promise<void> {
  for (const sessionId of ids) {
    await app.createSession({ sessionId, ...(principal !== undefined ? { principal } : {}) });
    await apart();
  }
}

function listApp(
  gateway: Parameters<typeof dispatchRequest>[0],
  appId: string,
  params: { filter?: unknown; cursor?: string; limit?: number },
  identity: IngressIdentity = IDENTITY_B,
): Promise<AppListSessionsResult> {
  return dispatchRequest(
    gateway,
    { jsonrpc: "2.0", id: 1, method: "app/list_sessions", params: { appId, ...params } },
    stubSink(),
    { identity: identity },
  ).then(resultOf<AppListSessionsResult>);
}

function listGateway(
  gateway: Parameters<typeof dispatchRequest>[0],
  params: { filter?: unknown; cursor?: string; limit?: number },
  identity: IngressIdentity = IDENTITY_B,
): Promise<GatewayListSessionsResult> {
  return dispatchRequest(
    gateway,
    { jsonrpc: "2.0", id: 1, method: "gateway/list_sessions", params },
    stubSink(),
    { identity: identity },
  ).then(resultOf<GatewayListSessionsResult>);
}

describe("app/list_sessions — the page and its shape", () => {
  it("lists newest-first and projects the record's descriptive slots", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    await app.createSession({ sessionId: "older", title: "Yesterday", description: "the old one" });
    await apart();
    await app.createSession({ sessionId: "newer" });

    const { sessions, nextCursor } = await listApp(gateway, app.id, {});

    // Recency order — a thread list is a recency list.
    expect(sessions.map((s) => s.id)).toEqual(["newer", "older"]);
    // One short page ends the walk. The cursor's ABSENCE is the signal, so a
    // client never has to guess from the page length.
    expect(nextCursor).toBeUndefined();

    const older = sessions[1]!;
    expect(older.title).toBe("Yesterday");
    expect(older.description).toBe("the old one");
    // `lastActiveAt` is the record's `updatedAt` — the very key the page is
    // ordered and cursored by, so a client can verify the order it was handed.
    expect(older.lastActiveAt).toBeTypeOf("number");
    // Unset slots are absent, not `null` — a renderer branches on presence.
    expect("title" in sessions[0]!).toBe(false);

    await gateway.close();
  });

  it("answers an app with no sessions with an empty page and no cursor", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    expect(await listApp(gateway, app.id, {})).toEqual({ sessions: [] });

    await gateway.close();
  });
});

describe("app/list_sessions — the keyset walk", () => {
  it("walks three pages without duplicates while rows move underneath it", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // Oldest → newest, so the list reads s5, s4, s3, s2, s1, s0.
    await seed(app, ["s0", "s1", "s2", "s3", "s4", "s5"]);

    const page1 = await listApp(gateway, app.id, { limit: 2 });
    expect(page1.sessions.map((s) => s.id)).toEqual(["s5", "s4"]);
    expect(page1.nextCursor).toBeDefined();

    // Now churn the list underneath the open cursor, both ways a real list
    // churns: an EXISTING row is touched (bumping `updatedAt`, so it jumps to
    // the front) and a NEW row arrives at the front. Between them the two rows
    // page one already served are pushed from offsets 0–1 down to 2–3.
    await apart();
    await app.setSessionMeta("s0", { title: "someone replied" });
    await apart();
    await app.createSession({ sessionId: "s6" });

    const page2 = await listApp(gateway, app.id, { limit: 2, cursor: page1.nextCursor! });
    const page3 = await listApp(gateway, app.id, { limit: 2, cursor: page2.nextCursor! });

    expect(page2.sessions.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(page3.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(page3.nextCursor).toBeUndefined();

    // The whole point, stated as the invariant: every row the walk started with
    // came back exactly once, in order, and nothing came back twice.
    const walked = [page1, page2, page3].flatMap((p) => p.sessions.map((s) => s.id));
    expect(walked).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    expect(new Set(walked).size).toBe(walked.length);

    // The failure mode this cursor exists to prevent: under an OFFSET cursor,
    // page two at offset 2 would have re-served s5 and s4, which the two new
    // front rows had just pushed into that window.
    expect(page2.sessions.map((s) => s.id)).not.toContain("s5");
    expect(page2.sessions.map((s) => s.id)).not.toContain("s4");

    // s0 and s6 are absent from the walk, and that is correct rather than a
    // skip: both sorted into the region the walk had already passed. A client
    // that wants them re-reads from page one.
    expect(walked).not.toContain("s0");
    expect(walked).not.toContain("s6");

    await gateway.close();
  });

  it("walks rows that share a millisecond — the id tiebreak carries the cursor", async () => {
    // Created back-to-back with no gap, so `updatedAt` collides. Without a
    // tiebreaker in the sort key the cursor could not tell which side of the tie
    // it sat on, and a page boundary landing inside the tie would drop or repeat
    // rows. Asserted as a set, since the ordering WITHIN the tie is the id's.
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    await app.createSession({ sessionId: "a" });
    await app.createSession({ sessionId: "b" });
    await app.createSession({ sessionId: "c" });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page: AppListSessionsResult = await listApp(gateway, app.id, { limit: 1, cursor });
      seen.push(...page.sessions.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(seen.sort()).toEqual(["a", "b", "c"]);

    await gateway.close();
  });

  it("answers a cursor it cannot decode with page one, not an error", async () => {
    // A client holding a stale or corrupted cursor has no recovery path from an
    // error; page one is a walk it can finish. Same contract as `paginate()`.
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await seed(app, ["x", "y"]);

    const page = await listApp(gateway, app.id, { cursor: "not-a-cursor" });
    expect(page.sessions.map((s) => s.id)).toEqual(["y", "x"]);

    await gateway.close();
  });
});

describe("app/list_sessions — principal scoping", () => {
  it("omits another principal's sessions instead of failing the call", async () => {
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    await seed(app, ["a-1", "a-2"], "userA");
    await seed(app, ["b-1"], "userB");
    // Unowned — a principal-less record asserts no ownership, so everyone sees it.
    await seed(app, ["shared"]);

    const asA = await listApp(gateway, app.id, {}, IDENTITY_A);
    expect(asA.sessions.map((s) => s.id).sort()).toEqual(["a-1", "a-2", "shared"]);

    const asB = await listApp(gateway, app.id, {}, IDENTITY_B);
    expect(asB.sessions.map((s) => s.id).sort()).toEqual(["b-1", "shared"]);

    await gateway.close();
  });

  it("scopes before it pages, so a page is never shortened by rows the caller can't see", async () => {
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // Interleaved by recency: b3 b2 b1 alternate with a3 a2 a1, so a page cut
    // BEFORE the ownership filter would hand userA one row instead of two.
    for (const [owner, id] of [
      ["userA", "a1"],
      ["userB", "b1"],
      ["userA", "a2"],
      ["userB", "b2"],
      ["userA", "a3"],
      ["userB", "b3"],
    ] as const) {
      await app.createSession({ sessionId: id, principal: owner });
      await apart();
    }

    const page1 = await listApp(gateway, app.id, { limit: 2 }, IDENTITY_A);
    expect(page1.sessions.map((s) => s.id)).toEqual(["a3", "a2"]);
    const page2 = await listApp(
      gateway,
      app.id,
      { limit: 2, cursor: page1.nextCursor! },
      IDENTITY_A,
    );
    expect(page2.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(page2.nextCursor).toBeUndefined();

    await gateway.close();
  });
});

describe("gateway/list_sessions — the index seam", () => {
  /**
   * A `SessionIndex` double that records what it was asked and answers in an
   * order of its OWN — reverse-alphabetical by id, deliberately not the
   * framework's canonical recency order — with a cursor in a format only it
   * understands. Every assertion below turns on the gateway leaving all three
   * alone.
   */
  function spySessionIndex(rows: readonly GatewaySessionRecord[]): SessionIndex & {
    readonly calls: SessionIndexQuery[];
  } {
    const calls: SessionIndexQuery[] = [];
    return {
      calls,
      backend: "spy",
      async page(query, page) {
        calls.push(query ?? {});
        const scoped = rows.filter(
          (r) =>
            query?.principal === undefined ||
            r.principal === undefined ||
            r.principal === query.principal,
        );
        const ordered = [...scoped].sort((a, b) => (a.id < b.id ? 1 : -1));
        const from = page.cursor === undefined ? 0 : Number(page.cursor.replace("idx#", ""));
        const size = page.limit ?? 100;
        const items = ordered.slice(from, from + size);
        const more = from + items.length < ordered.length;
        return { items, ...(more ? { nextCursor: `idx#${from + items.length}` } : {}) };
      },
    };
  }

  function indexRow(
    id: string,
    appId: string,
    over: Partial<GatewaySessionRecord> = {},
  ): GatewaySessionRecord {
    return {
      id,
      appId,
      createdAt: 1,
      updatedAt: 1,
      status: "idle",
      executionCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...over,
    };
  }

  it("delegates to a mounted index — its rows, its order, its cursor", async () => {
    const index = spySessionIndex([
      indexRow("aaa", "app-x"),
      indexRow("bbb", "app-y"),
      indexRow("ccc", "app-z"),
    ]);
    const gateway = await createGateway({
      authorizer: permissiveAuthorizer(),
      sessionIndex: index,
    });
    await gateway.listen();
    // A real app with a real session, which the index knows nothing about. If the
    // gateway were still merging the apps' stores, this row would appear.
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await app.createSession({ sessionId: "not-in-the-index" });

    const page1 = await listGateway(gateway, { limit: 2 });
    // The index's own ordering survives — the gateway does not re-sort, because
    // ordering across apps is the index's policy to set.
    expect(page1.sessions.map((s) => s.id)).toEqual(["ccc", "bbb"]);
    expect(page1.sessions.map((s) => s.appId)).toEqual(["app-z", "app-y"]);
    // The store's row is absent: one query answered this, not a merge.
    expect(page1.sessions.map((s) => s.id)).not.toContain("not-in-the-index");
    // The index minted the cursor and the gateway handed it back untouched.
    expect(page1.nextCursor).toBe("idx#2");

    const page2 = await listGateway(gateway, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.sessions.map((s) => s.id)).toEqual(["aaa"]);
    expect(page2.nextCursor).toBeUndefined();

    // One query per page — the whole point of the seam.
    expect(index.calls).toHaveLength(2);

    await gateway.close();
  });

  it("passes the caller's principal down so the index scopes the read itself", async () => {
    // Scoping has to reach the source. An index that returned every principal's
    // rows for the gateway to filter afterward would hand back short pages.
    const index = spySessionIndex([
      indexRow("mine", "app-x", { principal: "userB" }),
      indexRow("theirs", "app-y", { principal: "userA" }),
      indexRow("unowned", "app-z"),
    ]);
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
      sessionIndex: index,
    });
    await gateway.listen();

    const asB = await listGateway(gateway, {}, IDENTITY_B);
    expect(asB.sessions.map((s) => s.id).sort()).toEqual(["mine", "unowned"]);
    expect(index.calls[0]?.principal).toBe("userB");

    await gateway.close();
  });

  it("falls back to merging the apps' stores when no index is mounted", async () => {
    // The contrast case for the two tests above: same verb, same envelope, and a
    // caller cannot tell which mode answered — only the cost differs.
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const first = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const second = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await seed(first, ["from-first"]);
    await seed(second, ["from-second"]);

    const { sessions } = await listGateway(gateway, {});
    // Merged in the FRAMEWORK's canonical order, because a merge over
    // independently ordered sources needs one the merger understands.
    expect(sessions.map((s) => s.id)).toEqual(["from-second", "from-first"]);
    expect(sessions.map((s) => s.appId)).toEqual([second.id, first.id]);

    await gateway.close();
  });
});

describe("app/list_sessions — the store's cursor, and the fallback when it has none", () => {
  /**
   * A minimal `SessionStore` over a `Map` — written standalone rather than by
   * extending the bundled `InMemorySessionStore`, because `@agentick/transport`
   * does not depend on `@agentick/session` and this test is not worth a new edge
   * in the dependency graph. Only the dimensions these tests exercise are
   * honored (`principal`, and the ADR 48 unowned rule).
   */
  class MapStore implements SessionStore {
    readonly backend = "map";
    protected readonly rows = new Map<string, SessionRecord>();

    async put(record: SessionRecord): Promise<void> {
      this.rows.set(record.id, record);
    }
    async get(id: string): Promise<SessionRecord | undefined> {
      return this.rows.get(id);
    }
    async list(query: SessionStoreQuery | undefined): Promise<readonly SessionRecord[]> {
      return [...this.rows.values()].filter(
        (r) =>
          query?.principal === undefined ||
          r.principal === undefined ||
          r.principal === query.principal,
      );
    }
    async delete(id: string): Promise<void> {
      this.rows.delete(id);
    }
    async query(q: SessionStoreQuery | undefined): Promise<readonly SessionRecord[]> {
      return this.list(q);
    }
    async mutate(m: CollectionMutation<SessionRecord>): Promise<void> {
      if ("put" in m) await this.put(m.put);
      else await this.delete(m.delete);
    }
  }

  /** Pages in a format of its own — the token must survive the round trip untouched. */
  class OffsetCursorStore extends MapStore {
    readonly pageCalls: PageRequest[] = [];
    async page(
      query: SessionStoreQuery | undefined,
      page: PageRequest,
    ): Promise<CursorPage<SessionRecord>> {
      this.pageCalls.push(page);
      const all = sortSessionRecords(await this.list(query));
      const from = page.cursor === undefined ? 0 : Number(page.cursor.replace("row#", ""));
      const size = page.limit ?? 100;
      const items = all.slice(from, from + size);
      const more = from + items.length < all.length;
      return { items, ...(more ? { nextCursor: `row#${from + items.length}` } : {}) };
    }
  }

  /** No cursored read at all — the capability the app degrades around. */
  class SnapshotOnlyStore extends MapStore {}

  it("hands back the store's own cursor verbatim when the store pages", async () => {
    const store = new OffsetCursorStore();
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), sessions: { store } },
    });
    await seed(app, ["s0", "s1", "s2"]);

    const page1 = await listApp(gateway, app.id, { limit: 2 });
    expect(page1.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    // The store minted it; the framework never re-encoded it.
    expect(page1.nextCursor).toBe("row#2");

    const page2 = await listApp(gateway, app.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.sessions.map((s) => s.id)).toEqual(["s0"]);
    expect(page2.nextCursor).toBeUndefined();
    // Paging reached the store rather than being cut above it.
    expect(store.pageCalls.map((p) => p.cursor)).toEqual([undefined, "row#2"]);

    await gateway.close();
  });

  it("pages correctly against a store that implements no cursored read", async () => {
    // The degraded path: the app snapshots the query and cuts with the
    // framework's default keyset. Same rows, same envelope — only the cost of
    // reading every match to serve two of them differs.
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), sessions: { store: new SnapshotOnlyStore() } },
    });
    await seed(app, ["s0", "s1", "s2"]);

    const page1 = await listApp(gateway, app.id, { limit: 2 });
    expect(page1.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await listApp(gateway, app.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.sessions.map((s) => s.id)).toEqual(["s0"]);
    expect(page2.nextCursor).toBeUndefined();

    await gateway.close();
  });

  it("falls back to the snapshot path for a metadata filter the store cannot express", async () => {
    // `metadata` is not a store dimension, so it cannot be pushed down — and a
    // page cut before it were applied would come back short. The handler
    // snapshots instead, which is why this returns two full rows rather than one.
    const store = new OffsetCursorStore();
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), sessions: { store } },
    });
    for (const [id, kind] of [
      ["keep-1", "thread"],
      ["drop-1", "scratch"],
      ["keep-2", "thread"],
      ["drop-2", "scratch"],
    ] as const) {
      await app.createSession({ sessionId: id, metadata: { kind } });
      await apart();
    }

    const page = await listApp(gateway, app.id, {
      limit: 2,
      filter: { metadata: { kind: "thread" } },
    });
    expect(page.sessions.map((s) => s.id)).toEqual(["keep-2", "keep-1"]);
    // The store's `page` was bypassed — the snapshot path read `list` instead.
    expect(store.pageCalls).toHaveLength(0);

    await gateway.close();
  });
});

describe("gateway/list_sessions — the cross-app union", () => {
  it("merges two apps into one recency order and names the app on every row", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const first = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const second = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // Created alternately, so a handler that concatenated per-app lists instead
    // of merging them fails here.
    await seed(first, ["one"]);
    await seed(second, ["two"]);
    await seed(first, ["three"]);
    await seed(second, ["four"]);

    const { sessions } = await listGateway(gateway, {});
    expect(sessions.map((s) => s.id)).toEqual(["four", "three", "two", "one"]);
    expect(sessions.map((s) => s.appId)).toEqual([second.id, first.id, second.id, first.id]);

    await gateway.close();
  });

  it("pages the union with ONE cursor that crosses the app boundary", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const first = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const second = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    await seed(first, ["one"]);
    await seed(second, ["two"]);
    await seed(first, ["three"]);
    await seed(second, ["four"]);

    const page1 = await listGateway(gateway, { limit: 2 });
    expect(page1.sessions.map((s) => s.id)).toEqual(["four", "three"]);
    // The cursor is a position in the MERGED order, not a bundle of per-app
    // offsets — so it resumes mid-union across the boundary between two apps.
    const page2 = await listGateway(gateway, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.sessions.map((s) => s.id)).toEqual(["two", "one"]);
    expect(page2.nextCursor).toBeUndefined();

    await gateway.close();
  });

  it("scopes the union to the caller, across every app", async () => {
    const gateway = await createGateway({
      authorizer: staticAuthorizer({ grants: { userA: ["*"], userB: ["*"] } }),
    });
    await gateway.listen();
    const first = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const second = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    // The verb names no session, so the dispatch gate's same-principal target
    // rule has nothing to resolve — the handler's filter is the whole defense.
    await seed(first, ["a-first"], "userA");
    await seed(second, ["a-second"], "userA");
    await seed(second, ["b-second"], "userB");

    const asA = await listGateway(gateway, {}, IDENTITY_A);
    expect(asA.sessions.map((s) => s.id).sort()).toEqual(["a-first", "a-second"]);

    const asB = await listGateway(gateway, {}, IDENTITY_B);
    expect(asB.sessions.map((s) => s.id)).toEqual(["b-second"]);
    expect(asB.sessions[0]?.appId).toBe(second.id);

    await gateway.close();
  });

  it("answers a gateway whose apps hold no sessions with an empty page", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    expect(await listGateway(gateway, {})).toEqual({ sessions: [] });

    await gateway.close();
  });

  it("passes the tree filter through to the stores", async () => {
    // `parentSessionId` is a STORE dimension, so it must reach the query rather
    // than being post-filtered off an already-fetched page. Spawned children are
    // the rows a conversation list has to be able to exclude — and a session
    // graph view has to be able to ask for.
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });

    await app.createSession({ sessionId: "parent" });
    await apart();
    await app.createSession({ sessionId: "child", parentSessionId: "parent" });

    const roots = await listGateway(gateway, { filter: { root: true } });
    expect(roots.sessions.map((s) => s.id)).toEqual(["parent"]);

    const children = await listGateway(gateway, { filter: { parentSessionId: "parent" } });
    expect(children.sessions.map((s) => s.id)).toEqual(["child"]);
    expect(children.sessions[0]?.parentSessionId).toBe("parent");

    await gateway.close();
  });
});
