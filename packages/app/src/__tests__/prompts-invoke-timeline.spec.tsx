/**
 * `session.prompts.invoke()` puts its rendered entries in the SESSION's
 * timeline — through real `createApp` wiring, not an injected double (#257).
 *
 * The missing test class. The prompts harness specs inject a
 * `TimelineAppendCapability` double at construction, so they proved the append
 * body and nothing about the wiring; the wiring was broken for every default
 * deployment. `withPrompts` read the timeline out of the installer's namespace
 * map at INSTALL time, where a session's host-constructed bridges structurally
 * cannot be yet — the session is built after its extensions install. The harness
 * held `undefined`, `applyInvoke` took its silent skip branch, and an invoked
 * prompt rendered into nothing. Only a test that goes through `createApp` sees
 * it, which is why this file lives here rather than in `@agentick/prompts`.
 *
 * Pins:
 *  - default flow (`createApp({ prompts })`) — invoke lands in
 *    `session.timeline`, stamped with `metadata.source.prompt`
 *  - `withTimeline(instance)` — the adopter's timeline is the one that
 *    receives them, and its install-time name claim is not overwritten
 *
 * @see packages/app/src/harness.ts (the guarded post-construction publish)
 * @see packages/prompts/src/harness.ts (`TimelineAppendSource`)
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { MessageEntry, MessageSource, TimelineEntry } from "@agentick/spec";
import { definePrompts, hydrateFrom, type PromptMessageSource } from "@agentick/prompts";
import { TimelineHarness, withTimeline } from "@agentick/timeline";

import { createApp } from "../react.js";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "prompt host");

// A `render` prompt rather than a `template` one: templates are passed to the
// renderer verbatim (the harness interpolates nothing), so only `render` proves
// the ARGS reached the entries that landed in the timeline.
const greeting = {
  declaration: {
    name: "greet",
    description: "Greet somebody by name.",
    version: "2026-07-30",
    render: (args: Readonly<Record<string, unknown>>): readonly MessageEntry[] => [
      {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: `Hello, ${String(args.name)}.` }],
      },
    ],
  },
};

/** The documented reader path: cast `metadata.source` to `MessageSource`, then key. */
function promptSourceOf(entry: TimelineEntry): PromptMessageSource | undefined {
  if (entry.kind !== "message") return undefined;
  return (entry.message.metadata?.source as MessageSource | undefined)?.prompt;
}

function textOf(entry: TimelineEntry): string {
  if (entry.kind !== "message") return "";
  return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("prompts.invoke → session timeline (#257)", () => {
  it("the default createApp flow appends the rendered entries to the session timeline", async () => {
    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({ hydrate: hydrateFrom([greeting]) }),
    });
    const session = await app.createSession({ sessionId: "s-invoke-default" });

    const before = session.timeline.read().entries.length;
    const result = await session.prompts!.invoke({ name: "greet", args: { name: "Ada" } });
    expect(result.messages).toHaveLength(1);

    const appended = session.timeline.read().entries.slice(before);
    expect(appended).toHaveLength(1);
    expect(textOf(appended[0]!)).toBe("Hello, Ada.");

    // The provenance stamp rode the same dead branch — it is only observable
    // once the append actually happens.
    const source = promptSourceOf(appended[0]!);
    expect(source?.name).toBe("greet");
    expect(source?.args).toEqual({ name: "Ada" });
    expect(source?.version).toBe("2026-07-30");
    expect(typeof source?.opId).toBe("string");

    await session.close();
    await app.close();
  });

  it("a second invoke keeps appending — the resolved timeline is not a one-shot", async () => {
    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({ hydrate: hydrateFrom([greeting]) }),
    });
    const session = await app.createSession({ sessionId: "s-invoke-twice" });

    const before = session.timeline.read().entries.length;
    await session.prompts!.invoke({ name: "greet", args: { name: "Ada" } });
    await session.prompts!.invoke({ name: "greet", args: { name: "Grace" } });

    const appended = session.timeline.read().entries.slice(before);
    expect(appended.map(textOf)).toEqual(["Hello, Ada.", "Hello, Grace."]);

    await session.close();
    await app.close();
  });

  it("an adopter's withTimeline(instance) keeps the name claim AND receives the entries", async () => {
    // The adopter owns this harness's lifecycle — construction, genesis, close.
    const adopterTimeline = new TimelineHarness(
      "adopter:timeline",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await adopterTimeline.ready;

    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({ hydrate: hydrateFrom([greeting]) }),
      extensions: [withTimeline(adopterTimeline)],
    });
    const session = await app.createSession({ sessionId: "s-invoke-adopter-timeline" });

    // The install-time claim wins: the session's own timeline IS the adopter's
    // instance, and the host's post-construction publish did not displace it.
    expect(session.timeline).toBe(adopterTimeline);

    const before = adopterTimeline.read().entries.length;
    await session.prompts!.invoke({ name: "greet", args: { name: "Ada" } });

    const appended = adopterTimeline.read().entries.slice(before);
    expect(appended).toHaveLength(1);
    expect(textOf(appended[0]!)).toBe("Hello, Ada.");
    expect(promptSourceOf(appended[0]!)?.name).toBe("greet");

    await session.close();
    await app.close();
    await adopterTimeline.close();
  });
});
