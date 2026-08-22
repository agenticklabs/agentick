/**
 * Store-backing spec for {@link ResourcesHarness} (data-layer plan §6-C, Phase 5
 * run #9 — the definition-library archetype's **richest instance**).
 *
 * Proves the durable/transient/sidecar three-way split:
 *   - DURABLE loader items → the injected {@link ResourceStore} (declaration) +
 *     the resolver sidecar; the store holds NO resolver fn.
 *   - TRANSIENT `register` / `registerTemplate` → registry-only (projection +
 *     sidecar), NEVER the store.
 *   - `resolverFor` semantics unchanged: fixed-first, then template-match.
 *   - `snapshot()` folds durable + transient declarations into one catalog.
 *   - the harness is NOT `CheckpointCapable` (genesis `hydrate`, no `persist`).
 *
 * Also runs {@link runResourceStoreConformance} against {@link InMemoryResourceStore}.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ResourceContents, ResourceStore } from "@agentick/spec";
import { isCheckpointCapable } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";

import { ResourcesHarness } from "../harness.js";
import { InMemoryResourceStore } from "../store.js";
import { runResourceStoreConformance } from "../store-conformance.js";
import { fromArray, type ResourceLoaderItem } from "../loaders.js";

// ── store conformance: the bundled default passes the shared suite ──
runResourceStoreConformance({
  label: "InMemoryResourceStore",
  factory: () => new InMemoryResourceStore(),
});

function text(uri: string, body: string): ResourceContents {
  return { uri, mimeType: "text/plain", text: body };
}

function makeHarness(store: ResourceStore): ResourcesHarness {
  return new ResourcesHarness(
    `store-backing:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { store },
  );
}

describe("ResourcesHarness — store backing (durable / transient / sidecar split)", () => {
  it("a durable loader feeds the store (declaration) + the sidecar (resolver)", async () => {
    const store = new InMemoryResourceStore();
    const h = makeHarness(store);
    await h.ready;
    h.setLoaders([
      fromArray([
        {
          declaration: {
            uri: "db://doc",
            kind: "fixed",
            meta: { name: "Doc", mimeType: "text/plain" },
          },
          resolver: () => [text("db://doc", "content")],
        },
        {
          declaration: { uriTemplate: "db://users/{id}", kind: "template", meta: { name: "User" } },
          resolver: (uri) => [text(uri, `user:${uri}`)],
        },
      ]),
    ]);

    const summary = await h.reload();
    expect([...summary.added].sort()).toEqual(["db://doc", "db://users/{id}"]);

    // The durable store holds ONLY the declaration slice — no resolver fn.
    const persisted = await store.get("db://doc", stubStoreCtx());
    expect(persisted).toEqual({
      uri: "db://doc",
      kind: "fixed",
      meta: { name: "Doc", mimeType: "text/plain" },
    });
    expect(persisted).not.toHaveProperty("resolver");
    const persistedTemplate = await store.get("db://users/{id}", stubStoreCtx());
    expect(persistedTemplate?.kind).toBe("template");
    expect(persistedTemplate).not.toHaveProperty("resolver");

    // But the harness resolves both — the resolver lives in the sidecar.
    expect(await h.read("db://doc")).toEqual([text("db://doc", "content")]);
    expect(await h.read("db://users/7")).toEqual([text("db://users/7", "user:db://users/7")]);
    await h.close();
  });

  it("transient register / registerTemplate stay registry-only (NOT in the store)", async () => {
    const store = new InMemoryResourceStore();
    const h = makeHarness(store);
    await h.ready;
    h.register("mem://live", () => [text("mem://live", "x")], { name: "Live" });
    h.registerTemplate("mem://t/{id}", (uri) => [text(uri, uri)]);

    // Present in the catalog + resolvable...
    expect(h.has("mem://live")).toBe(true);
    expect(await h.read("mem://live")).toEqual([text("mem://live", "x")]);
    expect(await h.read("mem://t/9")).toEqual([text("mem://t/9", "mem://t/9")]);

    // ...but the durable store never saw them.
    expect(await store.get("mem://live", stubStoreCtx())).toBeUndefined();
    expect(await store.get("mem://t/{id}", stubStoreCtx())).toBeUndefined();
    expect(await store.list(undefined, stubStoreCtx())).toEqual([]);
    await h.close();
  });

  it("resolverFor prefers a fixed binding over a matching template (unchanged)", async () => {
    const store = new InMemoryResourceStore();
    const h = makeHarness(store);
    await h.ready;
    h.registerTemplate("mem://users/{id}", (uri) => [text(uri, "template")]);
    h.register("mem://users/root", () => [text("mem://users/root", "fixed")]);
    expect((await h.read("mem://users/root"))[0]).toMatchObject({ text: "fixed" });
    expect((await h.read("mem://users/99"))[0]).toMatchObject({ text: "template" });
    await h.close();
  });

  it("snapshot() catalog combines durable + transient declarations", async () => {
    const store = new InMemoryResourceStore();
    const h = makeHarness(store);
    await h.ready;
    h.setLoaders([
      fromArray([
        {
          declaration: { uri: "db://doc", kind: "fixed", meta: { name: "Doc" } },
          resolver: () => [text("db://doc", "d")],
        },
        {
          declaration: { uriTemplate: "db://u/{id}", kind: "template", meta: { name: "DbUser" } },
          resolver: (uri) => [text(uri, uri)],
        },
      ]),
    ]);
    await h.reload();
    h.register("mem://live", () => [text("mem://live", "x")], { name: "Live" });
    h.registerTemplate("mem://t/{id}", (uri) => [text(uri, uri)], { name: "LiveT" });

    const snap = h.snapshot();
    expect(snap.resources.map((r) => r.uri).sort()).toEqual(["db://doc", "mem://live"]);
    expect(snap.templates.map((t) => t.uriTemplate).sort()).toEqual([
      "db://u/{id}",
      "mem://t/{id}",
    ]);
    // Descriptor metadata comes through for both source classes.
    expect(snap.resources.find((r) => r.uri === "db://doc")?.name).toBe("Doc");
    expect(snap.resources.find((r) => r.uri === "mem://live")?.name).toBe("Live");
    await h.close();
  });

  it("lookup-on-miss populates store + sidecar from the loaders (fixed)", async () => {
    const store = new InMemoryResourceStore();
    const h = makeHarness(store);
    await h.ready;
    h.setLoaders([
      fromArray([
        {
          declaration: { uri: "db://lazy", kind: "fixed", meta: { name: "Lazy" } },
          resolver: () => [text("db://lazy", "loaded")],
        } satisfies ResourceLoaderItem,
      ]),
    ]);
    // Not yet loaded — a read triggers lookup-on-miss.
    expect(await store.get("db://lazy", stubStoreCtx())).toBeUndefined();
    expect(await h.read("db://lazy")).toEqual([text("db://lazy", "loaded")]);
    // The miss registered the declaration — now durable (resolver still sidecar-only).
    expect((await store.get("db://lazy", stubStoreCtx()))?.meta?.name).toBe("Lazy");
    expect(await store.get("db://lazy", stubStoreCtx())).not.toHaveProperty("resolver");
    await h.close();
  });

  it("hydrate() surfaces durable declarations in the catalog; read waits for the resolver", async () => {
    // h1 loads durable declarations into a SHARED store; a fresh h2 over the same
    // store hydrates the catalog but has no resolver until the loaders re-run.
    const store = new InMemoryResourceStore();
    const h1 = makeHarness(store);
    await h1.ready;
    const items: readonly ResourceLoaderItem[] = [
      {
        declaration: { uri: "db://doc", kind: "fixed", meta: { name: "Doc" } },
        resolver: () => [text("db://doc", "content")],
      },
    ];
    h1.setLoaders([fromArray(items)]);
    await h1.reload();
    await h1.close();

    const h2 = makeHarness(store);
    await h2.ready;
    expect(h2.has("db://doc")).toBe(false);
    await h2.hydrate();
    // Declaration surfaces in the catalog...
    expect(h2.has("db://doc")).toBe(true);
    expect(h2.snapshot().resources.find((r) => r.uri === "db://doc")?.name).toBe("Doc");
    // ...but read throws until the resolver is re-attached (sidecar didn't survive).
    await expect(h2.read("db://doc")).rejects.toMatchObject({ _tag: "ResourceNotFound" });
    // Re-running the loaders re-attaches the resolver → read works.
    h2.setLoaders([fromArray(items)]);
    await h2.reload();
    expect(await h2.read("db://doc")).toEqual([text("db://doc", "content")]);
    await h2.close();
  });

  it("is NOT CheckpointCapable — genesis hydrate is not the checkpoint contract", async () => {
    // `hydrate()` here is GENESIS (ADR 93), not the resume half of a checkpoint
    // pair: the resolver sidecar does not survive it, so a session-driven
    // restore would surface a catalog whose reads throw. The session's fold is
    // feature-detected on `persist` + `hydrate` TOGETHER, so adding a `persist`
    // beside this `hydrate` enrolls the harness silently.
    const h = makeHarness(new InMemoryResourceStore());
    await h.ready;
    expect(isCheckpointCapable(h)).toBe(false);
    await h.close();
  });
});
