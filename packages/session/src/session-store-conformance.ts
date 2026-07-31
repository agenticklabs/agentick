/**
 * Conformance suite for {@link SessionStore} implementations (E11).
 *
 * Every adapter — the bundled {@link InMemorySessionStore}, a future
 * `@agentick/session-store-postgres`, any adopter-written store — MUST
 * pass this suite. The behaviors pinned here are the substrate contract the app
 * depends on for the durable session registry + resume index: put→get
 * round-trip, upsert-in-place, app / status / parent / recency filtered `list`,
 * enumerate-all, delete, and (when supported) prune of closed sessions. An
 * adapter that diverges breaks the "list/resume my sessions" surface.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store`); the
 * session-specific cases are registered through its `cases` hook. Mirrors
 * `runTaskStoreConformance` (`@agentick/tasks`). Usage from an adapter
 * package's test file:
 *
 * ```ts
 * import { runSessionStoreConformance } from "@agentick/session/testing";
 * import { mySessionStore } from "../src/index.js";
 *
 * runSessionStoreConformance({ label: "my-store", factory: () => mySessionStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { SessionRecord, SessionStore } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";
import { runStoreConformance } from "@agentick/store/testing";

export interface SessionStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => SessionStore | Promise<SessionStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a store).
   * For adapters whose backend may be absent in the test env — compute
   * availability at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
  /** Capabilities the suite skips if unsupported. */
  readonly capabilities?: {
    /** `prune` supported — defaults to `typeof store.prune === "function"`. */
    readonly prune?: boolean;
  };
}

/**
 * Walk every page of `store.page`, returning the ids in the order they were
 * served. `mutate` runs between pages — this is how the walk's soundness under
 * concurrent writes gets exercised rather than asserted about a still store.
 *
 * Guards against a non-terminating walk (a store whose `nextCursor` never
 * clears) with a page budget rather than hanging the suite.
 */
async function walk(
  store: SessionStore,
  limit: number,
  mutate?: (pageIndex: number) => Promise<void>,
): Promise<readonly string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await store.page!(undefined, { cursor, limit }, stubStoreCtx());
    expect(page.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
    if (cursor === undefined) return seen;
    await mutate?.(i);
  }
  throw new Error("page() never cleared its nextCursor — the walk does not terminate");
}

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
} as const;

/** Minimal well-formed record — the store treats records as opaque blobs. */
function record(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    executionCount: 0,
    usage: { ...ZERO_USAGE },
    ...over,
  };
}

