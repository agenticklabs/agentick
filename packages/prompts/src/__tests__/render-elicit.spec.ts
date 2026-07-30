/**
 * A prompt's `render` can ASK — `ctx.elicit` on the render ctx (v1 parity).
 *
 * A prompt is invoked by a person, and the arguments they supplied are often not
 * the arguments the prompt needs: `/quoting_report` with no period, `/summarize`
 * pointed at an ambiguous name. v1's MCP prompts could elicit the missing piece
 * mid-render; v2's `render(args, ctx)` had no way to ask at all, so a
 * declaration's only options were to fail or to guess.
 *
 * The facet is OPTIONAL, and that is the load-bearing half: a declaration called
 * directly (a unit test, a doc generator) gets no ctx, and a harness with no
 * elicit source wired gets no `elicit`. Both must land on the declaration's
 * no-elicit branch rather than crashing or hanging.
 *
 * Pins:
 *  - a directly-injected `Elicit` reaches `render(args, ctx)`, and the elicited
 *    value is in the rendered messages — through `invoke()` AND through
 *    `render()`, because it is one seam and a prompt that asks must not care
 *    which door was used
 *  - the provider arm follows the {@link TimelineAppendSource} discipline: a miss
 *    is re-read, a hit is cached
 *  - no source wired ⇒ `ctx.elicit` is `undefined`, and the fallback branch runs
 *  - a ctx-free `decl.render(args)` call does not crash
 *  - an elicit published by the enclosing CROSSING wins over the session's — the
 *    precedence that keeps a future MCP `prompts/get` asking ITS client
 *
 * @see ./timeline-late-binding.spec.ts — the sibling late-binding contract
 * @see packages/app/src/__tests__/prompts-invoke-elicit.spec.tsx — the same fact
 *   through real `createApp` wiring
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  ulid,
  withBoundaryFacets,
} from "@agentick/runtime";
import type { Elicit, PromptDeclaration, TimelineEntry } from "@agentick/spec";

import { PromptsHarness, type ElicitSource, type TimelineAppendCapability } from "../harness.js";

/**
 * A stand-in {@link Elicit} that answers `text` and records what it was asked.
 * Only the one method is typed and implemented — the rest of the sugar is not
 * what these tests are about, and a call to any of it is a test bug, not a
 * silent pass.
 */
function stubElicit(answer: string, asked: string[]): Elicit {
  const text: Elicit["text"] = async (message) => {
    asked.push(message);
    return answer;
  };
  return { text } as unknown as Elicit;
}

/**
 * The prompt under test: it needs a period, and asks for one when the invoke
 * did not supply it. The `?? "unasked"` arm is the no-elicit branch every
 * declaration must have.
 */
const PERIOD_PROMPT: PromptDeclaration = {
  name: "quoting_report",
  description: "Quoting report for a period",
  arguments: [{ name: "period", description: "YYYY-MM", required: false }],
  render: async (args, ctx) => {
    const period =
      (args.period as string | undefined) ??
      (await ctx?.elicit?.text("Which period?")) ??
      "unasked";
    return `Quoting report for ${period}.`;
  },
};

function captureTimeline(): {
  readonly appended: TimelineEntry[];
  readonly timeline: TimelineAppendCapability;
} {
  const appended: TimelineEntry[] = [];
  return {
    appended,
    timeline: {
      append: async (...entries: TimelineEntry[]): Promise<void> => {
        appended.push(...entries);
      },
    },
  };
}

async function makeHarness(
  elicit?: ElicitSource,
  timeline?: TimelineAppendCapability,
): Promise<PromptsHarness> {
  const id = `elicit:${ulid()}`;
  const h = new PromptsHarness(
    id,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      parentScope: { sessionId: id },
      ...(elicit ? { elicit } : {}),
      ...(timeline ? { timeline } : {}),
    },
  );
  await h.ready;
  await h.register({ declaration: PERIOD_PROMPT });
  return h;
}

/** The rendered text of a result, joined — the messages are all text blocks. */
function renderedText(result: { messages: readonly { content: unknown }[] }): string {
  return JSON.stringify(result.messages);
}

describe("prompts — a render can elicit", () => {
  it("invoke: the declaration asks, and the answer is in the rendered messages", async () => {
    const asked: string[] = [];
    const { appended, timeline } = captureTimeline();
    const h = await makeHarness(stubElicit("2026-01", asked), timeline);

    const result = await h.invoke({ name: "quoting_report" });

    expect(asked).toEqual(["Which period?"]);
    expect(renderedText(result)).toContain("Quoting report for 2026-01.");
    // …and the elicited value is what reached the timeline, not a placeholder.
    expect(JSON.stringify(appended)).toContain("2026-01");
    await h.close();
  });

  it("render: the same facet, through the no-queue door", async () => {
    const asked: string[] = [];
    const h = await makeHarness(stubElicit("2026-02", asked));

    const result = await h.render({ name: "quoting_report" });

    expect(asked).toEqual(["Which period?"]);
    expect(renderedText(result)).toContain("Quoting report for 2026-02.");
    await h.close();
  });

  it("an argument the caller DID supply is never elicited", async () => {
    const asked: string[] = [];
    const h = await makeHarness(stubElicit("2026-03", asked));

    const result = await h.render({ name: "quoting_report", args: { period: "2025-12" } });

    expect(asked).toEqual([]);
    expect(renderedText(result)).toContain("Quoting report for 2025-12.");
    await h.close();
  });

  it("a provider that misses is RE-READ; a hit is cached", async () => {
    const asked: string[] = [];
    let live: Elicit | undefined;
    let reads = 0;
    const h = await makeHarness(() => {
      reads += 1;
      return live;
    });

    // Nothing published yet — the declaration takes its no-elicit branch rather
    // than hanging on an ask nobody can answer.
    const before = await h.render({ name: "quoting_report" });
    expect(renderedText(before)).toContain("unasked");
    expect(reads).toBe(1);

    // …the host publishes it, and the very next render asks.
    live = stubElicit("2026-04", asked);
    const after = await h.render({ name: "quoting_report" });
    expect(renderedText(after)).toContain("2026-04");
    expect(reads).toBe(2);

    // A hit is final: the provider is not consulted again.
    await h.render({ name: "quoting_report" });
    expect(reads).toBe(2);
    expect(asked).toHaveLength(2);
    await h.close();
  });

  it("no elicit source wired ⇒ ctx.elicit is undefined and the fallback renders", async () => {
    const h = await makeHarness();

    const result = await h.render({ name: "quoting_report" });

    expect(renderedText(result)).toContain("unasked");
    await h.close();
  });

  it("a ctx-free call on the declaration itself still works", async () => {
    // What a unit test or a doc generator does: no harness, no ctx, no elicit.
    const content = await PERIOD_PROMPT.render?.({}, undefined);

    expect(content).toBe("Quoting report for unasked.");
  });

  it("an elicit published by the enclosing crossing WINS over the session's", async () => {
    const sessionAsked: string[] = [];
    const crossingAsked: string[] = [];
    const h = await makeHarness(stubElicit("session-answer", sessionAsked));

    // What an MCP `prompts/get` crossing would do: publish its own connection's
    // elicit as a boundary facet, then compose the render on that fiber.
    const result = await Effect.runPromise(
      withBoundaryFacets(
        { elicit: stubElicit("crossing-answer", crossingAsked) },
        h.fx.render({ name: "quoting_report" }),
      ),
    );

    expect(crossingAsked).toEqual(["Which period?"]);
    expect(sessionAsked).toEqual([]);
    expect(renderedText(result)).toContain("crossing-answer");
    await h.close();
  });
});
