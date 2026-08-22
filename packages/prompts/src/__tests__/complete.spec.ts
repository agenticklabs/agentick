/**
 * `PromptsHarness.complete` — the argument-completion door (completions.md §7 P2).
 *
 * The door answers a three-arm union because prompts holds only one half of the
 * completion split, and each arm is pinned here against the REAL builders from
 * `@agentick/completions` (a devDependency, so these tests hold the two packages
 * to each other rather than to a hand-rolled lookalike):
 *
 *   - an INLINE resolver runs here and answers `resolved`, with the sibling
 *     arguments reaching its ctx so a dependent resolver can do its job;
 *   - a NAMED ref answers `ref` — this package will not chase a registry it does
 *     not depend on;
 *   - nothing to ask answers `unavailable`: an argument with no `complete`, an
 *     argument name the prompt does not have (MCP parity — completion never
 *     protocol-errors on an unknown argument), and a restored declaration whose
 *     sidecar did not survive;
 *   - an unknown PROMPT throws, because the caller named something that does not
 *     exist;
 *   - a throwing resolver surfaces as `CompletionResolveFailed` carrying both the
 *     original cause and the resolver's real ADDRESS;
 *   - and the whole door writes NOTHING to the journal, which is the reason it is
 *     a plain method instead of a command.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import {
  completeDependent,
  completeFromAsync,
  completeFromList,
  defineCompletion,
  normalizeCompletionResult,
} from "@agentick/completions";
import { CompletionResolveFailed, PromptNotFound } from "@agentick/spec";
import type { CompletionCtx, CompletionResolver, PromptDeclaration } from "@agentick/spec";

import { foldCompletionValues, promptCompletionRef } from "../completion.js";
import { definePrompt } from "../define-prompt.js";
import { PromptsHarness, type PromptsHarnessOptions } from "../harness.js";
import { hydrateFromStore } from "../hydrators.js";
import { InMemoryPromptStore } from "../store.js";

const NAME = "tm_change_order_actual_cost";

function makeHarness(
  store: InMemoryPromptStore = new InMemoryPromptStore(),
  hydrate?: PromptsHarnessOptions["hydrate"],
  sessionId = "sess-complete",
): PromptsHarness {
  return new PromptsHarness(
    `complete:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { store, parentScope: { sessionId }, ...(hydrate ? { hydrate } : {}) },
  );
}

/** The completions.md §2.1 reference prompt: inline, dependent, static, and bare. */
function referencePrompt(): PromptDeclaration {
  return definePrompt({
    name: NAME,
    description: "Log an actual cost against a change order.",
    arguments: [
      {
        name: "job",
        required: true,
        complete: completeFromAsync((value) => [`Miller Residence`, `Milford Barn ${value}`]),
      },
      {
        name: "phase",
        required: true,
        complete: completeDependent({ requires: ["job"] }, (value, { job }) => [
          `${job}:framing:${value}`,
        ]),
      },
      { name: "markup_pct", complete: completeFromList(["10", "15", "20", "25", "30"]) },
      { name: "memo" },
    ],
    render: () => "…",
  });
}

