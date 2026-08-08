/**
 * Per-argument completion through the {@link PromptsHarness} — the record/sidecar
 * split for `arguments[].complete` (completions.md §2.1–§2.2, §4).
 *
 * The fixture is the doc's own reference prompt (`job` → async source, `phase` →
 * dependent on `job`, `markup_pct` → static list), authored with
 * {@link definePrompt} and the real builders from `@agentick/completions` — so
 * these pin the two packages against each other, not against a hand-rolled
 * lookalike.
 *
 * Pins:
 *   - an INLINE resolver never reaches the store: the persisted record carries a
 *     derived `completeRef` and survives a JSON round-trip;
 *   - `completeRequires` is populated from `completeDependent`'s metadata, read
 *     STRUCTURALLY (see `../completion.ts` on why prompts does not import the
 *     canonical guard);
 *   - a NAMED ref is copied verbatim and side-cars nothing;
 *   - `get`/`list` re-join the split back into the author's shape;
 *   - `update` / `remove` / `importSnapshot` / genesis each keep the two halves in
 *     step;
 *   - a wire-delivered `complete` is stripped at RUNTIME, not just by the type.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";
import {
  completeDependent,
  completeFromAsync,
  completeFromList,
  defineCompletion,
} from "@agentick/completions";
import type { PromptDeclaration } from "@agentick/spec";

import { definePrompt } from "../define-prompt.js";
import { promptCompletionRef } from "../completion.js";
import { PromptsHarness } from "../harness.js";
import { hydrateFrom } from "../hydrators.js";
import { InMemoryPromptStore } from "../store.js";

const NAME = "tm_change_order_actual_cost";

const jobs = completeFromAsync(async (value) => [`Miller Residence ${value}`]);
const phases = completeDependent({ requires: ["job"] }, (value, { job }) => [`${job}:${value}`]);
const markup = completeFromList(["10", "15", "20", "25", "30"]);

/** The completions.md §2.1 declaration, verbatim in shape. */
function referencePrompt(): PromptDeclaration {
  return definePrompt({
    name: NAME,
    description: "Log an actual cost against a change order.",
    arguments: [
      { name: "job", required: true, complete: jobs },
      { name: "phase", required: true, complete: phases },
      { name: "markup_pct", required: false, complete: markup },
    ],
    render: (args) => `${args.job} / ${args.phase} / ${args.markup_pct ?? "default"}`,
  });
}

