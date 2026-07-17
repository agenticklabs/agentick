/**
 * Conformance suite for {@link SessionStore} implementations (E11).
 *
 * Every adapter — the bundled {@link InMemorySessionStore}, a future
 * `@agentick/session-store-postgres-next`, any adopter-written store — MUST
 * pass this suite. The behaviors pinned here are the substrate contract the app
 * depends on for the durable session registry + resume index: put→get
 * round-trip, upsert-in-place, app / status / parent / recency filtered `list`,
 * enumerate-all, delete, and (when supported) prune of closed sessions. An
 * adapter that diverges breaks the "list/resume my sessions" surface.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store-next`); the
 * session-specific cases are registered through its `cases` hook. Mirrors
 * `runTaskStoreConformance` (`@agentick/tasks-next`). Usage from an adapter
 * package's test file:
 *
 * ```ts
 * import { runSessionStoreConformance } from "@agentick/session-next";
 * import { mySessionStore } from "../src/index.js";
 *
 * runSessionStoreConformance({ label: "my-store", factory: () => mySessionStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { SessionRecord, SessionStore } from "@agentick/spec-next";
import { runStoreConformance } from "@agentick/store-next";

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
    emptyRead: { read: (store, key) => store.get(key), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key),
    cases: ({ setup, capabilities }) => {
      it("put then get round-trips the record", async () => {
        const store = await setup();
        const r = record("session:a", { title: "hi", appId: "app-1" });
        await store.put(r);
        expect(await store.get("session:a")).toEqual(r);
      });

      it("put upserts in place — a later put of the same id replaces", async () => {
        const store = await setup();
        await store.put(record("session:a", { status: "idle", executionCount: 0 }));
        await store.put(record("session:a", { status: "running", executionCount: 1 }));
        const got = await store.get("session:a");
        expect(got?.status).toBe("running");
        expect(got?.executionCount).toBe(1);
        // Still one record, not two.
        expect(await store.list()).toHaveLength(1);
      });

      it("list() with no query returns every record (enumerate-all)", async () => {
        const store = await setup();
        await store.put(record("session:a"));
        await store.put(record("session:b"));
        expect((await store.list()).map((r) => r.id).sort()).toEqual(["session:a", "session:b"]);
      });

      it("list() filters by appId", async () => {
        const store = await setup();
        await store.put(record("session:a", { appId: "app-1" }));
        await store.put(record("session:b", { appId: "app-2" }));
        await store.put(record("session:c", { appId: "app-1" }));
        const app1 = await store.list({ appId: "app-1" });
        expect(app1.map((r) => r.id).sort()).toEqual(["session:a", "session:c"]);
      });

      it("list() filters by status — single value and set", async () => {
        const store = await setup();
        await store.put(record("session:a", { status: "running" }));
        await store.put(record("session:b", { status: "closed" }));
        await store.put(record("session:c", { status: "failed" }));
        expect((await store.list({ status: "running" })).map((r) => r.id)).toEqual(["session:a"]);
        const terminal = await store.list({ status: ["closed", "failed"] });
        expect(terminal.map((r) => r.id).sort()).toEqual(["session:b", "session:c"]);
      });

      it("list() filters by parentSessionId (the session tree)", async () => {
        const store = await setup();
        await store.put(record("session:root"));
        await store.put(record("session:child-a", { parentSessionId: "session:root" }));
        await store.put(record("session:child-b", { parentSessionId: "session:root" }));
        await store.put(record("session:other", { parentSessionId: "session:elsewhere" }));
        const children = await store.list({ parentSessionId: "session:root" });
        expect(children.map((r) => r.id).sort()).toEqual(["session:child-a", "session:child-b"]);
      });

      it("list() filters by updatedAfter recency (>=)", async () => {
        const store = await setup();
        await store.put(record("session:old", { updatedAt: 1000 }));
        await store.put(record("session:mid", { updatedAt: 3000 }));
        await store.put(record("session:new", { updatedAt: 5000 }));
        const recent = await store.list({ updatedAfter: 3000 });
        // `>=` — the record AT the cutoff is included.
        expect(recent.map((r) => r.id).sort()).toEqual(["session:mid", "session:new"]);
      });

      it("list() combines appId + status filters", async () => {
        const store = await setup();
        await store.put(record("session:a", { appId: "app-1", status: "running" }));
        await store.put(record("session:b", { appId: "app-1", status: "closed" }));
        await store.put(record("session:c", { appId: "app-2", status: "running" }));
        const got = await store.list({ appId: "app-1", status: "running" });
        expect(got.map((r) => r.id)).toEqual(["session:a"]);
      });

      it("delete() removes a record and is idempotent", async () => {
        const store = await setup();
        await store.put(record("session:a"));
        await store.delete("session:a");
        expect(await store.get("session:a")).toBeUndefined();
        expect(await store.list()).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("session:a")).resolves.toBeUndefined();
      });

      const prune = capabilities?.prune;
      it.skipIf(prune === false)(
        "prune() drops closed sessions older than the cutoff",
        async () => {
          const store = await setup();
          if (store.prune === undefined) return;
          await store.put(record("old-closed", { status: "closed", updatedAt: 1000 }));
          await store.put(record("old-running", { status: "running", updatedAt: 1000 }));
          await store.put(record("new-closed", { status: "closed", updatedAt: 5000 }));
          await store.prune(3000);
          const remaining = (await store.list()).map((r) => r.id).sort();
          // Closed + old → pruned. In-flight (even if old) survives. New survives.
          expect(remaining).toEqual(["new-closed", "old-running"]);
        },
      );
    },
  });
}