describe("PromptsHarness.complete — the resolved arm", () => {
  it("runs an inline resolver and folds a bare array into the result shape", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const outcome = await h.complete({ name: NAME, argument: { name: "job", value: "Mil" } });

    expect(outcome).toEqual({
      kind: "resolved",
      result: { values: ["Miller Residence", "Milford Barn Mil"] },
    });
    await h.close();
  });

  it("prefix-filters through the real builder — the first keystroke is not special", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const all = await h.complete({ name: NAME, argument: { name: "markup_pct", value: "" } });
    const narrowed = await h.complete({ name: NAME, argument: { name: "markup_pct", value: "2" } });

    expect(all).toMatchObject({ result: { values: ["10", "15", "20", "25", "30"] } });
    expect(narrowed).toMatchObject({ result: { values: ["20", "25"] } });
    await h.close();
  });

  it("passes `context.arguments` to a dependent resolver as its sibling values", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const gated = await h.complete({ name: NAME, argument: { name: "phase", value: "fra" } });
    const satisfied = await h.complete({
      name: NAME,
      argument: { name: "phase", value: "fra" },
      context: { arguments: { job: "Miller Residence" } },
    });

    // `completeDependent` gates on unmet requirements WITHOUT invoking its body,
    // so the empty answer here is the builder's, not an error.
    expect(gated).toEqual({ kind: "resolved", result: { values: [] } });
    expect(satisfied).toEqual({
      kind: "resolved",
      result: { values: ["Miller Residence:framing:fra"] },
    });
    await h.close();
  });

  it("mints a ctx carrying the session trunk, the facets, and the signal", async () => {
    const seen: CompletionCtx[] = [];
    const controller = new AbortController();
    const probe: CompletionResolver = (_value, ctx) => {
      seen.push(ctx);
      return [];
    };
    const h = makeHarness(new InMemoryPromptStore(), undefined, "sess-trunk");
    await h.ready;
    await h.register({
      declaration: definePrompt({
        name: "probe",
        description: "…",
        arguments: [{ name: "arg", complete: probe }],
        render: () => "…",
      }),
    });

    await h.complete({
      name: "probe",
      argument: { name: "arg", value: "x" },
      context: { arguments: { other: "value" } },
      signal: controller.signal,
    });

    const ctx = seen[0]!;
    expect(ctx.sessionId).toBe("sess-trunk");
    expect(ctx.resolvedArguments).toEqual({ other: "value" });
    expect(ctx.signal).toBe(controller.signal);
    // Derived, not hand-assembled: the diagnostic facets are present.
    expect(typeof ctx.log).toBe("function");
    expect(typeof ctx.metrics.count).toBe("function");
    expect(typeof ctx.run).toBe("function");
    await h.close();
  });

  it("resolves a `defineCompletion` source inline rather than making the caller re-fetch it", async () => {
    // A NAMED source handed straight to a `complete:` slot is both halves at
    // once: it side-cars like a function and keeps its own registry name. The
    // door runs it — same resolver, one fewer hop than answering `ref`.
    const jobs = defineCompletion(
      "knowify.jobs",
      completeFromAsync(() => ["Miller Residence"]),
    );
    const h = makeHarness();
    await h.ready;
    await h.register({
      declaration: definePrompt({
        name: "named",
        description: "…",
        arguments: [{ name: "job", complete: jobs }],
        render: () => "…",
      }),
    });

    expect(await h.complete({ name: "named", argument: { name: "job", value: "" } })).toEqual({
      kind: "resolved",
      result: { values: ["Miller Residence"] },
    });
    await h.close();
  });
});

describe("PromptsHarness.complete — the ref arm", () => {
  it("hands back a named registry ref verbatim instead of resolving it", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({
      declaration: definePrompt({
        name: "byref",
        description: "…",
        arguments: [{ name: "job", complete: "knowify.jobs" }],
        render: () => "…",
      }),
    });

    expect(await h.complete({ name: "byref", argument: { name: "job", value: "Mil" } })).toEqual({
      kind: "ref",
      completeRef: "knowify.jobs",
    });
    await h.close();
  });
});

