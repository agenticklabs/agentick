/**
 * Store-backing spec for {@link PromptsHarness} (data-layer plan §6-C, Phase 5 —
 * the definition-library archetype's first **augmented instance**).
 *
 * Proves the record/sidecar SPLIT: the serializable
 * {@link import("@agentick/spec").PromptDeclarationRecord} slice lands in the
 * injected {@link PromptStore}; the non-serializable `{ template, render }`
 * augmentation stays in the harness sidecar and NEVER reaches the store; loaders
 * (`reload` / `resolve`) FEED both; `invoke`/`get` COMBINE the two halves back
 * into a full declaration; and the sync `record` read drops fns exactly as
 * before (Phase-4 sweep deletes it later).
 *
 * Also runs {@link runPromptStoreConformance} against {@link InMemoryPromptStore}.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";

import { PromptsHarness } from "../harness.js";
import { InMemoryPromptStore } from "../store.js";
import { runPromptStoreConformance } from "../store-conformance.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";

// ── store conformance: the bundled default passes the shared suite ──
runPromptStoreConformance({
  label: "InMemoryPromptStore",
  factory: () => new InMemoryPromptStore(),
});

function makeHarness(store: InMemoryPromptStore): PromptsHarness {
  return new PromptsHarness(
    `store-backing:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { store },
  );
}

describe("PromptsHarness — store backing (the augmentation split)", () => {
  it("register writes the record to the store but NOT the render/template fns", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({
      declaration: {
        name: "summarize",
        description: "Summarize",
        arguments: [{ name: "docId", required: true }],
        render: (args) => `Summarize ${String(args.docId)}`,
      },
    });

    // The durable store holds ONLY the serializable slice — no fns.
    const persisted = await store.get("summarize", stubStoreCtx());
    expect(persisted).toEqual({
      name: "summarize",
      description: "Summarize",
      arguments: [{ name: "docId", required: true }],
    });
    expect(persisted).not.toHaveProperty("render");
    expect(persisted).not.toHaveProperty("template");

    // The sync projection COMBINES record + sidecar back into the full declaration.
    const decl = h.get("summarize");
    expect(typeof decl?.render).toBe("function");
    // And it renders — the sidecar fn is live.
    const result = await h.render({ name: "summarize", args: { docId: "42" } });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "Summarize 42" }]);
    await h.close();
  });

  it("update propagates the record to the store; render stays sidecar-only", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({
      declaration: { name: "p", description: "old", render: () => "body" },
    });
    await h.update({ name: "p", declaration: { description: "new" } });

    expect((await store.get("p", stubStoreCtx()))?.description).toBe("new");
    expect(await store.get("p", stubStoreCtx())).not.toHaveProperty("render");
    // The sidecar render survives the update (not overwritten by the patch).
    expect(typeof h.get("p")?.render).toBe("function");
    await h.close();
  });

  it("remove drops the record from the store AND the sidecar", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({ declaration: { name: "p", description: "p", render: () => "x" } });
    await h.remove({ name: "p" });
    expect(await store.get("p", stubStoreCtx())).toBeUndefined();
    expect(h.has("p")).toBe(false);
    expect(h.get("p")).toBeUndefined();
    await h.close();
  });

  it("reload() feeds the store + sidecar from the source hydrator", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    h.setHydrator(
      hydrateFrom([
        { declaration: { name: "alpha", description: "A", render: () => "a" } },
        { declaration: { name: "beta", description: "B", template: "b" } },
      ]),
    );
    const summary = await h.reload();
    expect([...summary.added].sort()).toEqual(["alpha", "beta"]);
    // Records landed in the durable store (fns stripped).
    expect((await store.list(undefined, stubStoreCtx())).map((r) => r.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(await store.get("alpha", stubStoreCtx())).not.toHaveProperty("render");
    // But the harness can render alpha — its sidecar has the fn.
    const result = await h.render({ name: "alpha" });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "a" }]);
    await h.close();
  });

  it("resolve() lookup-on-miss populates the store + sidecar", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "lazy", description: "L", render: () => "l" } }]),
    );
    expect(await store.get("lazy", stubStoreCtx())).toBeUndefined();
    const resolved = await h.resolve("lazy");
    expect(resolved?.name).toBe("lazy");
    expect(typeof resolved?.render).toBe("function");
    // The lookup-on-miss registered the record — now durable (fns still sidecar).
    expect((await store.get("lazy", stubStoreCtx()))?.description).toBe("L");
    await h.close();
  });

  it("the record drops fns; hydrate() restores records only (sidecar empty)", async () => {
    // A shared store: h1 writes, a fresh h2 over the SAME store hydrates from it.
    const store = new InMemoryPromptStore();
    const h1 = makeHarness(store);
    await h1.ready;
    await h1.register({
      declaration: {
        name: "p",
        description: "P",
        arguments: [{ name: "x", required: true }],
        template: "hi",
      },
    });

    expect(h1.record("p")).toEqual({
      name: "p",
      description: "P",
      arguments: [{ name: "x", required: true }],
    });
    expect(h1.record("p")).not.toHaveProperty("template");
    await h1.close();

    // A resumed harness asks for the store read explicitly — prompts names no
    // default hydrator, so `hydrateFromStore()` is the opt-in (ADR 93).
    const h2 = new PromptsHarness(
      `store-backing:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: hydrateFromStore() },
    );
    await h2.ready;
    expect(h2.has("p")).toBe(false);
    await h2.hydrate();
    // Record survives; augmentation does not — content is gone until re-register.
    expect(h2.get("p")?.description).toBe("P");
    expect(h2.get("p")?.template).toBeUndefined();
    await expect(h2.render({ name: "p", args: { x: 1 } })).rejects.toMatchObject({
      _tag: "PromptMissingContent",
      promptName: "p",
    });
    await h2.close();
  });
});
