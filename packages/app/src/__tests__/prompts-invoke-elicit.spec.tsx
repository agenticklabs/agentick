/**
 * A prompt's `render` reaches the SESSION's elicitation through real
 * `createApp` wiring — `ctx.elicit`, end to end.
 *
 * The harness-level spec injects an `Elicit` double at construction, so it
 * proves the threading and nothing about the wiring — and the wiring is where
 * the equivalent timeline facet was broken for an entire release (#257): the
 * extension installs BEFORE the session exists, so anything host-constructed is
 * structurally invisible at install time. `elicit` rides the same late-binding
 * contract, and only a test that goes through `createApp` can see it hold.
 *
 * Pins:
 *  - a declaration that asks mid-render gets a real ask on
 *    `session.elicitation`, and the answer lands in the entries `invoke`
 *    appends to the timeline
 *  - the ask carries the render's own message (the caller is asked the
 *    question the prompt wrote, not a generic one)
 *  - a declaration that asks for nothing is unaffected — no ask is raised
 *
 * @see packages/app/src/harness.ts (the guarded post-construction publish)
 * @see packages/prompts/src/__tests__/render-elicit.spec.ts (the facet's own rules)
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { definePrompts, hydrateFrom } from "@agentick/prompts";
import type { ElicitationHarness, ElicitationSnapshotFrame } from "@agentick/elicitation";
import type { SessionHarnessProtocol, TimelineEntry } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { createApp } from "../react.js";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "prompt host");

/** Asks for the period it was not given — v1's elicit-during-render, in v2. */
const quotingReport = {
  declaration: {
    name: "quoting_report",
    description: "Quoting report for a period.",
    arguments: [{ name: "period", description: "YYYY-MM", required: false }],
    render: async (
      args: Readonly<Record<string, unknown>>,
      ctx?: { readonly elicit?: { text(message: string): Promise<string> } },
    ): Promise<string> => {
      const period =
        (args.period as string | undefined) ??
        (await ctx?.elicit?.text("Which period?")) ??
        "unasked";
      return `Quoting report for ${period}.`;
    },
  },
};

function textOf(entry: TimelineEntry): string {
  if (entry.kind !== "message") return "";
  return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Answer the one ask outstanding on the session, the way a client does: read the
 * pending request off the elicitation channel's snapshot frame, then `respond`
 * with its correlationId.
 */
async function answerPendingAsk(
  session: SessionHarnessProtocol<unknown>,
  value: string,
): Promise<string> {
  const harness = session.elicitation as ElicitationHarness;
  await waitFor(() => harness.pendingCount() === 1, { description: "an ask to be raised" });
  const frame = (await session.channelSnapshot("elicitation"))?.payload as ElicitationSnapshotFrame;
  const request = frame.requests[0]!;
  await harness.respond({ correlationId: request.correlationId, outcome: "accepted", value });
  return (request.payload as { message: string }).message;
}

describe("prompts.invoke → session elicitation", () => {
  it("the render asks the session's user, and the answer reaches the timeline", async () => {
    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({ hydrate: hydrateFrom([quotingReport]) }),
    });
    const session = await app.createSession({ sessionId: "s-invoke-elicit" });

    const before = session.timeline.read().entries.length;
    // NOT awaited: the invoke is parked on the ask until somebody answers it.
    const invoked = session.prompts!.invoke({ name: "quoting_report" });
    const asked = await answerPendingAsk(session, "2026-01");
    const result = await invoked;

    // The prompt's own question reached the client, verbatim.
    expect(asked).toBe("Which period?");
    expect(JSON.stringify(result.messages)).toContain("Quoting report for 2026-01.");

    const appended = session.timeline.read().entries.slice(before);
    expect(appended).toHaveLength(1);
    expect(textOf(appended[0]!)).toBe("Quoting report for 2026-01.");

    await session.close();
    await app.close();
  });

  it("a prompt given its argument asks nothing", async () => {
    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({ hydrate: hydrateFrom([quotingReport]) }),
    });
    const session = await app.createSession({ sessionId: "s-invoke-no-elicit" });

    const result = await session.prompts!.invoke({
      name: "quoting_report",
      args: { period: "2025-12" },
    });

    expect(JSON.stringify(result.messages)).toContain("Quoting report for 2025-12.");
    expect((session.elicitation as ElicitationHarness).pendingCount()).toBe(0);

    await session.close();
    await app.close();
  });
});
