/**
 * Conformance suite for {@link SkillStore} implementations (data-layer plan
 * §6-C, the definition-library archetype).
 *
 * Every adapter — the bundled {@link InMemorySkillStore}, a future
 * `@agentick/skills-store-postgres`, a filesystem source, any adopter store
 * — MUST pass this suite. The behaviors pinned here are the substrate contract
 * the {@link SkillsHarness} depends on: put→get round-trip, upsert-in-place,
 * `list()` enumerate, and the substring + tag `list(query)` filter (the async
 * twin of the harness's synchronous `search()`).
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store`); the
 * skill-specific cases are registered through its `cases` hook. Mirrors
 * `runTaskStoreConformance` / `runTimelineStoreConformance`. Usage from an
 * adapter package's test file:
 *
 * ```ts
 * import { runSkillStoreConformance } from "@agentick/skills/testing";
 * import { mySkillStore } from "../src/index.js";
 *
 * runSkillStoreConformance({ label: "my-store", factory: () => mySkillStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { Skill, SkillStore } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";
import { runStoreConformance } from "@agentick/store/testing";

export interface SkillStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => SkillStore | Promise<SkillStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a store).
   * For adapters whose backend may be absent in the test env — compute
   * availability at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
}

/** Minimal well-formed record — the store treats records as opaque blobs. */
function skill(name: string, over: Partial<Skill> = {}): Skill {
  const now = Date.now();
  return {
    name,
    description: `${name} description`,
    content: `${name} body`,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function runSkillStoreConformance(opts: SkillStoreConformanceOptions): void {
  runStoreConformance<SkillStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    // Store-agnostic: unknown key → undefined; delete of an absent key settles.
    emptyRead: { read: (store, key) => store.get(key, stubStoreCtx()), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key, stubStoreCtx()),
    cases: ({ setup }) => {
      it("put then get round-trips the record (name-keyed)", async () => {
        const store = await setup();
        const r = skill("git_push", { tags: ["git", "vcs"] });
        await store.put(r, stubStoreCtx());
        expect(await store.get("git_push", stubStoreCtx())).toEqual(r);
      });

      it("put upserts in place — a later put of the same name replaces", async () => {
        const store = await setup();
        await store.put(skill("git_push", { description: "old" }), stubStoreCtx());
        await store.put(
          skill("git_push", { description: "new", content: "new body" }),
          stubStoreCtx(),
        );
        const got = await store.get("git_push", stubStoreCtx());
        expect(got?.description).toBe("new");
        expect(got?.content).toBe("new body");
        // Still one record, not two.
        expect(await store.list(undefined, stubStoreCtx())).toHaveLength(1);
      });

      it("list() with no query returns every record", async () => {
        const store = await setup();
        await store.put(skill("a"), stubStoreCtx());
        await store.put(skill("b"), stubStoreCtx());
        expect((await store.list(undefined, stubStoreCtx())).map((s) => s.name).sort()).toEqual([
          "a",
          "b",
        ]);
      });

      it("list(query) filters by substring across name + description (case-insensitive)", async () => {
        const store = await setup();
        await store.put(skill("git_push", { description: "Push to remote" }), stubStoreCtx());
        await store.put(skill("git_pull", { description: "Pull from remote" }), stubStoreCtx());
        await store.put(skill("docker_build", { description: "Build an image" }), stubStoreCtx());
        const got = await store.list({ query: "REMOTE" }, stubStoreCtx());
        expect(got.map((s) => s.name).sort()).toEqual(["git_pull", "git_push"]);
      });

      it("list(query) filters by tagsAny (OR) and tagsAll (AND)", async () => {
        const store = await setup();
        await store.put(skill("git_push", { tags: ["git", "vcs"] }), stubStoreCtx());
        await store.put(skill("ssh_to_host", { tags: ["ssh", "network"] }), stubStoreCtx());
        await store.put(skill("docker_build", { tags: ["docker"] }), stubStoreCtx());
        const any = await store.list({ tagsAny: ["vcs", "docker"] }, stubStoreCtx());
        expect(any.map((s) => s.name).sort()).toEqual(["docker_build", "git_push"]);
        const all = await store.list({ tagsAll: ["git", "vcs"] }, stubStoreCtx());
        expect(all.map((s) => s.name)).toEqual(["git_push"]);
        const none = await store.list({ tagsAll: ["git", "docker"] }, stubStoreCtx());
        expect(none).toEqual([]);
      });

      /**
       * `version` is a DECLARED CONTRACT, not an incidental field (#249). It is
       * the string the run's provenance stamp copies verbatim into the timeline,
       * so "which revision of this skill produced this message" is answerable
       * from the entry alone — and that answer is only as good as the store's
       * fidelity. An adapter that drops or normalizes `version` silently breaks
       * provenance for every skill it holds, with nothing else failing. Hence a
       * conformance case: every adapter must satisfy it.
       *
       * Absence is part of the contract too. The framework NEVER computes a
       * version, so a record that declared none must come back declaring none —
       * an adapter defaulting it to `""` or `"1"` would invent history.
       */
      it("round-trips `version` verbatim, and absence stays absence", async () => {
        const store = await setup();
        await store.put(skill("stamped", { version: "2026.07.30-a3f1c9" }), stubStoreCtx());
        await store.put(skill("unstamped"), stubStoreCtx());

        expect((await store.get("stamped", stubStoreCtx()))?.version).toBe("2026.07.30-a3f1c9");
        expect((await store.get("unstamped", stubStoreCtx()))?.version).toBeUndefined();

        // And through the enumerate lane, not just the single read.
        const listed = await store.list(undefined, stubStoreCtx());
        expect(listed.find((s) => s.name === "stamped")?.version).toBe("2026.07.30-a3f1c9");
        expect(listed.find((s) => s.name === "unstamped")?.version).toBeUndefined();
      });

      it("delete() removes a record and is idempotent", async () => {
        const store = await setup();
        await store.put(skill("fade"), stubStoreCtx());
        await store.delete("fade", stubStoreCtx());
        expect(await store.get("fade", stubStoreCtx())).toBeUndefined();
        expect(await store.list(undefined, stubStoreCtx())).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("fade", stubStoreCtx())).resolves.toBeUndefined();
      });
    },
  });
}
