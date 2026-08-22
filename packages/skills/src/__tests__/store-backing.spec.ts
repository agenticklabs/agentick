/**
 * Store-backing spec for {@link SkillsHarness} (data-layer plan §6-C, Phase 5).
 *
 * Proves the harness is store-DERIVED and store-PERSISTED: mutations land in the
 * injected {@link SkillStore}; the source surface (`reload` / `resolve`) FEEDS the
 * store; `search` filters correctly through the sync projection; and a fresh
 * harness over the same store reopens on it via `hydrateFromStore()`.
 *
 * Also runs {@link runSkillStoreConformance} against {@link InMemorySkillStore}.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";

import { SkillsHarness } from "../harness.js";
import { InMemorySkillStore } from "../store.js";
import { runSkillStoreConformance } from "../store-conformance.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";

// ── store conformance: the bundled default passes the shared suite ──
runSkillStoreConformance({
  label: "InMemorySkillStore",
  factory: () => new InMemorySkillStore(),
});

function makeHarness(store: InMemorySkillStore): SkillsHarness {
  return new SkillsHarness(
    `store-backing:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { store },
  );
}

describe("SkillsHarness — store backing", () => {
  it("register writes through to the injected store", async () => {
    const store = new InMemorySkillStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({ name: "git_push", description: "Push", content: "git push", tags: ["git"] });

    // The durable store holds the whole record (skills have no augmentation).
    const persisted = await store.get("git_push", stubStoreCtx());
    expect(persisted?.name).toBe("git_push");
    expect(persisted?.tags).toEqual(["git"]);
    expect(persisted?.createdAt).toBeGreaterThan(0);
    // Sync projection reflects it immediately.
    expect(h.get("git_push")?.content).toBe("git push");
    await h.close();
  });

  it("update + remove propagate to the store", async () => {
    const store = new InMemorySkillStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({ name: "task", description: "old", content: "body" });
    await h.update({ name: "task", description: "new" });
    expect((await store.get("task", stubStoreCtx()))?.description).toBe("new");

    await h.remove({ name: "task" });
    expect(await store.get("task", stubStoreCtx())).toBeUndefined();
    expect(h.has("task")).toBe(false);
    await h.close();
  });

  it("reload() feeds the store from the source hydrator", async () => {
    const store = new InMemorySkillStore();
    const h = makeHarness(store);
    await h.ready;
    h.setHydrator(
      hydrateFrom([
        { name: "alpha", description: "A", content: "a" },
        { name: "beta", description: "B", content: "b" },
      ]),
    );
    const summary = await h.reload();
    expect([...summary.added].sort()).toEqual(["alpha", "beta"]);
    // Source output landed in the durable store, not just the projection —
    // a reload is an OP, unlike genesis.
    expect((await store.list(undefined, stubStoreCtx())).map((s) => s.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    await h.close();
  });

  it("resolve() lookup-on-miss populates the store", async () => {
    const store = new InMemorySkillStore();
    const h = makeHarness(store);
    await h.ready;
    h.setHydrator(hydrateFrom([{ name: "lazy", description: "L", content: "l" }]));
    expect(await store.get("lazy", stubStoreCtx())).toBeUndefined();
    const resolved = await h.resolve("lazy");
    expect(resolved?.name).toBe("lazy");
    // The lookup-on-miss registered it — now durable.
    expect((await store.get("lazy", stubStoreCtx()))?.content).toBe("l");
    await h.close();
  });

  it("search filters through the sync projection", async () => {
    const store = new InMemorySkillStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({
      name: "git_push",
      description: "Push to remote",
      content: "x",
      tags: ["git"],
    });
    await h.register({
      name: "git_pull",
      description: "Pull from remote",
      content: "x",
      tags: ["git"],
    });
    await h.register({
      name: "docker_build",
      description: "Build image",
      content: "x",
      tags: ["docker"],
    });
    expect(
      h
        .search({ query: "remote" })
        .map((s) => s.name)
        .sort(),
    ).toEqual(["git_pull", "git_push"]);
    expect(h.search({ tagsAny: ["docker"] }).map((s) => s.name)).toEqual(["docker_build"]);
    await h.close();
  });

  it("a register writes through to the store, and hydrateFromStore() reopens on it", async () => {
    // A shared store: h1 writes, a fresh h2 over the SAME store hydrates from it.
    const store = new InMemorySkillStore();
    const h1 = makeHarness(store);
    await h1.ready;
    await h1.register({ name: "a", description: "A", content: "aa" });
    await h1.register({ name: "b", description: "B", content: "bb" });

    expect(
      h1
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["a", "b"]);
    await h1.close();

    // A resumed harness asks for the store read explicitly — skills names no
    // default hydrator, so `hydrateFromStore()` is the opt-in (ADR 93).
    const h2 = new SkillsHarness(
      `store-backing:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: hydrateFromStore() },
    );
    await h2.ready;
    // Fresh projection is empty until genesis pulls the durable store in.
    expect(h2.has("a")).toBe(false);
    await h2.hydrate();
    expect(h2.get("a")?.content).toBe("aa");
    expect(h2.get("b")?.description).toBe("B");
    await h2.close();
  });
});