function makeHarness(store: InMemoryPromptStore = new InMemoryPromptStore()): PromptsHarness {
  return new PromptsHarness(
    `completion:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { store },
  );
}

describe("PromptsHarness — inline resolvers stay out of durability", () => {
  it("persists a derived completeRef and never the function", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const persisted = await store.get(NAME, stubStoreCtx());
    expect(persisted?.arguments).toEqual([
      { name: "job", required: true, completeRef: `prompt:${NAME}:job` },
      {
        name: "phase",
        required: true,
        completeRef: `prompt:${NAME}:phase`,
        completeRequires: ["job"],
      },
      { name: "markup_pct", required: false, completeRef: `prompt:${NAME}:markup_pct` },
    ]);
    // The probe that would catch a leak the `toEqual` above cannot: a function
    // property survives neither JSON nor a `structuredClone` to another process.
    const json = JSON.stringify(persisted);
    expect(json).not.toContain('complete"');
    expect(JSON.parse(json)).toEqual(persisted);
  });

  it("derives the ref through the one grammar site", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });
    // The RECORD is where `completeRef` is typed — and the record is what a client
    // reads (`prompts:get` / `prompts:list` project this slice onto the wire). An
    // in-process reader has the resolver itself and needs no ref.
    const args = h.exportSnapshot()[NAME].arguments ?? [];
    expect(args.map((a) => a.completeRef)).toEqual([
      promptCompletionRef(NAME, "job"),
      promptCompletionRef(NAME, "phase"),
      promptCompletionRef(NAME, "markup_pct"),
    ]);
  });

  it("re-joins the sidecar so an in-process reader sees the author's shape", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const args = h.get(NAME)?.arguments ?? [];
    expect(args[0].complete).toBe(jobs);
    expect(args[1].complete).toBe(phases);
    expect(args[2].complete).toBe(markup);
    // `list()` goes through the same re-join.
    expect(h.list()[0].arguments?.[1].complete).toBe(phases);
  });

  it("strips a wire-delivered `complete` at runtime, not just in the type", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    // What an inbound `prompts:register` payload can carry regardless of the type.
    await h.register({
      declaration: {
        name: "wire",
        description: "d",
        template: "t",
        arguments: [{ name: "who", complete: () => ["a"] }],
      } as PromptDeclaration,
    });
    const persisted = await store.get("wire", stubStoreCtx());
    expect(persisted?.arguments?.[0]).not.toHaveProperty("complete");
    expect(persisted?.arguments?.[0].completeRef).toBe(promptCompletionRef("wire", "who"));
  });

  it("leaves arguments untouched when none of them complete", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({
      declaration: {
        name: "plain",
        description: "d",
        template: "t",
        arguments: [{ name: "docId", required: true }],
      },
    });
    const persisted = await store.get("plain", stubStoreCtx());
    // No `completeRef: undefined` noise — a record only carries what it has.
    expect(Object.keys(persisted?.arguments?.[0] ?? {})).toEqual(["name", "required"]);
  });
});

describe("PromptsHarness — the named-ref form", () => {
  it("copies the registry name verbatim and side-cars nothing", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    await h.register({
      declaration: {
        name: "named",
        description: "d",
        template: "t",
        arguments: [{ name: "job", required: true, complete: "knowify.jobs" }],
      },
    });

    const persisted = await store.get("named", stubStoreCtx());
    expect(persisted?.arguments?.[0]).toEqual({
      name: "job",
      required: true,
      completeRef: "knowify.jobs",
    });
    // `completeRequires` stays undefined for a named ref — the REGISTRY knows the
    // resolver's dependencies; projecting them is the P2 enumeration concern.
    expect(persisted?.arguments?.[0].completeRequires).toBeUndefined();
    // Restored as the string it always was.
    expect(h.get("named")?.arguments?.[0].complete).toBe("knowify.jobs");
  });

  it("keeps a defineCompletion source's own name instead of aliasing it", async () => {
    const store = new InMemoryPromptStore();
    const h = makeHarness(store);
    await h.ready;
    // The dual use `defineCompletion` advertises: a NAMED source handed straight to
    // a `complete:` slot. It is a function, so it side-cars; it has an address, so
    // the record uses that one rather than a derived second name.
    const named = defineCompletion("knowify.jobs", jobs);
    await h.register({
      declaration: {
        name: "dual",
        description: "d",
        template: "t",
        arguments: [{ name: "job", required: true, complete: named }],
      },
    });
    const persisted = await store.get("dual", stubStoreCtx());
    expect(persisted?.arguments?.[0].completeRef).toBe("knowify.jobs");
    expect(h.get("dual")?.arguments?.[0].complete).toBe(named);
  });
});

describe("PromptsHarness — the split stays in step", () => {
  it("an arguments patch replaces resolvers; a silent patch keeps them", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    // Silent about arguments — both halves survive.
    await h.update({ name: NAME, declaration: { description: "reworded" } });
    expect(h.get(NAME)?.description).toBe("reworded");
    expect(h.get(NAME)?.arguments?.[0].complete).toBe(jobs);

    // Names arguments — the whole list, resolvers included, is replaced.
    const replacement = completeFromList(["only"]);
    await h.update({
      name: NAME,
      declaration: { arguments: [{ name: "job", required: true, complete: replacement }] },
    });
    const args = h.get(NAME)?.arguments ?? [];
    expect(args).toHaveLength(1);
    expect(args[0].complete).toBe(replacement);
  });

  it("remove drops the sidecar with the record", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });
    await h.remove({ name: NAME });
    expect(h.get(NAME)).toBeUndefined();

    // Re-registering without completions leaves nothing of the old ones behind.
    await h.register({
      declaration: { name: NAME, description: "d", template: "t", arguments: [{ name: "job" }] },
    });
    expect(h.get(NAME)?.arguments?.[0].complete).toBeUndefined();
  });

  it("importSnapshot clears resolvers but keeps the projectable metadata", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const snapshot = h.exportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain('complete"');

    const restored = makeHarness();
    await restored.ready;
    restored.importSnapshot(snapshot);
    // The fn did not survive — and a DERIVED ref with no sidecar restores to no
    // `complete` rather than an address nothing answers to.
    expect(restored.get(NAME)?.arguments?.[1].complete).toBeUndefined();
    // What a palette still reads, off the record slice it reads everything from:
    // the ref and the dependency.
    const record = restored.exportSnapshot()[NAME].arguments?.[1];
    expect(record?.completeRef).toBe(promptCompletionRef(NAME, "phase"));
    expect(record?.completeRequires).toEqual(["job"]);
  });

  it("genesis seeds the sidecar the same way register does", async () => {
    const store = new InMemoryPromptStore();
    const h = new PromptsHarness(
      `completion:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: hydrateFrom([{ declaration: referencePrompt() }]) },
    );
    await h.ready;
    await h.hydrate();

    expect(h.get(NAME)?.arguments?.[1].complete).toBe(phases);
    // Genesis is a SEED — no store write — so the record's shape is only
    // observable through the view. `exportSnapshot` materializes it.
    const record = h.exportSnapshot()[NAME].arguments?.[1];
    expect(record?.completeRef).toBe(promptCompletionRef(NAME, "phase"));
    expect(record?.completeRequires).toEqual(["job"]);
  });

  it("still renders with the arguments it validated", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });
    const result = await h.render({
      name: NAME,
      args: { job: "Miller Residence", phase: "Framing" },
    });
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Miller Residence / Framing / default" },
    ]);
  });
});
