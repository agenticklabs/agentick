/**
 * Full-stack `completions/complete` round-trip — the client finishing a user's
 * sentence over the real wire (completions.md §7 P2).
 *
 * The unit links are pinned in their own packages: the two-hop routing in
 * `completions/src/__tests__/wire.spec.ts`, the prompts door in
 * `prompts/src/__tests__/complete.spec.ts`, the registry in
 * `completions/src/__tests__/harness.spec.ts`, the per-method journaling fold in
 * `gateway/src/__tests__/wire-journaling.spec.ts`. This closes the loop through
 * the REAL `GatewayHarness` + `inProcessTransport` and — the part no unit can
 * show — through the DERIVED wire proxy: nobody wrote `session.completions.complete`,
 * the `WireMethods` row did.
 *
 * The fixture is the doc's reference prompt, with one argument completing from an
 * INLINE resolver (the sidecar path) and one from a NAMED registry source (the
 * two-hop path), so both halves of the completion split are exercised by the same
 * client call shape.
 *
 * Side-effect imports register the server-side session slots the route reads.
 */

import "@agentick/completions";
import "@agentick/prompts";

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";

import { completeDependent, completeFromList, defineCompletions } from "@agentick/completions";
import { createClient } from "@agentick/client-core";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { hydrateFrom as hydratePromptsFrom, withPrompts } from "@agentick/prompts";
import { withCompletions } from "@agentick/completions";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ContentBlock } from "@agentick/spec";

import { inProcessTransport } from "../index.js";

const PROMPT = "tm_change_order_actual_cost";

/** Every journaled envelope's op name, oldest first. */
async function journalNames(journal: MemoryJournal): Promise<readonly string[]> {
  const events = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({}, "beginning")).pipe(Effect.map(Chunk.toReadonlyArray)),
  );
  return events.map((e) => e.name);
}

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-completions-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  // The gateway takes the SAME journal the assertions read, so the zero-append
  // claim below is measured on the journal the wire dispatch would write to.
  const gateway = await createGateway({ journal });
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "completions-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      extensions: [
        withPrompts({
          hydrate: hydratePromptsFrom([
            {
              declaration: {
                name: PROMPT,
                description: "Log an actual cost against a change order.",
                arguments: [
                  // INLINE — rides the prompts sidecar, resolved in hop 1.
                  {
                    name: "markup_pct",
                    complete: completeFromList(["10", "15", "20", "25", "30"]),
                  },
                  // NAMED — addresses the registry below, resolved in hop 2.
                  { name: "phase", required: true, complete: "knowify.phases" },
                  // Nothing to ask.
                  { name: "memo" },
                ],
                template: "…",
              },
            },
          ]),
        }),
        withCompletions(
          defineCompletions({
            sources: {
              "knowify.phases": completeDependent({ requires: ["job"] }, (value, { job }) =>
                [`${job} — Framing`, `${job} — Framing CO #2`].filter((p) => p.includes(value)),
              ),
            },
          }),
        ),
      ],
    },
  });
  const session = await app.createSession({ sessionId: "completions-session" });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    // The DERIVED proxy — `session.completions.complete(params-minus-sessionId)`,
    // synthesized from the `completions/complete` wire row with no client code.
    completions: client.session(session.id).completions,
    journal,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("completions/complete end-to-end — client ↔ gateway ↔ prompts ↔ registry", () => {
  it("completes from an inline resolver on the prompt (the sidecar path)", async () => {
    const { completions, cleanup } = await makeStack();

    const all = await completions.complete({
      ref: { type: "prompt", name: PROMPT },
      argument: { name: "markup_pct", value: "" },
    });
    const narrowed = await completions.complete({
      ref: { type: "prompt", name: PROMPT },
      argument: { name: "markup_pct", value: "2" },
    });

    expect(all.values).toEqual(["10", "15", "20", "25", "30"]);
    expect(narrowed.values).toEqual(["20", "25"]);

    await cleanup();
  });

  it("completes from a named registry source, conditioned on a sibling argument", async () => {
    const { completions, cleanup } = await makeStack();

    const gated = await completions.complete({
      ref: { type: "prompt", name: PROMPT },
      argument: { name: "phase", value: "Fra" },
    });
    const answered = await completions.complete({
      ref: { type: "prompt", name: PROMPT },
      argument: { name: "phase", value: "CO" },
      context: { arguments: { job: "Miller Residence" } },
    });

    // `completeDependent` gates without invoking its body — `job` is unfilled.
    expect(gated.values).toEqual([]);
    // Filled, and filtered by what was typed.
    expect(answered.values).toEqual(["Miller Residence — Framing CO #2"]);

    await cleanup();
  });

  it("answers empty for an argument with nothing to ask, and for one that does not exist", async () => {
    const { completions, cleanup } = await makeStack();

    expect(
      (
        await completions.complete({
          ref: { type: "prompt", name: PROMPT },
          argument: { name: "memo", value: "x" },
        })
      ).values,
    ).toEqual([]);
    expect(
      (
        await completions.complete({
          ref: { type: "prompt", name: PROMPT },
          argument: { name: "no_such_argument", value: "x" },
        })
      ).values,
    ).toEqual([]);

    await cleanup();
  });

  it("surfaces an unknown prompt as a typed error over the wire", async () => {
    const { completions, cleanup } = await makeStack();

    await expect(
      completions.complete({
        ref: { type: "prompt", name: "no-such-prompt" },
        argument: { name: "phase", value: "" },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("no-such-prompt") });

    await cleanup();
  });

  it("journals nothing of its own across a whole typed word", async () => {
    // The claim the whole design rests on, measured end to end: not at the
    // registry (a plain method), not at the prompts door (a plain method), and
    // not at the gateway's `wire:completions/complete` boundary op (declared
    // `bus-only`). Four keystrokes leave no completion, prompt, or wire envelope
    // in the durable spine.
    const { completions, journal, cleanup } = await makeStack();

    const before = await journalNames(journal);
    for (const typed of ["1", "10", "2", "20"]) {
      await completions.complete({
        ref: { type: "prompt", name: PROMPT },
        argument: { name: "markup_pct", value: typed },
      });
    }
    const added = (await journalNames(journal)).slice(before.length);

    expect(added.filter((n) => n.startsWith("wire:"))).toEqual([]);
    expect(added.filter((n) => n.startsWith("completions:") || n.startsWith("prompts:"))).toEqual(
      [],
    );

    // What DOES land, stated rather than hidden: the gateway's own contextual
    // authorization op, two envelopes per dispatch. That is a security audit
    // record with its own owner and its own hook seam
    // (`onAfterAuthorizerAuthorize`) — every wire method produces it, and
    // exempting authorization audit is not this verb's call to make. A deployment
    // that finds the volume unacceptable overrides
    // `"authorizer:command:authorize"` in its own journaling policy.
    // TODO(authorize-journal-per-method): that override is ALL-OR-NOTHING, and
    // that is the finding. `JournalingPolicy.override` is keyed by event NAME
    // while `GatewayHarness.authorize` mints one name for every method, so
    // silencing this verb's authorization audit silences `session/send`'s too.
    // The discriminator exists but lives in the op's INPUT
    // (`AuthorizeInput.scope` carries the verb label), which policy cannot read —
    // so `WireExtension.journal` cannot be extended to cover it either. Closing
    // it needs a per-op disposition on the `Operation` descriptor plus a
    // SEPARATE declaration key, deliberately not a reuse of `journal`: "my
    // traffic is a query" and "my authorization need not be audited" are
    // different claims with different owners.
    expect(added).toEqual(Array(8).fill("authorizer:command:authorize"));

    await cleanup();
  });
});