export function runSessionStoreConformance(opts: SessionStoreConformanceOptions): void {
  runStoreConformance<SessionStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    capabilities: opts.capabilities,
    // Store-agnostic: unknown key → undefined; delete of an absent key settles.
    emptyRead: { read: (store, key) => store.get(key, stubStoreCtx()), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key, stubStoreCtx()),
    cases: ({ setup, capabilities }) => {
      it("put then get round-trips the record", async () => {
        const store = await setup();
        const r = record("session:a", { title: "hi", appId: "app-1" });
        await store.put(r, stubStoreCtx());
        expect(await store.get("session:a", stubStoreCtx())).toEqual(r);
      });

      it("put upserts in place — a later put of the same id replaces", async () => {
        const store = await setup();
        await store.put(record("session:a", { status: "idle", executionCount: 0 }), stubStoreCtx());
        await store.put(
          record("session:a", { status: "running", executionCount: 1 }),
          stubStoreCtx(),
        );
        const got = await store.get("session:a", stubStoreCtx());
        expect(got?.status).toBe("running");
        expect(got?.executionCount).toBe(1);
        // Still one record, not two.
        expect(await store.list(undefined, stubStoreCtx())).toHaveLength(1);
      });

      it("list() with no query returns every record (enumerate-all)", async () => {
        const store = await setup();
        await store.put(record("session:a"), stubStoreCtx());
        await store.put(record("session:b"), stubStoreCtx());
        expect((await store.list(undefined, stubStoreCtx())).map((r) => r.id).sort()).toEqual([
          "session:a",
          "session:b",
        ]);
      });

      it("list() filters by appId", async () => {
        const store = await setup();
        await store.put(record("session:a", { appId: "app-1" }), stubStoreCtx());
        await store.put(record("session:b", { appId: "app-2" }), stubStoreCtx());
        await store.put(record("session:c", { appId: "app-1" }), stubStoreCtx());
        const app1 = await store.list({ appId: "app-1" }, stubStoreCtx());
        expect(app1.map((r) => r.id).sort()).toEqual(["session:a", "session:c"]);
      });

      it("list() filters by status — single value and set", async () => {
        const store = await setup();
        await store.put(record("session:a", { status: "running" }), stubStoreCtx());
        await store.put(record("session:b", { status: "closed" }), stubStoreCtx());
        await store.put(record("session:c", { status: "failed" }), stubStoreCtx());
        expect((await store.list({ status: "running" }, stubStoreCtx())).map((r) => r.id)).toEqual([
          "session:a",
        ]);
        const terminal = await store.list({ status: ["closed", "failed"] }, stubStoreCtx());
        expect(terminal.map((r) => r.id).sort()).toEqual(["session:b", "session:c"]);
      });

      it("list() filters by parentSessionId (the session tree)", async () => {
        const store = await setup();
        await store.put(record("session:root"), stubStoreCtx());
        await store.put(
          record("session:child-a", { parentSessionId: "session:root" }),
          stubStoreCtx(),
        );
        await store.put(
          record("session:child-b", { parentSessionId: "session:root" }),
          stubStoreCtx(),
        );
        await store.put(
          record("session:other", { parentSessionId: "session:elsewhere" }),
          stubStoreCtx(),
        );
        const children = await store.list({ parentSessionId: "session:root" }, stubStoreCtx());
        expect(children.map((r) => r.id).sort()).toEqual(["session:child-a", "session:child-b"]);
      });

      it("list() filters by updatedAfter recency (>=)", async () => {
        const store = await setup();
        await store.put(record("session:old", { updatedAt: 1000 }), stubStoreCtx());
        await store.put(record("session:mid", { updatedAt: 3000 }), stubStoreCtx());
        await store.put(record("session:new", { updatedAt: 5000 }), stubStoreCtx());
        const recent = await store.list({ updatedAfter: 3000 }, stubStoreCtx());
        // `>=` — the record AT the cutoff is included.
        expect(recent.map((r) => r.id).sort()).toEqual(["session:mid", "session:new"]);
      });

      it("list() combines appId + status filters", async () => {
        const store = await setup();
        await store.put(record("session:a", { appId: "app-1", status: "running" }), stubStoreCtx());
        await store.put(record("session:b", { appId: "app-1", status: "closed" }), stubStoreCtx());
        await store.put(record("session:c", { appId: "app-2", status: "running" }), stubStoreCtx());
        const got = await store.list({ appId: "app-1", status: "running" }, stubStoreCtx());
        expect(got.map((r) => r.id)).toEqual(["session:a"]);
      });

      it("delete() removes a record and is idempotent", async () => {
        const store = await setup();
        await store.put(record("session:a"), stubStoreCtx());
        await store.delete("session:a", stubStoreCtx());
        expect(await store.get("session:a", stubStoreCtx())).toBeUndefined();
        expect(await store.list(undefined, stubStoreCtx())).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("session:a", stubStoreCtx())).resolves.toBeUndefined();
      });

      // ── The OPTIONAL cursored read (`page`) ──────────────────────────────
      //
      // Skipped entirely when a store does not implement it — `page` is a
      // capability, and the app degrades to snapshot-and-slice around its
      // absence. When it IS implemented these are the obligations the framework
      // relies on, and the reason they are tests rather than framework code is
      // that the cursor is the store's: nothing but the store can enforce them,
      // so the framework ships the check instead of the mechanism.

      it("page() returns rows in the canonical order — the merge contract", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        // Deliberately inserted out of order, and with a tie on `updatedAt` that
        // only the id tiebreak can resolve.
        await store.put(record("s-mid", { updatedAt: 3000 }), stubStoreCtx());
        await store.put(record("s-new", { updatedAt: 5000 }), stubStoreCtx());
        await store.put(record("s-tie-b", { updatedAt: 1000 }), stubStoreCtx());
        await store.put(record("s-tie-a", { updatedAt: 1000 }), stubStoreCtx());

        const page = await store.page(undefined, {}, stubStoreCtx());
        // Newest first; the tie broken by ascending id. A store free to order
        // however it liked would break the gateway's k-way merge, which is why
        // this one dimension is contract rather than policy.
        expect(page.items.map((r) => r.id)).toEqual(["s-new", "s-mid", "s-tie-a", "s-tie-b"]);
      });

      it("page() walks the whole store exactly once across pages", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        const ids = Array.from({ length: 7 }, (_, i) => `s-${i}`);
        for (const [i, id] of ids.entries()) {
          await store.put(record(id, { updatedAt: 1000 + i }), stubStoreCtx());
        }

        const seen = await walk(store, 3);
        expect([...seen].sort()).toEqual([...ids].sort());
        expect(new Set(seen).size).toBe(seen.length);
      });

      it("page() skips no settled row and repeats none while writes land mid-walk", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        // Ten records walked three at a time. Between pages, two kinds of churn
        // that a real list sees: an EXISTING row is touched (its `updatedAt`
        // bumped, so it jumps to the front of the order) and a NEW row arrives
        // at the front. Both push already-served rows further down — which is
        // exactly what makes a count-addressed cursor re-serve them.
        const settled = ["s-0", "s-1", "s-2", "s-3", "s-4", "s-5"];
        const churned = ["c-0", "c-1", "c-2", "c-3"];
        for (const [i, id] of [...settled, ...churned].entries()) {
          await store.put(record(id, { updatedAt: 1000 + i }), stubStoreCtx());
        }

        let n = 0;
        const seen = await walk(store, 3, async () => {
          const touch = churned[n % churned.length]!;
          await store.put(record(touch, { updatedAt: 9000 + n }), stubStoreCtx());
          await store.put(record(`late-${n}`, { updatedAt: 9500 + n }), stubStoreCtx());
          n++;
        });

        // No row served twice — the invariant a moving sort key threatens.
        expect(new Set(seen).size).toBe(seen.length);
        // Every row that did NOT move is still served. Rows that jumped ahead of
        // the cursor are legitimately missed — they sorted into a region the
        // walk had already passed — so the obligation is stated over the settled
        // ones, which is precisely the guarantee a keyset cursor makes.
        for (const id of settled) expect(seen).toContain(id);
      });

      it("page() honors the query, and scopes by principal inside the page", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        await store.put(record("mine-1", { principal: "userA", updatedAt: 5000 }), stubStoreCtx());
        await store.put(record("theirs", { principal: "userB", updatedAt: 4000 }), stubStoreCtx());
        await store.put(record("mine-2", { principal: "userA", updatedAt: 3000 }), stubStoreCtx());
        // No principal at all — asserts no ownership, so it matches every
        // principal's query. The ADR 48 rule is `= ? OR IS NULL`, not `= ?`.
        await store.put(record("unowned", { updatedAt: 2000 }), stubStoreCtx());

        // Limit 2 with another principal's record sitting between the two
        // matches: a store that filtered AFTER cutting the page would answer
        // with one row, not two.
        const page = await store.page({ principal: "userA" }, { limit: 2 }, stubStoreCtx());
        expect(page.items.map((r) => r.id)).toEqual(["mine-1", "mine-2"]);

        const rest = await store.page(
          { principal: "userA" },
          { limit: 2, cursor: page.nextCursor },
          stubStoreCtx(),
        );
        expect(rest.items.map((r) => r.id)).toEqual(["unowned"]);
      });

      it("page() answers an undecodable cursor with page one rather than raising", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        await store.put(record("only"), stubStoreCtx());
        // A caller holding a stale or corrupted token has no recovery path from
        // an error; page one is a walk it can finish.
        const page = await store.page(undefined, { cursor: "not-a-cursor" }, stubStoreCtx());
        expect(page.items.map((r) => r.id)).toEqual(["only"]);
      });

      it("page() ends the walk by CLEARING the cursor, not by shortening the page", async () => {
        const store = await setup();
        if (store.page === undefined) return;
        await store.put(record("a", { updatedAt: 2000 }), stubStoreCtx());
        await store.put(record("b", { updatedAt: 1000 }), stubStoreCtx());

        // Exactly `limit` rows and nothing behind them: the page is full, so
        // page length cannot be the end signal. The absent cursor is.
        const page = await store.page(undefined, { limit: 2 }, stubStoreCtx());
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeUndefined();
      });

      const prune = capabilities?.prune;
      it.skipIf(prune === false)(
        "prune() drops closed sessions older than the cutoff",
        async () => {
          const store = await setup();
          if (store.prune === undefined) return;
          await store.put(
            record("old-closed", { status: "closed", updatedAt: 1000 }),
            stubStoreCtx(),
          );
          await store.put(
            record("old-running", { status: "running", updatedAt: 1000 }),
            stubStoreCtx(),
          );
          await store.put(
            record("new-closed", { status: "closed", updatedAt: 5000 }),
            stubStoreCtx(),
          );
          await store.prune(3000, stubStoreCtx());
          const remaining = (await store.list(undefined, stubStoreCtx())).map((r) => r.id).sort();
          // Closed + old → pruned. In-flight (even if old) survives. New survives.
          expect(remaining).toEqual(["new-closed", "old-running"]);
        },
      );
    },
  });
}
