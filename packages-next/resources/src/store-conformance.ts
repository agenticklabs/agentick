/**
 * Conformance suite for {@link ResourceStore} implementations (data-layer plan
 * §6-C, the definition-library archetype's richest instance — run #9).
 *
 * Every adapter — the bundled {@link InMemoryResourceStore}, a future durable
 * backing, any adopter store — MUST pass this suite. The behaviors pinned here
 * are the substrate contract the {@link import("./harness.js").ResourcesHarness}
 * depends on: put→get round-trip of the SERIALIZABLE {@link ResourceDeclarationRecord}
 * slice, upsert-in-place, `list()` enumerate, the dual-key `kind` enumeration,
 * and the `uri`-substring filter. The store never sees a `resolver` — that is the
 * harness's sidecar, so there is nothing augmentation-shaped to conform here.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `undefined`; delete-of-absent idempotent) are delegated to the shared
 * {@link runStoreConformance} skeleton (`@agentick/store-next`); the
 * resource-specific cases are registered through its `cases` hook. Mirrors
 * `runPromptStoreConformance`. Usage from an adapter package's test file:
 *
 * ```ts
 * import { runResourceStoreConformance } from "@agentick/resources-next";
 * import { myResourceStore } from "../src/index.js";
 *
 * runResourceStoreConformance({ label: "my-store", factory: () => myResourceStore() });
 * ```
 */

import { expect, it } from "vitest";

import type { ResourceDeclarationRecord, ResourceStore } from "@agentick/spec-next";
import { runStoreConformance } from "@agentick/store-next";

export interface ResourceStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => ResourceStore | Promise<ResourceStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a store).
   * For adapters whose backend may be absent in the test env — compute
   * availability at the call site and pass `skip: !available`.
   */
  readonly skip?: boolean;
}

/** A minimal well-formed fixed declaration. */
function fixed(
  uri: string,
  over: Partial<ResourceDeclarationRecord> = {},
): ResourceDeclarationRecord {
  return { uri, kind: "fixed", meta: { name: uri }, ...over };
}

/** A minimal well-formed template declaration. */
function template(
  uriTemplate: string,
  over: Partial<ResourceDeclarationRecord> = {},
): ResourceDeclarationRecord {
  return { uriTemplate, kind: "template", meta: { name: uriTemplate }, ...over };
}

export function runResourceStoreConformance(opts: ResourceStoreConformanceOptions): void {
  runStoreConformance<ResourceStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    // Store-agnostic: unknown key → undefined; delete of an absent key settles.
    emptyRead: { read: (store, key) => store.get(key), expected: undefined },
    idempotentDelete: (store, key) => store.delete(key),
    cases: ({ setup }) => {
      it("put then get round-trips a fixed declaration (uri-keyed)", async () => {
        const store = await setup();
        const d = fixed("mem://doc", { meta: { name: "Doc", mimeType: "text/plain" } });
        await store.put(d);
        expect(await store.get("mem://doc")).toEqual(d);
      });

      it("put then get round-trips a template declaration (uriTemplate-keyed)", async () => {
        const store = await setup();
        const d = template("mem://users/{id}", { meta: { name: "User" } });
        await store.put(d);
        expect(await store.get("mem://users/{id}")).toEqual(d);
      });

      it("put upserts in place — a later put of the same key replaces", async () => {
        const store = await setup();
        await store.put(fixed("mem://x", { meta: { name: "old" } }));
        await store.put(fixed("mem://x", { meta: { name: "new" } }));
        expect((await store.get("mem://x"))?.meta?.name).toBe("new");
        expect(await store.list()).toHaveLength(1);
      });

      it("list() with no query returns every declaration (both kinds)", async () => {
        const store = await setup();
        await store.put(fixed("mem://a"));
        await store.put(template("mem://t/{id}"));
        const keys = (await store.list()).map((d) => d.uri ?? d.uriTemplate).sort();
        expect(keys).toEqual(["mem://a", "mem://t/{id}"]);
      });

      it("list({ kind }) enumerates one class only", async () => {
        const store = await setup();
        await store.put(fixed("mem://a"));
        await store.put(fixed("mem://b"));
        await store.put(template("mem://t/{id}"));
        const fixedOnly = await store.list({ kind: "fixed" });
        expect(fixedOnly.map((d) => d.uri).sort()).toEqual(["mem://a", "mem://b"]);
        const templatesOnly = await store.list({ kind: "template" });
        expect(templatesOnly.map((d) => d.uriTemplate)).toEqual(["mem://t/{id}"]);
      });

      it("list({ uri }) filters by key substring (case-insensitive)", async () => {
        const store = await setup();
        await store.put(fixed("mem://git/push"));
        await store.put(fixed("mem://git/pull"));
        await store.put(fixed("mem://docker/build"));
        const got = await store.list({ uri: "GIT" });
        expect(got.map((d) => d.uri).sort()).toEqual(["mem://git/pull", "mem://git/push"]);
      });

      it("delete() removes a declaration and is idempotent", async () => {
        const store = await setup();
        await store.put(fixed("mem://fade"));
        await store.delete("mem://fade");
        expect(await store.get("mem://fade")).toBeUndefined();
        expect(await store.list()).toEqual([]);
        // Second delete: absent → resolves, no throw.
        await expect(store.delete("mem://fade")).resolves.toBeUndefined();
      });
    },
  });
}