describe("PromptsHarness.complete — the unavailable arm", () => {
  it("answers unavailable for an argument that declares no completion", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    expect(await h.complete({ name: NAME, argument: { name: "memo", value: "x" } })).toEqual({
      kind: "unavailable",
    });
    await h.close();
  });

  it("answers unavailable for an argument the prompt does not have (never an error)", async () => {
    const h = makeHarness();
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    expect(await h.complete({ name: NAME, argument: { name: "no_such_arg", value: "x" } })).toEqual(
      { kind: "unavailable" },
    );
    await h.close();
  });

  it("answers unavailable when the record has no sidecar", async () => {
    // The sidecar (`template` / `render` / an INLINE `complete`) is
    // harness-local — it never reaches the store, so a harness that opened on
    // the durable record alone has the `completeRef` and nothing behind it. A
    // derived ref with no sidecar reads back as no `complete` at all, so the
    // door has nothing to offer rather than an address nothing answers to.
    const store = new InMemoryPromptStore();
    const source = makeHarness(store);
    await source.ready;
    await source.register({ declaration: referencePrompt() });
    await source.register({
      declaration: definePrompt({
        name: "byref",
        description: "…",
        arguments: [{ name: "job", complete: "knowify.jobs" }],
        render: () => "…",
      }),
    });
    await source.close();

    const h = makeHarness(store, hydrateFromStore());
    await h.ready;
    await h.hydrate();

    expect(await h.complete({ name: NAME, argument: { name: "job", value: "Mil" } })).toEqual({
      kind: "unavailable",
    });
    // A NAMED ref survives — it was always just a string on the record.
    expect(await h.complete({ name: "byref", argument: { name: "job", value: "" } })).toEqual({
      kind: "ref",
      completeRef: "knowify.jobs",
    });
    await h.close();
  });
});

describe("PromptsHarness.complete — failures", () => {
  it("throws PromptNotFound for an unknown prompt", async () => {
    const h = makeHarness();
    await h.ready;

    await expect(
      h.complete({ name: "no-such-prompt", argument: { name: "job", value: "" } }),
    ).rejects.toBeInstanceOf(PromptNotFound);
    await h.close();
  });

  it("wraps a throwing resolver in CompletionResolveFailed with its cause and address", async () => {
    const boom = new Error("upstream 503");
    const h = makeHarness();
    await h.ready;
    await h.register({
      declaration: definePrompt({
        name: "fails",
        description: "…",
        arguments: [
          {
            name: "job",
            complete: () => {
              throw boom;
            },
          },
        ],
        render: () => "…",
      }),
    });

    await expect(
      h.complete({ name: "fails", argument: { name: "job", value: "" } }),
    ).rejects.toMatchObject({
      _tag: "CompletionResolveFailed",
      // The DERIVED address of the inline resolver — the ref a caller could look up.
      completionName: promptCompletionRef("fails", "job"),
      cause: boom,
    });
    await expect(
      h.complete({ name: "fails", argument: { name: "job", value: "" } }),
    ).rejects.toBeInstanceOf(CompletionResolveFailed);
    await h.close();
  });
});

describe("PromptsHarness.complete — a keystroke is not an event", () => {
  it("writes nothing to the journal across a whole typed word", async () => {
    const journal = new MemoryJournal({ capacity: 1024 });
    const h = new PromptsHarness(
      `complete:${generateId()}`,
      journal,
      new LocalEventBus(),
      new LocalInbox(),
      { store: new InMemoryPromptStore(), parentScope: { sessionId: "sess-quiet" } },
    );
    await h.ready;
    await h.register({ declaration: referencePrompt() });

    const baseline = journal.totalAppended(); // the register op DOES journal
    for (const typed of ["M", "Mi", "Mil", "Mill"]) {
      await h.complete({ name: NAME, argument: { name: "job", value: typed } });
    }

    expect(journal.totalAppended()).toBe(baseline);
    await h.close();
  });
});

describe("foldCompletionValues — pinned against the canonical fold", () => {
  it("agrees with `normalizeCompletionResult` on both shapes", () => {
    // The three-line local copy exists so prompts does not runtime-import the
    // completions package (see `../completion.ts`). This is the test that keeps
    // the copy honest.
    for (const raw of [
      ["a", "b"],
      [],
      { values: ["a"] },
      { values: ["a"], total: 9, hasMore: true },
    ] as const) {
      expect(foldCompletionValues(raw)).toEqual(normalizeCompletionResult(raw));
    }
  });
});
