/**
 * Conformance suite for {@link PromptStore} implementations (data-layer plan
 * §6-C, the definition-library archetype's augmented instance).
 *
 * Every adapter — the bundled {@link InMemoryPromptStore}, a future durable
 * backing, any adopter store — MUST pass this suite. The behaviors pinned here
 * are the substrate contract the {@link import("./harness.js").PromptsHarness}
 * depends on: put→get round-trip of the SERIALIZABLE
 * {@link PromptDeclarationRecord} slice, upsert-in-place, `list()` enumerate, and
 * the minimal `name`-substring `list(query)` filter. The store never sees
 * `template`/`render` — those are the harness's sidecar, so there is nothing
 * augmentation-shaped to conform here.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store-next`); the
 * prompt-specific cases are registered through its `cases` hook. Mirrors
 * `runSkillStoreConformance`. Usage from an adapter package's test file:
 *
 * ```ts
 * import { runPromptStoreConformance } from "@agentick/prompts-next";
 * import { myPromptStore } from "../src/index.js";
 *
 * runPromptStoreConformance({ label: "my-store", factory: () => myPromptStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { PromptDeclarationRecord, PromptStore } from "@agentick/spec-next";
import { runStoreConformance, stubStoreCtx } from "@agentick/store-next";

export interface PromptStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => PromptStore | Promise<PromptStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a store).
   * For adapters whose backend may be absent in the test env — compute
   * availability at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
}

/** Minimal well-formed record — the store treats records as opaque blobs. */
function record(
  name: string,
  over: Partial<PromptDeclarationRecord> = {},
): PromptDeclarationRecord {
  return {
    name,
    description: `${name} description`,
    ...over,
  };
}

export function runPromptStoreConformance(opts: PromptStoreConformanceOptions): void {
  runStoreConformance<PromptStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    // Store-agnostic: unknown key → undefined; delete of an absent key settles.
    emptyRead: { read: (store, key) => store.get(key, stubStoreCtx()), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key, stubStoreCtx()),
    cases: ({ setup }) => {
      it("put then get round-trips the record (name-keyed)", async () => {
        const store = await setup();
        const r = record("summarize", {
          arguments: [{ name: "docId", required: true }],
          metadata: { version: 2 },
        });
        await store.put(r, stubStoreCtx());
        expect(await store.get("summarize", stubStoreCtx())).toEqual(r);
      });

      it("put upserts in place — a later put of the same name replaces", async () => {
        const store = await setup();
        await store.put(record("greet", { description: "old" }), stubStoreCtx());
        await store.put(record("greet", { description: "new" }), stubStoreCtx());
        const got = await store.get("greet", stubStoreCtx());
        expect(got?.description).toBe("new");
        // Still one record, not two.
        expect(await store.list(undefined, stubStoreCtx())).toHaveLength(1);
      });

      it("list() with no query returns every record", async () => {
        const store = await setup();
        await store.put(record("a"), stubStoreCtx());
        await store.put(record("b"), stubStoreCtx());
        expect((await store.list(undefined, stubStoreCtx())).map((r) => r.name).sort()).toEqual([
          "a",
          "b",
        ]);
      });

      it("list(query) filters by name substring (case-insensitive)", async () => {
        const store = await setup();
        await store.put(record("git_push"), stubStoreCtx());
        await store.put(record("git_pull"), stubStoreCtx());
        await store.put(record("docker_build"), stubStoreCtx());
        const got = await store.list({ name: "GIT" }, stubStoreCtx());
        expect(got.map((r) => r.name).sort()).toEqual(["git_pull", "git_push"]);
      });

      it("delete() removes a record and is idempotent", async () => {
        const store = await setup();
        await store.put(record("fade"), stubStoreCtx());
        await store.delete("fade", stubStoreCtx());
        expect(await store.get("fade", stubStoreCtx())).toBeUndefined();
        expect(await store.list(undefined, stubStoreCtx())).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("fade", stubStoreCtx())).resolves.toBeUndefined();
      });
    },
  });
}
